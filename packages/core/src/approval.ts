import { workspaceError } from "./workspace-errors.js";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  ApprovalRecordSchema,
  type AgentHandle,
  type ApprovalRecord,
  type ApprovalRequest,
  type WorkSession,
} from "@daycrew/shared";
import { z } from "zod";

import { ActivityService } from "./activity.js";
import { readJson, statePath, writeJson } from "./storage.js";
import { WorkSessionService } from "./session.js";
import type { ServiceOptions } from "./workspace.js";

const ApprovalCollectionSchema = z.array(ApprovalRecordSchema);

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw workspaceError(error);
  }
};

export interface ApprovalActor {
  readonly type: "human" | "system";
  readonly id: string;
}

export interface ApprovalServiceOptions extends ServiceOptions {
  readonly approvalTimeoutMs?: number;
}

interface LiveApproval {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly memberId: string;
  readonly providerId: string;
  readonly providerRequestId: string;
  readonly handle: AgentHandle;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (approval: ApprovalRecord) => void;
}

const runtimeByRoot = new Map<string, Map<string, LiveApproval>>();
const mutationByRoot = new Map<string, Promise<void>>();

const runtimeFor = (workspaceRoot: string): Map<string, LiveApproval> => {
  const root = path.resolve(workspaceRoot);
  let runtime = runtimeByRoot.get(root);
  if (!runtime) {
    runtime = new Map();
    runtimeByRoot.set(root, runtime);
  }
  return runtime;
};

const serialize = async <T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> => {
  const root = path.resolve(workspaceRoot);
  const previous = mutationByRoot.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  mutationByRoot.set(root, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationByRoot.get(root) === queued) mutationByRoot.delete(root);
  }
};

export interface RequestApprovalInput {
  readonly session: WorkSession;
  readonly memberId: string;
  readonly taskId?: string;
  readonly providerId: string;
  readonly request: ApprovalRequest;
  readonly handle: AgentHandle;
}

export interface PendingApproval {
  readonly approval: ApprovalRecord;
  readonly decision: Promise<ApprovalRecord>;
}

export class ApprovalService {
  private readonly sessions: WorkSessionService;
  private readonly activity: ActivityService;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly approvalTimeoutMs: number;

  constructor(
    private readonly workspaceRoot: string,
    options: ApprovalServiceOptions = {},
  ) {
    this.sessions = new WorkSessionService(workspaceRoot, options);
    this.activity = new ActivityService(workspaceRoot, options);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 900_000;
  }

  private approvalsPath(): string {
    return statePath(this.workspaceRoot, "approvals.json");
  }

  async list(sessionId?: string): Promise<ApprovalRecord[]> {
    if (!(await exists(this.approvalsPath()))) return [];
    const approvals = await readJson(this.approvalsPath(), ApprovalCollectionSchema);
    return sessionId === undefined
      ? approvals
      : approvals.filter((approval) => approval.sessionId === sessionId);
  }

  async load(approvalId: string): Promise<ApprovalRecord> {
    const approval = (await this.list()).find((candidate) => candidate.id === approvalId);
    if (!approval) throw new Error(`Approval "${approvalId}" was not found`);
    return approval;
  }

  async request(input: RequestApprovalInput): Promise<PendingApproval> {
    const requestedAt = this.now();
    const approvalId = `approval-${this.createId()}`;
    const providerRequestId = input.request.requestId ?? `request-${this.createId()}`;
    const expiresAt = new Date(
      new Date(requestedAt).getTime() + this.approvalTimeoutMs,
    ).toISOString();
    const providerSessionId = input.handle.getSessionIdentity?.();
    let item!: Awaited<ReturnType<WorkSessionService["createNeedsYou"]>>;
    let approval!: ApprovalRecord;
    await serialize(this.workspaceRoot, async () => {
      item = await this.sessions.createNeedsYou(input.session.id, {
        memberId: input.memberId,
        kind: "approval",
        title: input.request.summary,
        detail: `Approval required for ${input.request.action}`,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        risk: input.request.risk,
        action: input.request.action,
        approvalId,
      });
      approval = ApprovalRecordSchema.parse({
        id: approvalId,
        needsYouId: item.id,
        workspaceId: input.session.workspaceId,
        teamId: input.session.teamId,
        sessionId: input.session.id,
        memberId: input.memberId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        providerId: input.providerId,
        providerRequestId,
        ...(providerSessionId === undefined ? {} : { providerSessionId }),
        action: input.request.action,
        risk: input.request.risk,
        summary: input.request.summary,
        payload: input.request.payload,
        requestedAt,
        expiresAt,
      });
      await writeJson(this.approvalsPath(), [...(await this.list()), approval], ApprovalCollectionSchema);
    });
    await this.activity.record({
      workspaceId: approval.workspaceId,
      teamId: approval.teamId,
      sessionId: approval.sessionId,
      kind: "approval.requested",
      summary: approval.summary,
      data: {
        approvalId,
        needsYouId: item.id,
        memberId: approval.memberId,
        providerId: approval.providerId,
        providerRequestId,
        providerSessionId: approval.providerSessionId,
        action: approval.action,
        payload: approval.payload,
      },
    });

    let resolveDecision!: (value: ApprovalRecord) => void;
    const decision = new Promise<ApprovalRecord>((resolve) => {
      resolveDecision = resolve;
    });
    const timer = setTimeout(() => {
      void this.expire(approvalId);
    }, this.approvalTimeoutMs);
    timer.unref?.();
    runtimeFor(this.workspaceRoot).set(approvalId, {
      approvalId,
      sessionId: approval.sessionId,
      memberId: approval.memberId,
      providerId: approval.providerId,
      providerRequestId,
      handle: input.handle,
      timer,
      resolve: resolveDecision,
    });
    return { approval, decision };
  }

