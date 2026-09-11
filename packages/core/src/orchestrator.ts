import {
  type AgentEvent,
  type AgentHandle,
  type Message,
  type ProviderAdapter,
  type Task,
  type Team,
  type TeamMember,
  type Usage,
  type WorkSession,
} from "@daycrew/shared";

import { ActivityService } from "./activity.js";
import { ApprovalService, type ApprovalServiceOptions } from "./approval.js";
import { WorkSessionService } from "./session.js";
import { TeamService } from "./workspace.js";

export interface OrchestratorDependencies {
  readonly providers: ReadonlyMap<string, ProviderAdapter>;
  readonly defaultProvider?: string;
}

export interface WorkResult {
  readonly session: WorkSession;
  readonly tasks: Task[];
  readonly messages: Message[];
}

type TurnBoundary = "turn-end" | "done" | "waiting" | "failed";

interface AgentRuntime {
  readonly member: TeamMember;
  readonly providerId: string;
  readonly handle: AgentHandle;
  readonly iterator: AsyncIterator<AgentEvent>;
  currentTaskId?: string;
  awaitingOutcomeApprovalId?: string;
}

export class ManagerOrchestrator {
  private readonly sessions: WorkSessionService;
  private readonly activity: ActivityService;
  private readonly approvals: ApprovalService;
  private readonly now: () => string;
  private readonly repeatedEvents = new Map<string, number>();
  private readonly completionBySession = new Map<string, Promise<WorkResult>>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly dependencies: OrchestratorDependencies,
    options: ApprovalServiceOptions = {},
  ) {
    this.sessions = new WorkSessionService(workspaceRoot, options);
    this.activity = new ActivityService(workspaceRoot, options);
    this.approvals = new ApprovalService(workspaceRoot, options);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runGoal(teamId: string, goal: string): Promise<WorkResult> {
    let returned = false;
    return new Promise<WorkResult>((resolve, reject) => {
      const revealWaiting = async (sessionId: string): Promise<void> => {
        if (returned) return;
        const result = await this.resultFor(sessionId);
        returned = true;
        resolve(result);
      };
      const execution = this.executeGoal(teamId, goal, revealWaiting, (sessionId) => {
        this.completionBySession.set(sessionId, execution);
      });
      void execution.then(
        (result) => {
          if (returned) return;
          returned = true;
          resolve(result);
        },
        (error: unknown) => {
          if (!returned) {
            returned = true;
            reject(error);
          }
        },
      );
    });
  }

  /** Waits until the orchestration coroutine has stopped every provider handle. */
  async waitForCompletion(sessionId: string): Promise<WorkResult> {
    const completion = this.completionBySession.get(sessionId);
    return completion ? completion : this.resultFor(sessionId);
  }

  private async executeGoal(
    teamId: string,
    goal: string,
    revealWaiting: (sessionId: string) => Promise<void>,
    registerCompletion: (sessionId: string) => void,
  ): Promise<WorkResult> {
    const team = await new TeamService(this.workspaceRoot).load(teamId);
    const manager = team.members.find((member) => member.isManager);
    if (!manager) throw new Error("Team Manager was not found");
    let session = await this.sessions.create(teamId, goal);
    registerCompletion(session.id);
    session = await this.sessions.update(session.id, { status: "planning" });

    const activeAgents: AgentRuntime[] = [];
    try {
      const managerRuntime = await this.startAgent(session, manager);
      activeAgents.push(managerRuntime);
      await this.sessions.setMemberStatus(session.id, manager.id, "thinking");
      const teamRoster = team.members
        .map((member) => `${member.id}: ${member.role}${member.isManager ? " (Manager)" : ""}`)
        .join("\n");
      await managerRuntime.handle.send({
        type: "goal",
        text: `${goal}\n\nDayCrew Team roster (use these exact Member ids for task ownership):\n${teamRoster}`,
      });
      let managerBoundary = await this.consumeTurn(session.id, team, managerRuntime, revealWaiting);

      while (managerBoundary !== "waiting" && managerBoundary !== "failed") {
        session = await this.sessions.load(session.id);
        if (session.turnCount >= session.limits.maxTurns) {
          await this.failForRunaway(session, manager.id, "Maximum work-session turns reached");
          break;
        }

        const tasks = await this.sessions.listTasks(session.id);
        if (tasks.length === 0) {
          if (managerBoundary === "done") {
            await this.completeSession(session.id, session.summary ?? "Goal completed by the Manager.");
          } else {
            await this.blockSession(session, manager.id, "The Manager did not create any actionable tasks");
          }
          break;
        }
        if (tasks.every((task) => task.status === "done")) {
          await this.completeSession(session.id, session.summary ?? "All tasks completed.");
          break;
        }

        const runnable = tasks.find(
          (task) =>
            task.status === "todo" &&
            task.ownerId !== undefined &&
            task.ownerId !== manager.id &&
            task.dependsOn.every(
              (dependencyId) => tasks.find((candidate) => candidate.id === dependencyId)?.status === "done",
            ),
        );
        if (!runnable) {
          if (managerBoundary === "done") {
            await this.blockSession(session, manager.id, "The Manager stopped with unfinished work");
          } else {
            await this.blockSession(
              session,
              manager.id,
              "No task can run; check ownership, dependencies, or review status",
            );
          }
          break;
        }

        const specialist = team.members.find((member) => member.id === runnable.ownerId);
        if (!specialist) throw new Error(`Task owner "${runnable.ownerId}" was not found`);
        const specialistRuntime = await this.startAgent(session, specialist, runnable.id);
        activeAgents.push(specialistRuntime);
        await this.sessions.update(session.id, { status: "working" });
        await this.sessions.updateTask(session.id, runnable.id, { status: "in-progress" });
        await this.sessions.setMemberStatus(session.id, specialist.id, "working", runnable.id);
        await specialistRuntime.handle.send({
          type: "goal",
          text: `DayCrew task id: ${runnable.id}\n${runnable.title}\n\n${runnable.description}`,
        });
        const specialistBoundary = await this.consumeTurn(
          session.id,
          team,
          specialistRuntime,
          revealWaiting,
        );
        if (specialistBoundary === "waiting" || specialistBoundary === "failed") break;

        const currentTask = (await this.sessions.listTasks(session.id)).find(
          (task) => task.id === runnable.id,
        );
        if (currentTask?.status === "in-progress") {
          await this.sessions.updateTask(session.id, runnable.id, { status: "review" });
        }
        const resultMessage = await this.sessions.sendMessage(session.id, {
          fromMemberId: specialist.id,
          toMemberId: manager.id,
          taskId: runnable.id,
          subject: `${runnable.title} ready for review`,
          body: `The ${specialist.role} completed their turn. Review the result and update the task.`,
        });
        await specialistRuntime.handle.stop();
        await this.sessions.setMemberStatus(session.id, specialist.id, "completed");

        if (managerBoundary === "done") {
          const latest = await this.sessions.load(session.id);
          await this.sessions.createNeedsYou(session.id, {
            memberId: manager.id,
            kind: "review",
            title: `${runnable.title} needs your review`,
            detail: "The specialist completed the work, but the Manager ended before reviewing it.",
            taskId: runnable.id,
          });
          await this.sessions.pause(latest.id, "Completed work requires review");
          break;
        }
        await this.sessions.setMemberStatus(session.id, manager.id, "thinking", runnable.id);
        await managerRuntime.handle.send({ type: "message", message: resultMessage });
        managerBoundary = await this.consumeTurn(session.id, team, managerRuntime, revealWaiting);
      }
    } catch (error) {
      const latest = await this.sessions.load(session.id);
      if (!["completed", "failed", "cancelled"].includes(latest.status)) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.sessions.update(session.id, {
          status: "failed",
          summary: detail,
          completedAt: this.now(),
        });
        await this.activity.record({
          workspaceId: latest.workspaceId,
          teamId: latest.teamId,
          sessionId: latest.id,
          kind: "session.failed",
          summary: detail,
        });
      }
      throw error;
    } finally {
      await Promise.all(activeAgents.map(async (runtime) => runtime.handle.stop()));
    }

    return this.resultFor(session.id);
  }

  private async resultFor(sessionId: string): Promise<WorkResult> {
    return {
      session: await this.sessions.load(sessionId),
      tasks: await this.sessions.listTasks(sessionId),
      messages: await this.sessions.listMessages(sessionId),
    };
  }

  private async startAgent(
    session: WorkSession,
    member: TeamMember,
    currentTaskId?: string,
  ): Promise<AgentRuntime> {
    const provider = await this.providerFor(member);
    const handle = await provider.startAgent({
      sessionId: session.id,
      memberId: member.id,
      role: member.role,
      instructions: member.instructions,
      goal: session.goal,
      workspacePath: this.workspaceRoot,
      ...(member.engine.model === undefined ? {} : { model: member.engine.model }),
    });
    return {
      member,
      providerId: provider.id,
      handle,
      iterator: handle.events[Symbol.asyncIterator](),
      ...(currentTaskId === undefined ? {} : { currentTaskId }),
    };
  }

  private async providerFor(member: TeamMember): Promise<ProviderAdapter> {
    const requested = member.engine.mode === "manual" ? member.engine.provider : undefined;
    const providerId = requested ?? this.dependencies.defaultProvider ?? "mock";
    const provider = this.dependencies.providers.get(providerId);
    if (!provider) throw new Error(`AI Engine "${providerId}" is not configured`);
    const detection = await provider.detect();
    if (!detection.available) {
      throw new Error(`AI Engine "${providerId}" is unavailable: ${detection.reason ?? "unknown reason"}`);
    }
    return provider;
  }

  private async consumeTurn(
    sessionId: string,
    team: Team,
    runtime: AgentRuntime,
    revealWaiting: (sessionId: string) => Promise<void>,
  ): Promise<TurnBoundary> {
    const session = await this.sessions.load(sessionId);
    await this.sessions.update(sessionId, { turnCount: session.turnCount + 1 });
    while (true) {
      const next = await runtime.iterator.next();
      if (next.done) return "done";
      const boundary = await this.applyEvent(sessionId, team, runtime, next.value, revealWaiting);
      if (boundary) return boundary;
    }
  }

  private async applyEvent(
    sessionId: string,
    team: Team,
    runtime: AgentRuntime,
    event: AgentEvent,
    revealWaiting: (sessionId: string) => Promise<void>,
  ): Promise<TurnBoundary | undefined> {
    const session = await this.sessions.load(sessionId);
    if (session.status === "cancelled") return "failed";
    const signature = `${sessionId}:${runtime.member.id}:${JSON.stringify(event)}`;
    const repeated = (this.repeatedEvents.get(signature) ?? 0) + 1;
    this.repeatedEvents.set(signature, repeated);
    if (repeated > session.limits.maxRepeatedUpdates) {
      await this.failForRunaway(session, runtime.member.id, "Repeated agent update limit reached");
      return "failed";
    }

    if (event.type === "text") {
      await this.activity.record({
        workspaceId: session.workspaceId,
        teamId: session.teamId,
        sessionId,
        kind: "member.text",
        summary: `${runtime.member.name}: ${event.text || "Sent an update"}`,
        data: { memberId: runtime.member.id, text: event.text },
      });
      return undefined;
    }
    if (event.type === "tool_call" || event.type === "tool_result") {
      await this.activity.record({
        workspaceId: session.workspaceId,
        teamId: session.teamId,
        sessionId,
        kind: "member.tool_used",
        summary: `${runtime.member.name} ${event.type === "tool_call" ? `used ${event.name}` : "received a tool result"}`,
        data: { memberId: runtime.member.id, ...event },
      });
      if (event.type === "tool_result" && runtime.awaitingOutcomeApprovalId) {
        const approval = await this.approvals.load(runtime.awaitingOutcomeApprovalId);
        const outcome =
          approval.status === "approved" && event.isError !== true ? "executed" : "not-executed";
        await this.approvals.recordOutcome(
          approval.id,
          outcome,
          event.isError === true ? "Provider reported an error" : "Provider returned the blocked action result",
        );
        delete runtime.awaitingOutcomeApprovalId;
      }
      return undefined;
    }
    if (event.type === "task_update") {
      const tasks = await this.sessions.listTasks(sessionId);
      const existing = event.task.id
        ? tasks.find((task) => task.id === event.task.id)
        : undefined;
      let task = existing;
      if (!task) {
        if (!event.task.title) throw new Error(`Unknown task "${event.task.id}"`);
        task = await this.sessions.createTask(sessionId, {
          ...(event.task.id === undefined ? {} : { id: event.task.id }),
          title: event.task.title,
          description: event.task.description ?? "",
          ...(event.task.ownerId === undefined ? {} : { ownerId: event.task.ownerId }),
          dependsOn: event.task.dependsOn ?? [],
          needsYou: event.task.needsYou ?? false,
        });
      }
      const update = {
        ...(event.task.title === undefined ? {} : { title: event.task.title }),
        ...(event.task.description === undefined ? {} : { description: event.task.description }),
        ...(event.task.ownerId === undefined ? {} : { ownerId: event.task.ownerId }),
        ...(event.task.dependsOn === undefined ? {} : { dependsOn: event.task.dependsOn }),
        ...(event.task.needsYou === undefined ? {} : { needsYou: event.task.needsYou }),
        ...(event.task.handoffNote === undefined ? {} : { handoffNote: event.task.handoffNote }),
      };
      if (Object.keys(update).length > 0) {
        task = await this.sessions.updateTask(sessionId, task.id, update);
      }
      if (event.task.status !== undefined && event.task.status !== task.status) {
        task = await this.sessions.updateTask(sessionId, task.id, { status: event.task.status });
      }
      runtime.currentTaskId = task.id;
      return undefined;
    }
    if (event.type === "message") {
      await this.sessions.sendMessage(sessionId, {
        fromMemberId: runtime.member.id,
        ...event.message,
      });
      return undefined;
    }
    if (event.type === "approval_request") {
      const pending = await this.approvals.request({
        session,
        memberId: runtime.member.id,
        ...(runtime.currentTaskId === undefined ? {} : { taskId: runtime.currentTaskId }),
        providerId: runtime.providerId,
        request: event.request,
        handle: runtime.handle,
      });
      await this.sessions.update(sessionId, {
        status: "waiting-for-human",
        pausedReason: event.request.summary,
      });
      await this.sessions.setMemberStatus(
        sessionId,
        runtime.member.id,
        "blocked-on-approval",
        runtime.currentTaskId,
      );
      await revealWaiting(sessionId);
      const decision = await pending.decision;
      const current = await this.sessions.load(sessionId);
      if (current.status === "cancelled") return "failed";
      if (decision.recovery === "required") return "failed";
      await this.sessions.setMemberStatus(
        sessionId,
        runtime.member.id,
        "working",
        runtime.currentTaskId,
      );
      if (!(await this.approvals.hasPending(sessionId))) {
        await this.sessions.update(sessionId, { status: "working", pausedReason: undefined });
      }
      await this.approvals.markResumed(decision.id);
      runtime.awaitingOutcomeApprovalId = decision.id;
      return undefined;
    }
    if (event.type === "usage") {
      const latest = await this.sessions.load(sessionId);
      const usage: Usage = {
        inputTokens: latest.usage.inputTokens + event.usage.inputTokens,
        outputTokens: latest.usage.outputTokens + event.usage.outputTokens,
        costUsd: latest.usage.costUsd + event.usage.costUsd,
      };
      await this.sessions.update(sessionId, { usage });
      await this.activity.record({
        workspaceId: latest.workspaceId,
        teamId: latest.teamId,
        sessionId,
        kind: "usage.updated",
        summary: `${runtime.member.name} reported AI Engine usage`,
        data: { memberId: runtime.member.id, usage: event.usage },
      });
      return undefined;
    }
    if (event.type === "error") {
      if (runtime.awaitingOutcomeApprovalId) {
        const approval = await this.approvals.load(runtime.awaitingOutcomeApprovalId);
        await this.approvals.recordOutcome(
          approval.id,
          approval.status === "approved" ? "unknown" : "not-executed",
          `Provider failed after the decision: ${event.message}`,
        );
        delete runtime.awaitingOutcomeApprovalId;
      }
      await this.sessions.setMemberStatus(sessionId, runtime.member.id, "failed", runtime.currentTaskId);
      await this.sessions.update(sessionId, { status: "failed", summary: event.message, completedAt: this.now() });
      await this.sessions.createNeedsYou(sessionId, {
        memberId: runtime.member.id,
        kind: "failed-task",
        title: `${runtime.member.name} failed`,
        detail: event.message,
        ...(runtime.currentTaskId === undefined ? {} : { taskId: runtime.currentTaskId }),
      });
      return "failed";
    }
    if (event.type === "done") {
      if (runtime.awaitingOutcomeApprovalId) {
        const approval = await this.approvals.load(runtime.awaitingOutcomeApprovalId);
        await this.approvals.recordOutcome(
          approval.id,
          approval.status === "approved" ? "unknown" : "not-executed",
          "Member finished without a provider tool result for the blocked action",
        );
        delete runtime.awaitingOutcomeApprovalId;
      }
      await this.sessions.setMemberStatus(sessionId, runtime.member.id, "completed");
      if (runtime.member.isManager && event.summary) {
        await this.sessions.update(sessionId, { summary: event.summary });
      }
      return "done";
    }
    if (runtime.awaitingOutcomeApprovalId) {
      const approval = await this.approvals.load(runtime.awaitingOutcomeApprovalId);
      await this.approvals.recordOutcome(
        approval.id,
        approval.status === "approved" ? "unknown" : "not-executed",
        "Turn ended without a provider tool result for the blocked action",
      );
      delete runtime.awaitingOutcomeApprovalId;
    }
    return "turn-end";
  }

  private async completeSession(sessionId: string, summary: string): Promise<void> {
    const session = await this.sessions.load(sessionId);
    if (session.status === "cancelled") return;
    await this.sessions.update(sessionId, {
      status: "completed",
      summary,
      completedAt: this.now(),
    });
    await this.activity.record({
      workspaceId: session.workspaceId,
      teamId: session.teamId,
      sessionId,
      kind: "session.completed",
      summary,
    });
  }

  private async blockSession(session: WorkSession, memberId: string, detail: string): Promise<void> {
    await this.sessions.createNeedsYou(session.id, {
      memberId,
      kind: "blocker",
      title: "Work is blocked",
      detail,
    });
    await this.sessions.pause(session.id, detail);
  }

  private async failForRunaway(session: WorkSession, memberId: string, detail: string): Promise<void> {
    await this.sessions.update(session.id, {
      status: "failed",
      summary: detail,
      completedAt: this.now(),
    });
    await this.sessions.createNeedsYou(session.id, {
      memberId,
      kind: "failed-task",
      title: "Runaway protection stopped the work session",
      detail,
    });
  }
}
