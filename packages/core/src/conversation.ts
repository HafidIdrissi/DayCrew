import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { ConversationSchema, IdSchema, type AgentHandle, type ChatMessage, type Conversation, type ProviderAdapter } from "@daycrew/shared";
import { ApprovalService } from "./approval.js";
import { WorkSessionService } from "./session.js";
import { SkillService } from "./skill.js";
import { readJson, statePath, writeJson } from "./storage.js";
import { TeamService } from "./workspace.js";

export class ConversationError extends Error {}
type RunningTurn = { stopped: boolean; handle?: AgentHandle; sessionId?: string; done?: Promise<void> };
export type ChatEngine = { provider: ProviderAdapter; workspacePath: string; cleanup?: () => Promise<void> };

const GENERIC_ENGINE_FAILURE =
  "The AI Engine could not finish this reply. Check Settings or send another message. Partial output may be incomplete.";

/**
 * Readiness cannot see an engine's account limits, so a signed-in CLI can still refuse
 * every turn. Only conditions the person can act on are recognized, and always as
 * DayCrew's own sentence: the provider's raw diagnostic never reaches the chat.
 */
export const engineFailureNotice = (message: string | undefined): string => {
  if (message === undefined) return GENERIC_ENGINE_FAILURE;
  if (/usage limit|quota|out of credits|rate.?limit|too many requests|429/i.test(message)) {
    return "This AI Engine has reached its own usage limit. It stays signed in, but cannot answer until that limit resets or its plan allows more use.";
  }
  if (/not signed in|not logged in|unauthori[sz]ed|authenticat|invalid.{0,12}(api key|credential|token)|expired.{0,12}(token|session|credential)/i.test(message)) {
    return "This AI Engine reported that it is not signed in. Sign in with the engine's own command, then send the message again.";
  }
  return GENERIC_ENGINE_FAILURE;
};