  async decideNeedsYou(
    itemId: string,
    decision: "approved" | "denied",
    feedback?: string,
    actor: ApprovalActor = { type: "human", id: "local-user" },
  ): Promise<ApprovalRecord> {
    const approval = (await this.list()).find((candidate) => candidate.needsYouId === itemId);
    if (!approval) throw new Error(`Needs You item "${itemId}" is not linked to an approval`);
    return this.decide(approval.id, decision, feedback, actor);
  }

  async decide(
    approvalId: string,
    decision: "approved" | "denied",
    feedback?: string,
    actor: ApprovalActor = { type: "human", id: "local-user" },
  ): Promise<ApprovalRecord> {
    return this.applyDecision(approvalId, decision, feedback, actor);
  }

  async expire(approvalId: string): Promise<ApprovalRecord> {
    return this.applyDecision(
      approvalId,
      "expired",
      "Approval expired before a human decision was received",
      { type: "system", id: "approval-timeout" },
    );
  }

  private async applyDecision(
    approvalId: string,
    status: "approved" | "denied" | "expired",
    feedback: string | undefined,
    actor: ApprovalActor,
  ): Promise<ApprovalRecord> {
    let updated!: ApprovalRecord;
    await serialize(this.workspaceRoot, async () => {
      const approvals = await this.list();
      const current = approvals.find((candidate) => candidate.id === approvalId);
      if (!current) throw new Error(`Approval "${approvalId}" was not found`);
      if (current.status !== "pending") throw new Error("Approval is already resolved");
      updated = ApprovalRecordSchema.parse({
        ...current,
        status,
        decidedAt: this.now(),
        decidedBy: actor,
        ...(feedback === undefined ? {} : { feedback }),
      });
      await writeJson(
        this.approvalsPath(),
        approvals.map((approval) => (approval.id === approvalId ? updated : approval)),
        ApprovalCollectionSchema,
      );
      await this.sessions.resolveNeedsYou(updated.needsYouId, status, feedback);
    });
    await this.activity.record({
      workspaceId: updated.workspaceId,
      teamId: updated.teamId,
      sessionId: updated.sessionId,
      kind: "approval.decided",
      summary: `${updated.summary}: ${status}`,
      data: { approvalId, status, feedback, decidedBy: actor, memberId: updated.memberId },
    });

    const runtime = runtimeFor(this.workspaceRoot).get(approvalId);
    if (!runtime || !this.matches(runtime, updated)) {
      return this.requireRecovery(updated);
    }
    clearTimeout(runtime.timer);
    try {
      await runtime.handle.send({
        type: "approval-decision",
        requestId: updated.providerRequestId,
        decision: status === "approved" ? "approved" : "denied",
        ...(feedback === undefined ? {} : { feedback }),
      });
      runtimeFor(this.workspaceRoot).delete(approvalId);
      runtime.resolve(updated);
      return updated;
    } catch (error) {
      runtimeFor(this.workspaceRoot).delete(approvalId);
      await runtime.handle.interrupt().catch(() => undefined);
      const recovered = await this.requireRecovery(
        updated,
        `The live provider session rejected the decision: ${error instanceof Error ? error.message : String(error)}`,
      );
      runtime.resolve(recovered);
      return recovered;
    }
  }

  private matches(runtime: LiveApproval, approval: ApprovalRecord): boolean {
    return (
      runtime.approvalId === approval.id &&
      runtime.sessionId === approval.sessionId &&
      runtime.memberId === approval.memberId &&
      runtime.providerId === approval.providerId &&
      runtime.providerRequestId === approval.providerRequestId
    );
  }

