import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockProvider } from "@daycrew/providers";
import {
  ApprovalRecordSchema,
  type AgentEvent,
  type AgentHandle,
  type AgentInput,
} from "@daycrew/shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ActivityService,
  ApprovalService,
  ManagerOrchestrator,
  TeamService,
  WorkSessionService,
  WorkspaceService,
  statePath,
  writeJson,
} from "./index.js";

const directories: string[] = [];

const eventually = async (check: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for state transition");
};

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-approval-"));
  directories.push(root);
  await new WorkspaceService(root).create("Approval tests");
  const team = await new TeamService(root).create({
    name: "Approval team",
    members: [
      {
        id: "manager",
        name: "Manager",
        role: "Manager",
        instructions: "Coordinate.",
        isManager: true,
        engine: { mode: "auto" },
      },
      {
        id: "developer",
        name: "Developer",
        role: "Developer",
        instructions: "Implement.",
        isManager: false,
        engine: { mode: "auto" },
      },
      {
        id: "qa",
        name: "QA",
        role: "QA",
        instructions: "Verify.",
        isManager: false,
        engine: { mode: "auto" },
      },
    ],
  });
  return { root, team };
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const approvalScript = (requestId: string) => [
  [
    {
      type: "approval_request" as const,
      request: {
        requestId,
        action: "filesystem.write" as const,
        risk: "medium" as const,
        summary: "Create hello.txt",
        payload: { path: "hello.txt" },
      },
    },
  ],
  [{ type: "done" as const, summary: "Handled the decision safely." }],
];

