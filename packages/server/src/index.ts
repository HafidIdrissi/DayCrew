import { fileURLToPath } from "node:url";

import {
  ActivityService,
  ConversationError,
  ApprovalService,
  KnowledgeService,
  ManagerOrchestrator,
  MemoryService,
  SkillService,
  TeamService,
  WorkSessionService,
  WorkspaceService,
  isWorkspaceStateError,
  workspaceError,
  WorkspaceStateError,
  installTeamPack,
  assessSkillCompatibility,
  unavailableAssignedSkill,
  requiresHumanApproval,
  type OrchestratorDependencies,
} from "@daycrew/core";
import { ClaudeCodeProvider, CodexProvider, CursorProvider, GeminiProvider, GrokProvider, createAlphaDemoProvider, createMvpMockProvider } from "@daycrew/providers";
import { findEngine, type NeedsYouItem, type ProviderCapabilities, type Team, type TeamMember } from "@daycrew/shared";
import Fastify, { type FastifyRequest } from "fastify";

import { AppConfigError, AppConfigStore } from "./app-config.js";
import { registerConversations } from "./conversations.js";
import { EngineService } from "./engines.js";
import { buildHomeData } from "./home.js";
import { buildTaskDetail, buildTasksData } from "./tasks.js";
import { publicWorkspace, WorkspaceSelection, type WorkspaceContext } from "./workspace-selection.js";

export interface ServerOptions {
  readonly workspaceRoot?: string;
  readonly cwd?: string; // Ignored unless discovery is explicitly enabled.
  readonly discoverWorkspace?: boolean;
  readonly appConfigDir?: string;
  readonly allowedOrigins?: readonly string[];
  readonly orchestration?: OrchestratorDependencies;
}

const requiredText = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
};

const bundledPackPath = (packId: string): string => {
  if (packId !== "software-development") throw new Error("Choose a bundled Team Pack.");
  return fileURLToPath(new URL(`../../../team-packs/${packId}/`, import.meta.url));
};

