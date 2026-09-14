import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConversationError, ConversationService, TeamService, WorkSessionService, requiresHumanApproval, type OrchestratorDependencies } from "@daycrew/core";
import { ClaudeCodeProvider, CodexProvider, CursorProvider, GeminiProvider, GrokProvider, MockProvider } from "@daycrew/providers";
import { TeamMemberSchema, ChatMemberInputSchema, ChatSendInputSchema, findEngine, validateEngineModel } from "@daycrew/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { EngineService } from "./engines.js";
type Params = { teamId: string; id: string };

export const registerConversations = (server: FastifyInstance, root: (r: FastifyRequest) => string, engines: EngineService, dependencies?: OrchestratorDependencies) => {
  const services = new Map<string, ConversationService>();
  const service = (r: FastifyRequest) => {
    const dir = root(r);
    let item = services.get(dir);
    if (!item) { item = new ConversationService(dir); services.set(dir, item); }
    return item;
  };
  const mutations = new Map<string, Promise<unknown>>();
  server.addHook("onClose", async () => { await Promise.all([...services.values()].map((s) => s.close())); });
  const updateMember = async (request: FastifyRequest<{ Params: { teamId: string; memberId?: string } }>, creating: boolean) => {
    const input = ChatMemberInputSchema.parse(request.body);
    // Auto stays pinned to the one engine whose safety boundary is enforceable.
    const engine = findEngine(input.engine.mode === "auto" ? "claude-code" : input.engine.provider);
    if (!engine) throw new ConversationError("Choose one of the available AI Engines.");
    if (input.engine.mode === "auto" && input.engine.model !== undefined) {
      throw new ConversationError("Auto uses the engine default model. Switch to a manual engine to choose one.");
    }
    if (input.engine.model !== undefined) {
      // Validate against the live catalogue when one is readable, so a typo in a
      // listed engine is caught before the first turn fails.
      const catalog = await engines.models(engine.id).catch(() => undefined);
      const verdict = validateEngineModel(engine, input.engine.model, catalog?.source === "live" ? catalog.models : undefined);
      if (!verdict.ok) throw new ConversationError(verdict.message);
    }
    const dir = root(request);
    const key = `${dir}:${request.params.teamId}`;
    const operation = (mutations.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (service(request).isBusy(request.params.teamId) || (await new WorkSessionService(dir).list()).some((s) => s.teamId === request.params.teamId && ["created", "planning", "working", "review", "waiting-for-human", "waiting-for-you"].includes(s.status))) {
        throw new ConversationError("Finish or stop the Team's active work before changing an agent.");
      }
      const teams = new TeamService(dir);
      const team = await teams.load(request.params.teamId);
      if (creating) {
        if (team.members.length >= 24) throw new ConversationError("A Team can contain up to 24 agents.");
        team.members.push(TeamMemberSchema.parse({ ...input, id: `member-${randomUUID()}`, isManager: false }));
      } else {
        const member = team.members.find((m) => m.id === request.params.memberId);
        if (!member) throw new ConversationError("This agent does not belong to the Team.");
        Object.assign(member, input);
      }
      return teams.update(team.id, { members: team.members });
    });
    mutations.set(key, operation);
    try { return await operation; } finally { if (mutations.get(key) === operation) mutations.delete(key); }
  };
  server.post<{ Params: { teamId: string } }>("/api/teams/:teamId/members", (r) => updateMember(r, true));
  server.patch<{ Params: { teamId: string; memberId: string } }>("/api/teams/:teamId/members/:memberId", (r) => updateMember(r, false));
  server.get<{ Params: Params }>("/api/teams/:teamId/conversations/:id", (r) => service(r).load(r.params.teamId, r.params.id));
  server.post<{ Params: Params }>("/api/teams/:teamId/conversations/:id/messages", async (r) => {
    const input = ChatSendInputSchema.parse(r.body);
    const dir = root(r);
    const team = await new TeamService(dir).load(r.params.teamId);
    return service(r).send(team.id, r.params.id, input.text, input.targetId, async (providerId) => {
      const supplied = dependencies?.providers.get(providerId);
      if (supplied) return { provider: supplied, workspacePath: dir };
      if (providerId === "demo") return { provider: new MockProvider({ id: "demo", displayName: "Demo Mode", script: [[{ type: "text", text: "Demo Mode — this reply is simulated. Your message and this conversation are saved locally. Configure a real AI Engine to get an AI response." }, { type: "done" }]] }), workspacePath: dir };
      if (providerId === "claude-code") return { provider: new ClaudeCodeProvider({ allowWrites: true, allowedWorkspaceRoots: [dir], requiresApproval: (action, risk) => requiresHumanApproval(team.autonomy, action, risk) }), workspacePath: dir };
      if (providerId !== "codex" && providerId !== "gemini" && providerId !== "cursor" && providerId !== "grok") {
        throw new ConversationError("This AI Engine is not configured.");
      }
      if (!input.allowIsolatedPreview) throw new ConversationError("This engine requires explicit preview consent. Project files are not copied, but the engine may access files outside its temporary folder and cannot provide reliable approval controls.");
      const disposable = await mkdtemp(path.join(tmpdir(), "daycrew-chat-preview-"));
      return { workspacePath: disposable,
        provider: providerId === "codex"
          ? new CodexProvider({ allowUnconfinedReads: true, allowedWorkspaceRoots: [disposable] })
          : providerId === "cursor"
            ? new CursorProvider({ allowUnconfinedReads: true, allowedWorkspaceRoots: [disposable] })
            : providerId === "grok"
              ? new GrokProvider({ allowUnconfinedReads: true, allowedWorkspaceRoots: [disposable] })
              : new GeminiProvider({ allowUnsafeDisposableWorkspace: true, allowedWorkspaceRoots: [disposable] }),
        cleanup: () => rm(disposable, { recursive: true, force: true }),
      };
    });
  });
  server.post<{ Params: Params }>("/api/teams/:teamId/conversations/:id/stop", async (r) => {
    await service(r).stop(r.params.teamId, r.params.id);
    return { stopped: true };
  });
};