describe("approval resume lifecycle", () => {
  it.each([
    ["approved" as const, undefined],
    ["denied" as const, "Do not modify package.json. Find another solution."],
  ])("routes %s through the service and resumes the same work session", async (decision, feedback) => {
    const { root, team } = await setup();
    const provider = new MockProvider({ scriptsByMember: { manager: approvalScript("provider-a") } });
    const orchestrator = new ManagerOrchestrator(root, {
      providers: new Map([[provider.id, provider]]),
    });

    const waiting = await orchestrator.runGoal(team.id, "Create hello.txt");
    expect(waiting.session.status).toBe("waiting-for-human");
    expect(waiting.session.members.find((member) => member.memberId === "manager")?.status).toBe(
      "blocked-on-approval",
    );
    const sessions = new WorkSessionService(root);
    const item = (await sessions.listNeedsYou("pending"))[0];
    if (!item) throw new Error("Expected a pending approval");

    await new ApprovalService(root).decideNeedsYou(item.id, decision, feedback, {
      type: "human",
      id: "reviewer-1",
    });
    await eventually(async () => {
      const current = await sessions.load(waiting.session.id);
      if (current.status === "failed") throw new Error(current.summary);
      if (current.status !== "completed") return false;
      return (await new ActivityService(root).list(waiting.session.id)).some(
        (event) => event.kind === "session.completed",
      );
    });

    const routed = provider.inputs.find((entry) => entry.input.type === "approval-decision");
    expect(routed).toMatchObject({
      memberId: "manager",
      input: { type: "approval-decision", requestId: "provider-a", decision },
    });
    if (feedback) expect(routed?.input).toMatchObject({ feedback });
    const approval = (await new ApprovalService(root).list(waiting.session.id))[0];
    expect(approval).toMatchObject({
      status: decision,
      resumedAt: expect.any(String),
      decidedBy: { type: "human", id: "reviewer-1" },
      outcome: decision === "approved" ? "unknown" : "not-executed",
    });
    const activity = await new ActivityService(root).list(waiting.session.id);
    expect(activity.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.decided",
        "member.resumed",
        "approval.action_outcome",
        "session.completed",
      ]),
    );
  }, 30_000);

  it("keeps simultaneous Member approvals isolated", async () => {
    const { root, team } = await setup();
    const sessions = new WorkSessionService(root);
    const session = await sessions.create(team.id, "Parallel review");
    const sentA: AgentInput[] = [];
    const sentB: AgentInput[] = [];
    const handle = (sent: AgentInput[]): AgentHandle => ({
      events: (async function* (): AsyncIterable<AgentEvent> {})(),
      send: async (input) => {
        sent.push(input);
      },
      interrupt: async () => undefined,
      stop: async () => undefined,
    });
    const approvals = new ApprovalService(root);
    const a = await approvals.request({
      session,
      memberId: "developer",
      providerId: "mock",
      request: {
        requestId: "request-a",
        action: "filesystem.write",
        risk: "medium",
        summary: "Developer write",
        payload: { path: "a.txt" },
      },
      handle: handle(sentA),
    });
    const b = await approvals.request({
      session,
      memberId: "qa",
      providerId: "mock",
      request: {
        requestId: "request-b",
        action: "command.run",
        risk: "medium",
        summary: "QA command",
        payload: { command: "test" },
      },
      handle: handle(sentB),
    });

    await approvals.decide(a.approval.id, "approved");
    expect(sentA).toMatchObject([{ requestId: "request-a", decision: "approved" }]);
    expect(sentB).toEqual([]);
    expect(await approvals.hasPending(session.id)).toBe(true);
    await approvals.decide(b.approval.id, "denied", "Use a read-only check");
    expect(sentB).toMatchObject([
      { requestId: "request-b", decision: "denied", feedback: "Use a read-only check" },
    ]);
  });

  it("expires as a denial and fails closed", async () => {
    const { root, team } = await setup();
    const session = await new WorkSessionService(root).create(team.id, "Expiry");
    const sent: AgentInput[] = [];
    const approvals = new ApprovalService(root, { approvalTimeoutMs: 20 });
    const pending = await approvals.request({
      session,
      memberId: "developer",
      providerId: "mock",
      request: {
        requestId: "expiring-request",
        action: "filesystem.write",
        risk: "high",
        summary: "Expiring write",
        payload: { path: "never.txt" },
      },
      handle: {
        events: (async function* (): AsyncIterable<AgentEvent> {})(),
        send: async (input) => {
          sent.push(input);
        },
        interrupt: async () => undefined,
        stop: async () => undefined,
      },
    });

    await expect(pending.decision).resolves.toMatchObject({ status: "expired" });
    expect(sent).toMatchObject([{ decision: "denied", requestId: "expiring-request" }]);
    expect((await approvals.load(pending.approval.id)).status).toBe("expired");
  });

  it("cancels safely while waiting", async () => {
    const { root, team } = await setup();
    const provider = new MockProvider({ scriptsByMember: { manager: approvalScript("cancel-me") } });
    const waiting = await new ManagerOrchestrator(root, {
      providers: new Map([[provider.id, provider]]),
    }).runGoal(team.id, "Cancel this");
    const cancelled = await new ApprovalService(root).cancelSession(waiting.session.id, "reviewer-2");
    expect(cancelled.status).toBe("cancelled");
    expect(provider.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({ decision: "denied", requestId: "cancel-me" }),
        }),
      ]),
    );
    await eventually(async () => (await new WorkSessionService(root).load(waiting.session.id)).status === "cancelled");
  });

  it("marks persisted approvals for safe recovery when the live handle is gone", async () => {
    const { root, team } = await setup();
    const sessions = new WorkSessionService(root);
    const session = await sessions.create(team.id, "Restart recovery");
    const item = await sessions.createNeedsYou(session.id, {
      memberId: "developer",
      kind: "approval",
      title: "Uncertain write",
      detail: "Approval required for filesystem.write",
      action: "filesystem.write",
      risk: "high",
      approvalId: "approval-restart",
    });
    const timestamp = new Date().toISOString();
    await writeJson(
      statePath(root, "approvals.json"),
      [
        {
          id: "approval-restart",
          needsYouId: item.id,
          workspaceId: session.workspaceId,
          teamId: session.teamId,
          sessionId: session.id,
          memberId: "developer",
          providerId: "mock",
          providerRequestId: "lost-request",
          providerSessionId: "lost-provider-session",
          action: "filesystem.write",
          risk: "high",
          summary: "Uncertain write",
          payload: { path: "unknown.txt" },
          requestedAt: timestamp,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      z.array(ApprovalRecordSchema),
    );

    const reconciled = await new ApprovalService(root).reconcileAfterRestart();
    expect(reconciled).toMatchObject([{ id: "approval-restart", recovery: "required", status: "pending" }]);
    expect(await sessions.load(session.id)).toMatchObject({
      status: "waiting-for-human",
      pausedReason: "Safe provider recovery is required",
    });
  });

  it("never assumes an approved action's outcome across the decision crash window", async () => {
    const { root, team } = await setup();
    const sessions = new WorkSessionService(root);
    const session = await sessions.create(team.id, "Approved restart recovery");
    const item = await sessions.createNeedsYou(session.id, {
      memberId: "developer",
      kind: "approval",
      title: "Approved before crash",
      detail: "Approval required for filesystem.write",
      action: "filesystem.write",
      risk: "high",
      approvalId: "approval-crash-window",
    });
    await sessions.resolveNeedsYou(item.id, "approved");
    const timestamp = new Date().toISOString();
    await writeJson(
      statePath(root, "approvals.json"),
      [
        {
          id: "approval-crash-window",
          needsYouId: item.id,
          workspaceId: session.workspaceId,
          teamId: session.teamId,
          sessionId: session.id,
          memberId: "developer",
          providerId: "mock",
          providerRequestId: "possibly-sent-request",
          providerSessionId: "lost-provider-session",
          action: "filesystem.write",
          risk: "high",
          summary: "Approved before crash",
          payload: { path: "unknown.txt" },
          status: "approved",
          requestedAt: timestamp,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          decidedAt: timestamp,
          decidedBy: { type: "human", id: "reviewer" },
        },
      ],
      z.array(ApprovalRecordSchema),
    );

    const reconciled = await new ApprovalService(root).reconcileAfterRestart();
    expect(reconciled).toMatchObject([
      { id: "approval-crash-window", recovery: "required", status: "approved", outcome: "unknown" },
    ]);
  });
});