export const buildServer = (options: ServerOptions = {}) => {
  const server = Fastify({ logger: false });
  const configStore = new AppConfigStore(options.appConfigDir);
  const engineService = new EngineService();
  const selection = new WorkspaceSelection(configStore, {
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    ...(options.discoverWorkspace ? { discoveryStart: options.cwd ?? process.cwd() } : {}),
  });
  const contexts = new WeakMap<FastifyRequest, WorkspaceContext>();
  const context = (request: FastifyRequest): WorkspaceContext => {
    const value = contexts.get(request);
    if (!value) throw new WorkspaceStateError("WORKSPACE_NOT_SELECTED");
    return value;
  };
  const root = (request: FastifyRequest) => context(request).root;
  const sessions = (request: FastifyRequest) => new WorkSessionService(root(request));
  const approvals = (request: FastifyRequest) => new ApprovalService(root(request));
  const orchestrationFor = async (team: Team, workspaceRoot?: string): Promise<OrchestratorDependencies> => {
    if (options.orchestration) return options.orchestration;
    const mock = createMvpMockProvider(team);
    const demo = createAlphaDemoProvider(team);
    const claude = new ClaudeCodeProvider({
      allowWrites: true,
      allowedWorkspaceRoots: workspaceRoot ? [workspaceRoot] : [],
      requiresApproval: (action, risk) => requiresHumanApproval(team.autonomy, action, risk),
    });
    const codex = new CodexProvider();
    const gemini = new GeminiProvider();
    const cursor = new CursorProvider();
    const grok = new GrokProvider();
    return {
      providers: new Map([claude, codex, gemini, cursor, grok, mock, demo].map((provider) => [provider.id, provider])),
      // Auto must never choose a preview or restricted CLI, only the adapter whose
      // approval boundary DayCrew can actually enforce.
      defaultProvider: claude.id,
    };
  };
  const capabilitiesFor = async (request: FastifyRequest, team: Team, member: TeamMember): Promise<ProviderCapabilities> => {
    const dependencies = await orchestrationFor(team, root(request));
    const providerId = member.engine.mode === "manual"
      ? member.engine.provider
      : dependencies.defaultProvider ?? "mock";
    return dependencies.providers.get(providerId ?? "")?.capabilities ?? {
      streaming: false, toolUse: false, approvals: false, interruption: false, resume: false,
      skillCapabilities: [],
    };
  };
  const memberSkills = async (request: FastifyRequest, team: Team, member: TeamMember, tasks: Awaited<ReturnType<WorkSessionService["listTasks"]>>) => {
    const library = new Map((await new SkillService(root(request)).list()).map((skill) => [skill.id, skill]));
    const capabilities = await capabilitiesFor(request, team, member);
    return [
      ...(member.skillIds ?? []).map((skillId) => {
        const skill = library.get(skillId) ?? unavailableAssignedSkill(skillId);
        const compatibility = library.has(skillId) ? assessSkillCompatibility(skill, capabilities) : {
          compatible: false,
          missingCapabilities: [],
          reason: `Assigned Skill "${skillId}" is unavailable.`,
          resolution: "Restore the Workspace Skill files or remove this assignment.",
        };
        return { skill, scope: "permanent" as const, compatibility };
      }),
      ...tasks.flatMap((task) => (task.skillAssignments ?? [])
        .filter((assignment) => assignment.memberId === member.id)
        .flatMap((assignment) => assignment.skillIds.map((skillId) => {
          const skill = library.get(skillId) ?? unavailableAssignedSkill(skillId);
          const compatibility = library.has(skillId) ? assessSkillCompatibility(skill, capabilities) : {
            compatible: false,
            missingCapabilities: [],
            reason: `Assigned Skill "${skillId}" is unavailable.`,
            resolution: "Restore the Workspace Skill files or remove this assignment.",
          };
          return { skill, scope: "temporary" as const, taskId: task.id, compatibility };
        }))),
    ];
  };
  server.addHook("onReady", () => selection.start());

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConversationError) {
      void reply.status(409).send({ error: { code: "CONVERSATION_UNAVAILABLE", message: error.message } });
      return;
    }
    if (error instanceof AppConfigError) {
      void reply.status(503).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (isWorkspaceStateError(error) || typeof (error as NodeJS.ErrnoException).code === "string") {
      const issue = workspaceError(error);
      const status = issue.code === "WORKSPACE_NOT_FOUND" ? 404
        : issue.code === "WORKSPACE_PERMISSION_DENIED" ? 403
        // WORKSPACE_ALREADY_INITIALIZED and the remaining state conflicts share 409.
        : issue.code === "WORKSPACE_PATH_INVALID" ? 400 : 409;
      void reply.status(status).send({ error: { code: issue.code, message: issue.message } });
      return;
    }
    // Never send provider exceptions, schema dumps or OS paths to normal components.
    void reply.status(400).send({ error: { code: "REQUEST_INVALID", message: "DayCrew could not complete this request. Check the supplied values and try again." } });
  });

  server.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    // Local API: defend browser-to-local requests and DNS rebinding. No accounts needed.
    const hostname = new URL(`http://${request.headers.host ?? "localhost"}`).hostname;
    const local = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
    const origin = request.headers.origin;
    const origins = options.allowedOrigins ?? ["http://localhost:5173", "http://127.0.0.1:5173"];
    if (!local(hostname) || request.headers["sec-fetch-site"] === "cross-site" ||
      (origin !== undefined && origin !== `http://${request.headers.host}` && !origins.includes(origin))) {
      return reply.status(403).send({ error: { code: "LOCAL_REQUEST_REQUIRED", message: "Open DayCrew from its local application address." } });
    }
  });

  server.addHook("preHandler", async (request) => {
    const route = request.routeOptions.url;
    if (!route?.startsWith("/api/") || route === "/api/app" || route.startsWith("/api/app/") ||
      (route === "/api/workspace" && request.method === "POST")) return;
    const expected = request.headers["x-daycrew-workspace"];
    if (Array.isArray(expected)) throw new WorkspaceStateError("WORKSPACE_CHANGED");
    contexts.set(request, await selection.context(expected));
  });
  server.addHook("onSend", async (request, reply, payload) => {
    const snapshot = contexts.get(request);
    if (snapshot && snapshot.selectionId !== selection.selectionId) {
      reply.code(409);
      return JSON.stringify({ error: { code: "WORKSPACE_CHANGED", message: "The open Workspace changed. Reload to continue." } });
    }
    return payload;
  });

  server.get("/health", async () => ({ name: "daycrew", status: "ok", milestone: "M3" }));
  server.get("/api/app", () => selection.app());
  // Filesystem paths are only returned to the dedicated picker, never Team components.
  server.get("/api/app/workspaces", async () => selection.recents());
  server.post<{ Body: { root?: unknown } }>("/api/app/workspace/open", (request) =>
    selection.select(requiredText(request.body?.root, "Workspace path")),
  );
  server.post<{ Body: { root?: unknown; name?: unknown } }>("/api/app/workspace/create", (request) =>
    selection.select(requiredText(request.body?.root, "Workspace path"), requiredText(request.body?.name, "Workspace name")),
  );
  // Compatibility for CLI/API clients that supplied an explicit root at startup.
  server.post<{ Body: { root?: unknown; name?: unknown } }>("/api/workspace", async (request) => {
    await selection.select(request.body?.root === undefined ? undefined : requiredText(request.body.root, "Workspace path"), requiredText(request.body?.name, "Workspace name"));
    return publicWorkspace((await selection.context()).workspace);
  });
  server.get("/api/workspace", async (request) => publicWorkspace(context(request).workspace));
  server.patch<{ Body: { name?: unknown } }>("/api/workspace", async (request) =>
    publicWorkspace(await new WorkspaceService(root(request)).updateName(requiredText(request.body?.name, "Workspace name"))),
  );

  server.get<{ Querystring: { teamId?: string } }>("/api/teams/dashboard", async (request) => {
    const teams = await new TeamService(root(request)).list();
    const team = teams.find((item) => item.id === request.query.teamId) ?? teams[0];
    if (!team) return null;
    const work = (await sessions(request).list()).filter((item) => item.teamId === team.id);
    const tasks = (await Promise.all(work.map(async (item) =>
      (await sessions(request).listTasks(item.id)).map((task) => ({ ...task, teamId: team.id })),
    ))).flat();
    return {
      workspace: publicWorkspace(context(request).workspace), teams, team, tasks, sessions: work,
      skills: await new SkillService(root(request)).list(),
      memberSkills: await Promise.all(team.members.map(async (member) => {
        const capabilities = await capabilitiesFor(request, team, member);
        return {
          memberId: member.id,
          assignments: await memberSkills(request, team, member, tasks),
          availability: (await new SkillService(root(request)).list()).map((skill) => ({
            skill,
            compatibility: assessSkillCompatibility(skill, capabilities),
          })),
        };
      })),
      knowledge: await new KnowledgeService(root(request)).list(team.id),
      needsYou: (await sessions(request).listNeedsYou("pending")).filter((item) => item.teamId === team.id),
      activity: (await new ActivityService(root(request)).list()).filter((item) => item.teamId === team.id),
    };
  });

  server.get("/api/teams", async (request) => new TeamService(root(request)).list());
  server.get("/api/home", async (request) => buildHomeData(root(request)));
  server.get("/api/skills", async (request) => new SkillService(root(request)).list());
  server.get<{
    Params: { teamId: string; memberId: string };
  }>("/api/teams/:teamId/members/:memberId/skills", async (request) => {
    const team = await new TeamService(root(request)).load(request.params.teamId);
    const member = team.members.find((candidate) => candidate.id === request.params.memberId);
    if (!member) throw new Error("Team Member was not found");
    const sessionsForTeam = (await sessions(request).list()).filter((session) => session.teamId === team.id);
    const tasks = (await Promise.all(sessionsForTeam.map((session) => sessions(request).listTasks(session.id)))).flat();
    return memberSkills(request, team, member, tasks);
  });
  server.post<{
    Params: { teamId: string; memberId: string };
    Body: { skillId?: unknown };
  }>("/api/teams/:teamId/members/:memberId/skills", async (request) =>
    new SkillService(root(request)).addPermanent(
      request.params.teamId,
      request.params.memberId,
      requiredText(request.body?.skillId, "Skill id"),
    ),
  );

  server.get("/api/settings", async (request) => {
    const config = await configStore.load();
    const workspace = publicWorkspace(context(request).workspace);
    const skills = await new SkillService(root(request)).list();
    return {
      workspace,
      needsYouCount: (await sessions(request).listNeedsYou("pending")).length,
      recentWorkspaces: config.recentWorkspaces,
      preferences: { defaultAutonomy: config.defaultAutonomy ?? "work-with-approval" },
      // Driven by the shared registry so a new engine reaches Settings without an edit here.
      engines: (await engineService.list()).filter((engine) => engine.kind !== "simulated"),
      extensions: { skills: skills.length, teamPacks: [{ id: "software-development", name: "Software Development" }] },
      diagnostics: {
        version: "0.1.0-alpha.0",
        stateDirectory: ".daycrew",
        persistence: "Local JSON",
        api: "Local Fastify API",
      },
    };
  });
  server.patch<{ Body: { defaultAutonomy?: unknown } }>("/api/settings/autonomy", async (request) => {
    const value = request.body?.defaultAutonomy;
    if (value !== "assist" && value !== "work-with-approval" && value !== "autonomous") {
      throw new Error("Choose a supported autonomy mode");
    }
    const config = await configStore.update({ defaultAutonomy: value });
    return { defaultAutonomy: config.defaultAutonomy };
  });
  server.post("/api/settings/engines/detect", () => {
    // A fresh sign-in can change which models a CLI offers, so drop cached catalogues.
    engineService.forget();
    return engineService.detect();
  });

  // The engine registry: which CLI engines exist, how to install and sign in to
  // each one, and which models it accepts. It never carries a credential.
  server.get("/api/engines", () => engineService.list());
  server.get<{ Params: { engineId: string } }>("/api/engines/:engineId/models", (request) => {
    if (!findEngine(request.params.engineId)) throw new Error("Unknown AI Engine");
    return engineService.models(request.params.engineId);
  });
  server.get("/api/office", async (request) => {
    const teams = await new TeamService(root(request)).list();
    const allSessions = await sessions(request).list();
    const pending = await sessions(request).listNeedsYou("pending");
    return {
      workspace: publicWorkspace(context(request).workspace),
      needsYouCount: pending.length,
      teams: await Promise.all(teams.map(async (team) => {
        const teamSessions = allSessions.filter((session) => session.teamId === team.id)
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
        const latest = teamSessions[0];
        const tasks = latest ? await sessions(request).listTasks(latest.id) : [];
        return {
          id: team.id,
          name: team.name,
          autonomy: team.autonomy,
          demoMode: team.members.some((member) => member.engine.mode === "manual" && member.engine.provider === "demo"),
          goal: latest?.goal,
          sessionId: latest?.id,
          sessionStatus: latest?.status,
          members: team.members.map((member) => {
            const runtime = latest?.members.find((item) => item.memberId === member.id);
            const task = runtime?.currentTaskId ? tasks.find((item) => item.id === runtime.currentTaskId) : undefined;
            return {
              id: member.id, name: member.name, role: member.role, isManager: member.isManager,
              status: runtime?.status ?? "idle", currentTask: task?.title,
              ...(task ? { currentTaskId: task.id } : {}),
              engine: member.engine,
              skillCount: (member.skillIds ?? []).length,
              needsYouCount: pending.filter((item) => item.teamId === team.id && item.memberId === member.id).length,
              ...(runtime?.lastActiveAt ? { lastActiveAt: runtime.lastActiveAt } : {}),
            };
          }),
        };
      })),
    };
  });
  server.delete<{
    Params: { teamId: string; memberId: string; skillId: string };
  }>("/api/teams/:teamId/members/:memberId/skills/:skillId", async (request) =>
    new SkillService(root(request)).removePermanent(request.params.teamId, request.params.memberId, request.params.skillId),
  );
  server.post<{
    Params: { taskId: string; memberId: string };
    Body: { skillId?: unknown; sessionId?: string };
  }>("/api/tasks/:taskId/members/:memberId/skills", async (request) =>
    new SkillService(root(request)).addTemporary(
      request.params.taskId,
      request.params.memberId,
      requiredText(request.body?.skillId, "Skill id"),
      request.body?.sessionId,
    ),
  );
  server.delete<{
    Params: { taskId: string; memberId: string; skillId: string };
    Querystring: { sessionId?: string };
  }>("/api/tasks/:taskId/members/:memberId/skills/:skillId", async (request) =>
    new SkillService(root(request)).removeTemporary(request.params.taskId, request.params.memberId, request.params.skillId, request.query.sessionId),
  );
  server.get<{
    Params: { teamId: string; memberId: string };
    Querystring: { taskId?: string; sessionId?: string };
  }>("/api/teams/:teamId/members/:memberId/skill-recommendations", async (request) => {
    const team = await new TeamService(root(request)).load(request.params.teamId);
    const member = team.members.find((candidate) => candidate.id === request.params.memberId);
    if (!member) throw new Error("Team Member was not found");
    const skills = new SkillService(root(request));
    const foundTask = request.query.taskId
      ? await skills.findTask(request.query.taskId, request.query.sessionId)
      : undefined;
    if (foundTask && foundTask.teamId !== team.id) throw new Error("Task does not belong to this Team");
    const task = foundTask?.task;
    return skills.recommend(team.id, member.id, await capabilitiesFor(request, team, member), task);
  });
  server.post<{
    Body: {
      name?: unknown;
      description?: string;
      autonomy?: "assist" | "work-with-approval" | "autonomous";
      members?: TeamMember[];
    };
  }>("/api/teams", async (request) => {
    if (!Array.isArray(request.body?.members)) throw new Error("Team members are required");
    const defaultAutonomy = (await configStore.load()).defaultAutonomy ?? "work-with-approval";
    return new TeamService(root(request)).create({
      name: requiredText(request.body.name, "Team name"),
      members: request.body.members,
      ...(request.body.description === undefined ? {} : { description: request.body.description }),
      autonomy: request.body.autonomy ?? defaultAutonomy,
    });
  });
  server.post<{ Body: { packId?: unknown } }>("/api/teams/install", async (request) => {
    const packId = requiredText(request.body?.packId, "Team Pack id");
    return installTeamPack(root(request), bundledPackPath(packId));
  });
  server.get<{ Params: { teamId: string } }>("/api/teams/:teamId", async (request) => {
    const team = await new TeamService(root(request)).load(request.params.teamId);
    return { team, knowledge: await new KnowledgeService(root(request)).list(team.id) };
  });
  server.post<{
    Params: { teamId: string };
    Body: { title?: unknown; content?: unknown; source?: string };
  }>("/api/teams/:teamId/knowledge", async (request) =>
    new KnowledgeService(root(request)).add(
      request.params.teamId,
      requiredText(request.body?.title, "Knowledge title"),
      requiredText(request.body?.content, "Knowledge content"),
      request.body?.source,
    ),
  );
  server.get<{ Params: { teamId: string; memberId: string } }>(
    "/api/teams/:teamId/members/:memberId/memory",
    async (request) => new MemoryService(root(request)).load(request.params.teamId, request.params.memberId),
  );
  server.post<{
    Params: { teamId: string; memberId: string };
    Body: { note?: unknown };
  }>("/api/teams/:teamId/members/:memberId/memory", async (request) =>
    new MemoryService(root(request)).remember(
      request.params.teamId,
      request.params.memberId,
      requiredText(request.body?.note, "Memory note"),
    ),
  );

  server.get("/api/work", async (request) => sessions(request).list());
  server.post<{ Params: { teamId: string }; Body: { goal?: unknown } }>(
    "/api/teams/:teamId/goals",
    async (request) => {
      const team = await new TeamService(root(request)).load(request.params.teamId);
      const dependencies = await orchestrationFor(team, root(request));
      return new ManagerOrchestrator(root(request), dependencies).runGoal(
        team.id,
        requiredText(request.body?.goal, "Goal"),
      );
    },
  );
  server.get<{ Params: { sessionId: string } }>("/api/work/:sessionId", async (request) => ({
    session: await sessions(request).load(request.params.sessionId),
    tasks: await sessions(request).listTasks(request.params.sessionId),
    messages: await sessions(request).listMessages(request.params.sessionId),
    activity: await new ActivityService(root(request)).list(request.params.sessionId),
  }));
  server.post<{ Params: { sessionId: string }; Body: { reason?: string } }>(
    "/api/work/:sessionId/pause",
    async (request) => sessions(request).pause(request.params.sessionId, request.body?.reason),
  );
  server.post<{ Params: { sessionId: string } }>(
    "/api/work/:sessionId/resume",
    async (request) => sessions(request).resume(request.params.sessionId),
  );
  server.post<{ Params: { sessionId: string }; Body: { actorId?: string } }>(
    "/api/work/:sessionId/cancel",
    async (request) => approvals(request).cancelSession(request.params.sessionId, request.body?.actorId),
  );

  server.get("/api/tasks", async (request) => {
    const work = await sessions(request).list();
    const tasks = await Promise.all(
      work.map(async (session) =>
        (await sessions(request).listTasks(session.id)).map((task) => ({ ...task, teamId: session.teamId })),
      ),
    );
    return tasks.flat();
  });
  server.get("/api/tasks/dashboard", async (request) => buildTasksData(root(request)));
  server.get<{ Params: { sessionId: string; taskId: string } }>(
    "/api/tasks/:sessionId/:taskId",
    async (request) => buildTaskDetail(root(request), request.params.sessionId, request.params.taskId),
  );
  server.get<{ Querystring: { status?: NeedsYouItem["status"] } }>(
    "/api/needs-you",
    async (request) => sessions(request).listNeedsYou(request.query.status),
  );
  server.post<{
    Params: { itemId: string };
    Body: { resolution?: NeedsYouItem["resolution"]; feedback?: string; actorId?: string };
  }>("/api/needs-you/:itemId/resolve", async (request) => {
    if (!request.body?.resolution) throw new Error("Resolution is required");
    if (request.body.resolution === "approved" || request.body.resolution === "denied") {
      const item = (await sessions(request).listNeedsYou()).find(
        (candidate) => candidate.id === request.params.itemId,
      );
      if (item?.approvalId) {
        return approvals(request).decideNeedsYou(
          request.params.itemId,
          request.body.resolution,
          request.body.feedback,
          { type: "human", id: request.body.actorId ?? "local-api" },
        );
      }
    }
    return sessions(request).resolveNeedsYou(
      request.params.itemId,
      request.body.resolution,
      request.body.feedback,
    );
  });
  server.get<{ Querystring: { sessionId?: string } }>("/api/approvals", async (request) =>
    approvals(request).list(request.query.sessionId),
  );
  server.get<{ Querystring: { sessionId?: string } }>("/api/activity", async (request) =>
    new ActivityService(root(request)).list(request.query.sessionId),
  );

  registerConversations(server, root, engineService, options.orchestration);
  return server;
};
