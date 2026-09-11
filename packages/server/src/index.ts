import { fileURLToPath } from "node:url";

import {
  ActivityService,
  ApprovalService,
  KnowledgeService,
  ManagerOrchestrator,
  MemoryService,
  TeamService,
  WorkSessionService,
  WorkspaceService,
  isWorkspaceStateError,
  workspaceError,
  WorkspaceStateError,
  installTeamPack,
  type OrchestratorDependencies,
} from "@daycrew/core";
import { createMvpMockProvider } from "@daycrew/providers";
import type { NeedsYouItem, TeamMember } from "@daycrew/shared";
import Fastify, { type FastifyRequest } from "fastify";

import { AppConfigError, AppConfigStore } from "./app-config.js";
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
  const selection = new WorkspaceSelection(new AppConfigStore(options.appConfigDir), {
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
  server.addHook("onReady", () => selection.start());

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppConfigError) {
      void reply.status(503).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (isWorkspaceStateError(error) || typeof (error as NodeJS.ErrnoException).code === "string") {
      const issue = workspaceError(error);
      const status = issue.code === "WORKSPACE_NOT_FOUND" ? 404
        : issue.code === "WORKSPACE_PERMISSION_DENIED" ? 403
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
      knowledge: await new KnowledgeService(root(request)).list(team.id),
      needsYou: (await sessions(request).listNeedsYou("pending")).filter((item) => item.teamId === team.id),
      activity: (await new ActivityService(root(request)).list()).filter((item) => item.teamId === team.id),
    };
  });

  server.get("/api/teams", async (request) => new TeamService(root(request)).list());
  server.post<{
    Body: {
      name?: unknown;
      description?: string;
      autonomy?: "assist" | "work-with-approval" | "autonomous";
      members?: TeamMember[];
    };
  }>("/api/teams", async (request) => {
    if (!Array.isArray(request.body?.members)) throw new Error("Team members are required");
    return new TeamService(root(request)).create({
      name: requiredText(request.body.name, "Team name"),
      members: request.body.members,
      ...(request.body.description === undefined ? {} : { description: request.body.description }),
      ...(request.body.autonomy === undefined ? {} : { autonomy: request.body.autonomy }),
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
      const provider = createMvpMockProvider(team);
      const dependencies = options.orchestration ?? { providers: new Map([[provider.id, provider]]) };
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

  return server;
};