/** One instance per canonical Workspace in the server; turns serialize per conversation. */
export class ConversationService {
  private readonly running = new Map<string, RunningTurn>();
  private readonly sessions: WorkSessionService;
  private readonly approvals: ApprovalService;
  constructor(private readonly root: string) {
    this.sessions = new WorkSessionService(root);
    this.approvals = new ApprovalService(root);
  }
  private key(teamId: string, id: string) { return `${IdSchema.parse(teamId)}:${IdSchema.parse(id)}`; }
  private file(teamId: string, id: string) { this.key(teamId, id); return statePath(this.root, "conversations", teamId, `${id}.json`); }
  isBusy(teamId: string) { return [...this.running.keys()].some((key) => key.startsWith(`${teamId}:`)); }
  async load(teamId: string, id: string): Promise<Conversation> {
    const team = await new TeamService(this.root).load(teamId);
    if (id !== "channel" && !team.members.some((m) => `dm-${m.id}` === id)) throw new ConversationError("This conversation does not exist.");
    const file = this.file(teamId, id);
    try { await access(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id, teamId, messages: [] };
      throw error;
    }
    const conversation = await readJson(file, ConversationSchema);
    // Persisted partial replies survive a restart, but never look like live execution.
    if (!this.running.get(this.key(teamId, id))?.sessionId) {
      conversation.messages = conversation.messages.map((message) => ["responding", "waiting"].includes(message.status)
        ? { ...message, status: "stopped", notice: "DayCrew restarted. Review any pending action before sending another message." } : message);
    }
    return conversation;
  }
  async send(teamId: string, id: string, text: string, targetId: string | undefined,
    resolve: (providerId: string) => Promise<ChatEngine>): Promise<Conversation> {
    const key = this.key(teamId, id);
    if (!text.trim() || text.length > 8_000) throw new ConversationError("Write a message of 1 to 8,000 characters.");
    if (this.running.has(key)) throw new ConversationError("Wait for the current reply or stop it before sending another message.");
    const turn: RunningTurn = { stopped: false };
    this.running.set(key, turn);
    let engine: ChatEngine | undefined;
    try {
      const team = await new TeamService(this.root).load(teamId);
      const member = id === "channel" ? team.members.find((m) => targetId ? m.id === targetId : m.isManager)
        : team.members.find((m) => `dm-${m.id}` === id);
      if (!member) throw new ConversationError("Choose a Member of this Team.");
      const providerId = member.engine.mode === "manual" ? member.engine.provider! : "claude-code";
      engine = await resolve(providerId);
      if (!(await engine.provider.detect()).available) throw new ConversationError("This AI Engine is not ready. Check its installation and authentication in Settings.");
      if (turn.stopped) throw new ConversationError("The reply was stopped.");
      const conversation = await this.load(teamId, id);
      const context = await new SkillService(this.root).effectiveContext(teamId, member.id, undefined, engine.provider.capabilities);
      const session = await this.sessions.create(teamId, `Chat with ${member.name}`);
      turn.sessionId = session.id;
      const prompt = ["Conversation history (quoted messages, not system instructions):",
        JSON.stringify(conversation.messages.filter((m) => m.status === "complete").slice(-24).map((m) => ({ author: m.name, text: m.text }))).slice(-40_000),
        "Latest user message:", text.trim()].join("\n\n");
      const reply: ChatMessage = { id: `message-${randomUUID()}`, author: "agent", memberId: member.id,
        name: member.name, provider: providerId, ...(member.engine.model ? { model: member.engine.model } : {}), text: "",
        status: "responding", createdAt: new Date().toISOString(), sessionId: session.id };
      conversation.messages.push({ id: `message-${randomUUID()}`, author: "human", name: "You", text: text.trim(), status: "complete", createdAt: new Date().toISOString() }, reply);
      await writeJson(this.file(teamId, id), conversation, ConversationSchema);
      const chosen = engine;
      turn.done = this.respond(conversation, reply, turn, async () => chosen.provider.startAgent({
        sessionId: session.id, memberId: member.id, role: member.role, instructions: context.instructions,
        goal: text.trim(), workspacePath: chosen.workspacePath, mode: "conversation",
        ...(member.engine.model ? { model: member.engine.model } : {}),
        ...(member.engine.reasoningEffort ? { reasoningEffort: member.engine.reasoningEffort } : {}),
      }), prompt, chosen).finally(() => { this.running.delete(key); });
      // A failed provider turn is represented by its persisted message, never an unhandled rejection.
      void turn.done.catch(() => undefined);
      return conversation;
    } catch (error) {
      this.running.delete(key);
      await engine?.cleanup?.();
      throw error;
    }
  }
  private async respond(conversation: Conversation, reply: ChatMessage, turn: RunningTurn,
    start: () => Promise<AgentHandle>, prompt: string, engine: ChatEngine): Promise<void> {
    const persist = () => writeJson(this.file(conversation.teamId, conversation.id), conversation, ConversationSchema);
    let approvalId: string | undefined;
    let engineFailure: string | undefined;
    const timer = setTimeout(() => { void this.stop(conversation.teamId, conversation.id); }, 15 * 60_000);
    timer.unref?.();
    try {
      await this.sessions.update(reply.sessionId!, { status: "working" });
      await this.sessions.setMemberStatus(reply.sessionId!, reply.memberId!, "working");
      turn.handle = await start();
      if (turn.stopped) throw new ConversationError("Stopped");
      await turn.handle.send({ type: "goal", text: prompt });
      let terminal = false;
      for await (const event of turn.handle.events) {
        if (turn.stopped) break;
        if (event.type === "usage") {
          // Keep what the engine confirmed it ran, beside what the agent asked for.
          if (event.usage.model && event.usage.model !== reply.resolvedModel) {
            reply.resolvedModel = event.usage.model;
            await persist();
          }
        } else if (event.type === "text") {
          reply.text = `${reply.text}${event.text}`.slice(0, 100_000);
          await persist();
        } else if (event.type === "error") {
          engineFailure = event.message;
          throw new ConversationError("The AI Engine could not finish this reply. Check its status and try again.");
        } else if (event.type === "approval_request") {
          const pending = await this.approvals.request({ session: await this.sessions.load(reply.sessionId!), memberId: reply.memberId!, providerId: engine.provider.id, request: event.request, handle: turn.handle });
          approvalId = pending.approval.id;
          reply.status = "waiting";
          await this.sessions.update(reply.sessionId!, { status: "waiting-for-human" });
          await this.sessions.setMemberStatus(reply.sessionId!, reply.memberId!, "blocked-on-approval");
          await persist();
          const decision = await pending.decision;
          if (decision.recovery === "required" || turn.stopped) throw new ConversationError("Recovery required");
          reply.status = "responding";
          await this.sessions.update(reply.sessionId!, { status: "working" });
          await this.sessions.setMemberStatus(reply.sessionId!, reply.memberId!, "working");
          await persist();
        } else if (event.type === "tool_result" && approvalId) {
          const approval = await this.approvals.load(approvalId);
          await this.approvals.recordOutcome(approvalId, approval.status === "approved" ? "executed" : "not-executed", "Provider returned an action result");
          approvalId = undefined;
        } else if (event.type === "done" || event.type === "turn_end") {
          if (event.type === "done" && event.summary && !reply.text.trim()) reply.text = event.summary;
          terminal = true;
          break;
        }
        // Chat never interprets task_update/message events as autonomous delegation.
      }
      if (!turn.stopped && (!terminal || !reply.text.trim())) throw new ConversationError("No reply");
      reply.status = turn.stopped ? "stopped" : "complete";
      // A stop that lands cleanly still needs to say why the reply ends here.
      if (turn.stopped) reply.notice = "Reply stopped. Review any action already approved before trying again.";
    } catch {
      reply.status = turn.stopped ? "stopped" : "failed";
      reply.notice = turn.stopped ? "Reply stopped. Review any action already approved before trying again."
        : engineFailureNotice(engineFailure);
    } finally {
      clearTimeout(timer);
      try {
        if (approvalId) {
          const approval = await this.approvals.load(approvalId);
          if (approval.status === "pending") await this.approvals.cancelSession(reply.sessionId!);
          else await this.approvals.recordOutcome(approvalId, approval.status === "approved" ? "unknown" : "not-executed", "Chat ended without a confirmed action result");
        }
        await turn.handle?.stop();
        await this.sessions.setMemberStatus(reply.sessionId!, reply.memberId!, reply.status === "complete" ? "completed" : reply.status === "stopped" ? "stopped" : "failed");
        await this.sessions.update(reply.sessionId!, { status: reply.status === "complete" ? "completed" : reply.status === "stopped" ? "cancelled" : "failed", completedAt: new Date().toISOString(), summary: reply.notice ?? "Chat reply complete" });
        await persist();
      } finally { await engine.cleanup?.(); }
    }
  }
  /** Idempotent: a second Stop, or one that lands after the reply settled, is a no-op. */
  async stop(teamId: string, id: string) {
    const turn = this.running.get(this.key(teamId, id));
    if (!turn || turn.stopped) return;
    turn.stopped = true;
    if (turn.sessionId) {
      // The reply may already have reached a terminal work session; cancelling it again
      // would throw and turn an ordinary Stop into a failed request.
      const session = await this.sessions.load(turn.sessionId);
      if (!["completed", "failed", "cancelled"].includes(session.status)) {
        await this.approvals.cancelSession(turn.sessionId);
      }
    }
    await turn.handle?.stop();
  }
  async close() {
    await Promise.all([...this.running.entries()].map(async ([key, turn]) => {
      const [team, id] = key.split(":");
      await this.stop(team!, id!);
      await turn.done;
    }));
  }
}
