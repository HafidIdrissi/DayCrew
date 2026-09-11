import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ActivityService,
  ApprovalService,
  ManagerOrchestrator,
  TeamService,
  WorkSessionService,
  WorkspaceService,
  requiresHumanApproval,
} from "@daycrew/core";
import { ClaudeCodeProvider } from "@daycrew/providers";
import type { AgentEvent } from "@daycrew/shared";
import { afterAll, describe, expect, it } from "vitest";

const createdDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Every fixture lives under the OS temp directory, never inside the DayCrew checkout. */
const createFixture = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirectories.push(root);
  expect(root.startsWith(path.resolve(tmpdir()))).toBe(true);
  expect(existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(false);
  await writeFile(
    path.join(root, "README.md"),
    "# Safe integration fixture\n\nA tiny service with no routes yet. It holds no credentials.\n",
    "utf8",
  );
  return root;
};

const nextEvent = async (
  iterator: AsyncIterator<AgentEvent>,
  timeoutMs = 120_000,
): Promise<IteratorResult<AgentEvent>> =>
  Promise.race([
    iterator.next(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for a Claude Code event")), timeoutMs),
    ),
  ]);

const waitForTerminalSession = async (root: string, sessionId: string): Promise<string> => {
  const sessions = new WorkSessionService(root);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = (await sessions.load(sessionId)).status;
    if (["completed", "failed", "cancelled"].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Claude work session to finish");
};

describe("real Claude Code provider", () => {
  it("Test 1: detects, plans read-only through the orchestrator, and audits the work session", async () => {
    const root = await createFixture("daycrew-real-claude-plan-");
    await new WorkspaceService(root).create("Claude Integration");
    const team = await new TeamService(root).create({
      name: "Claude Planning",
      // Autonomous still cannot reach a hard boundary; it only auto-allows low-risk reads.
      autonomy: "autonomous",
      members: [
        {
          id: "manager",
          name: "Planning Manager",
          role: "Manager",
          instructions:
            "For a new goal, create exactly one todo task with id hello-plan owned by planner and complete=false. For a returned result, mark hello-plan done and complete=true.",
          isManager: true,
          engine: { mode: "manual", provider: "claude-code" },
        },
        {
          id: "planner",
          name: "Implementation Planner",
          role: "Implementation planning",
          instructions:
            "Inspect the project and write a short implementation plan without modifying files. Update the supplied task id to review and complete=true.",
          isManager: false,
          engine: { mode: "manual", provider: "claude-code" },
        },
      ],
    });

    const provider = new ClaudeCodeProvider({
      allowedWorkspaceRoots: [root],
      requiresApproval: (action, risk) => requiresHumanApproval(team.autonomy, action, risk),
    });

    const detection = await provider.detect();
    expect(detection.available, detection.reason).toBe(true);
    expect(detection.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(provider.capabilities.approvals).toBe(true);
    expect(provider.security).toMatchObject({ mode: "read-only", writesAllowed: false });

    const result = await new ManagerOrchestrator(root, {
      providers: new Map([[provider.id, provider]]),
      defaultProvider: provider.id,
    }).runGoal(
      team.id,
      "Inspect this isolated fixture project and create a short implementation plan for adding a /hello endpoint.",
    );

    expect(result.session.status).toBe("completed");
    expect(result.tasks).toMatchObject([{ id: "hello-plan", ownerId: "planner", status: "done" }]);
    expect(result.session.usage.inputTokens + result.session.usage.outputTokens).toBeGreaterThan(0);

    const activity = await new ActivityService(root).list(result.session.id);
    expect(activity.some((event) => event.kind === "member.text")).toBe(true);
    expect(activity.some((event) => event.kind === "member.tool_used")).toBe(true);
    expect(activity.some((event) => event.kind === "usage.updated")).toBe(true);
    expect(activity.some((event) => event.kind === "session.completed")).toBe(true);

    // A read-only session must never have written into the fixture.
    expect(existsSync(path.join(root, "hello.txt"))).toBe(false);
  });

  it.each([
    ["APPROVE" as const, "approved" as const],
    ["DENY" as const, "denied" as const],
  ])("Test 2 %s: resumes a real blocked Claude Code write through DayCrew core", async (_label, decision) => {
    const root = await createFixture(`daycrew-real-claude-${decision}-`);
    const helloPath = path.join(root, "hello.txt");
    await new WorkspaceService(root).create("Claude Approval Integration");
    const team = await new TeamService(root).create({
      name: "Claude Writer",
      autonomy: "assist",
      members: [
        {
          id: "manager",
          name: "Writer",
          role: "Manager",
          instructions:
            "Perform this goal yourself without delegation. Use the Write tool exactly once, then report complete=true with an empty tasks array. If DayCrew denies the write, do not retry it; report the denial safely with complete=true.",
          isManager: true,
          engine: { mode: "manual", provider: "claude-code" },
        },
      ],
    });
    const provider = new ClaudeCodeProvider({
      allowWrites: true,
      allowedWorkspaceRoots: [root],
      requiresApproval: () => true,
      approvalTimeoutMs: 240_000,
    });
    const orchestrator = new ManagerOrchestrator(root, {
      providers: new Map([[provider.id, provider]]),
      defaultProvider: provider.id,
    });
    const waiting = await orchestrator.runGoal(
      team.id,
      "Create hello.txt in the current directory containing exactly hello followed by a newline. Use the Write tool.",
    );

    expect(waiting.session.status).toBe("waiting-for-human");
    expect(waiting.session.members[0]?.status).toBe("blocked-on-approval");
    expect(existsSync(helloPath)).toBe(false);
    const sessions = new WorkSessionService(root);
    const item = (await sessions.listNeedsYou("pending")).find(
      (candidate) => candidate.sessionId === waiting.session.id && candidate.kind === "approval",
    );
    expect(item, "Claude Code did not raise a core approval").toBeDefined();
    if (!item) throw new Error("Expected a core approval");

    const feedback =
      decision === "denied" ? "Do not create hello.txt. Finish without modifying the workspace." : undefined;
    await new ApprovalService(root).decideNeedsYou(item.id, decision, feedback, {
      type: "human",
      id: "integration-reviewer",
    });

    const terminal = await waitForTerminalSession(root, waiting.session.id);
    expect(["completed", "failed"]).toContain(terminal);
    await orchestrator.waitForCompletion(waiting.session.id);
    expect(existsSync(helloPath)).toBe(decision === "approved");
    if (decision === "approved") {
      expect(await import("node:fs/promises").then(({ readFile }) => readFile(helloPath, "utf8"))).toBe(
        "hello\n",
      );
    }
    const approval = (await new ApprovalService(root).list(waiting.session.id))[0];
    expect(approval).toMatchObject({
      status: decision,
      resumedAt: expect.any(String),
      decidedBy: { type: "human", id: "integration-reviewer" },
      outcome: decision === "approved" ? "executed" : "not-executed",
    });
  });

  it("Test 3: cancels a long-running turn cleanly", async () => {
    const root = await createFixture("daycrew-real-claude-cancel-");
    const provider = new ClaudeCodeProvider({
      allowedWorkspaceRoots: [root],
      requiresApproval: () => false,
    });
    const handle = await provider.startAgent({
      sessionId: "session-cancel",
      memberId: "manager",
      role: "Manager",
      instructions: "Reason carefully and at length before answering.",
      goal: "Cancellation test",
      workspacePath: root,
    });
    await handle.send({
      type: "goal",
      text: "Write an extremely detailed architecture document with at least 100 numbered sections. Do not use any tools.",
    });

    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await handle.interrupt();

    const iterator = handle.events[Symbol.asyncIterator]();
    let cancellation: AgentEvent | undefined;
    for (let index = 0; index < 40; index += 1) {
      const next = await nextEvent(iterator, 30_000);
      if (next.done) break;
      if (next.value.type === "error") {
        cancellation = next.value;
        break;
      }
    }
    expect(cancellation).toMatchObject({ type: "error", recoverable: true });
    await handle.stop();

    // A stopped handle must refuse further input rather than silently restarting Claude.
    await expect(handle.send({ type: "goal", text: "anything" })).rejects.toThrow("stopped");
  });
});