  private async requireRecovery(
    approval: ApprovalRecord,
    detail = "The original live provider handle no longer exists; the blocked action was not assumed to have executed",
  ): Promise<ApprovalRecord> {
    const outcome = approval.status === "approved" ? "unknown" : "not-executed";
    const recovered = await this.updateRecord(approval.id, {
      recovery: "required",
      outcome,
      outcomeDetail: detail,
      outcomeAt: this.now(),
    });
    const session = await this.sessions.load(approval.sessionId);
    if (!["completed", "failed", "cancelled"].includes(session.status)) {
      await this.sessions.update(approval.sessionId, {
        status: "waiting-for-human",
        pausedReason: "Safe provider recovery is required",
      });
      await this.sessions.setMemberStatus(
        approval.sessionId,
        approval.memberId,
        "paused",
        approval.taskId,
      );
    }
    await this.activity.record({
      workspaceId: approval.workspaceId,
      teamId: approval.teamId,
      sessionId: approval.sessionId,
      kind: "approval.recovery_required",
      summary: "Approval requires safe recovery",
      data: { approvalId: approval.id, memberId: approval.memberId, detail },
    });
    await this.activity.record({
      workspaceId: approval.workspaceId,
      teamId: approval.teamId,
      sessionId: approval.sessionId,
      kind: "approval.action_outcome",
      summary: `${approval.action}: ${outcome}`,
      data: { approvalId: approval.id, memberId: approval.memberId, outcome, detail },
    });
    return recovered;
  }

  async markResumed(approvalId: string): Promise<ApprovalRecord> {
    const approval = await this.updateRecord(approvalId, { resumedAt: this.now() });
    await this.activity.record({
      workspaceId: approval.workspaceId,
      teamId: approval.teamId,
      sessionId: approval.sessionId,
      kind: "member.resumed",
      summary: `${approval.memberId} resumed after ${approval.status}`,
      data: { approvalId, memberId: approval.memberId, decision: approval.status },
    });
    return approval;
  }

  async recordOutcome(
    approvalId: string,
    outcome: "executed" | "not-executed" | "unknown",
    detail: string,
  ): Promise<ApprovalRecord> {
    const approval = await this.updateRecord(approvalId, {
      outcome,
      outcomeDetail: detail,
      outcomeAt: this.now(),
    });
    await this.activity.record({
      workspaceId: approval.workspaceId,
      teamId: approval.teamId,
      sessionId: approval.sessionId,
      kind: "approval.action_outcome",
      summary: `${approval.action}: ${outcome}`,
      data: { approvalId, memberId: approval.memberId, outcome, detail },
    });
    return approval;
  }

  async hasPending(sessionId: string): Promise<boolean> {
    return (await this.list(sessionId)).some((approval) => approval.status === "pending");
  }

  async reconcileAfterRestart(): Promise<ApprovalRecord[]> {
    const stranded = (await this.list()).filter(
      (approval) =>
        approval.recovery !== "required" &&
        (approval.status === "pending" || approval.outcome === undefined),
    );
    const recovered: ApprovalRecord[] = [];
    for (const approval of stranded) {
      if (!runtimeFor(this.workspaceRoot).has(approval.id)) {
        recovered.push(
          approval.status === "pending" &&
            new Date(approval.expiresAt).getTime() <= new Date(this.now()).getTime()
            ? await this.expire(approval.id)
            : await this.requireRecovery(approval),
        );
      }
    }
    return recovered;
  }

  async cancelSession(sessionId: string, actorId = "local-user"): Promise<WorkSession> {
    const initial = await this.sessions.load(sessionId);
    if (["completed", "failed", "cancelled"].includes(initial.status)) {
      throw new Error(`Cannot cancel a ${initial.status} work session`);
    }
    await this.sessions.update(sessionId, {
      status: "cancelled",
      summary: "Cancelled by the user",
      completedAt: this.now(),
    });
    const pending = (await this.list(sessionId)).filter((approval) => approval.status === "pending");
    for (const approval of pending) {
      const runtime = runtimeFor(this.workspaceRoot).get(approval.id);
      await this.applyDecision(
        approval.id,
        "denied",
        "Work session cancelled while awaiting approval",
        { type: "human", id: actorId },
      );
      const decided = await this.load(approval.id);
      if (decided.outcome === undefined) {
        await this.recordOutcome(
          approval.id,
          "not-executed",
          "Work session was cancelled while the action was blocked",
        );
      }
      if (runtime) await runtime.handle.interrupt().catch(() => undefined);
    }
    const session = await this.sessions.load(sessionId);
    for (const member of session.members) {
      if (!["completed", "failed"].includes(member.status)) {
        await this.sessions.setMemberStatus(sessionId, member.memberId, "stopped", member.currentTaskId);
      }
    }
    const cancelled = await this.sessions.load(sessionId);
    await this.activity.record({
      workspaceId: session.workspaceId,
      teamId: session.teamId,
      sessionId,
      kind: "session.cancelled",
      summary: "Work session cancelled",
      data: { actorId },
    });
    return cancelled;
  }

  private async updateRecord(
    approvalId: string,
    update: Partial<ApprovalRecord>,
  ): Promise<ApprovalRecord> {
    return serialize(this.workspaceRoot, async () => {
      const approvals = await this.list();
      const current = approvals.find((candidate) => candidate.id === approvalId);
      if (!current) throw new Error(`Approval "${approvalId}" was not found`);
      const updated = ApprovalRecordSchema.parse({ ...current, ...update, id: current.id });
      await writeJson(
        this.approvalsPath(),
        approvals.map((approval) => (approval.id === approvalId ? updated : approval)),
        ApprovalCollectionSchema,
      );
      return updated;
    });
  }
}
