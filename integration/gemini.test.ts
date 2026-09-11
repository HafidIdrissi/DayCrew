import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ActivityService,
  ManagerOrchestrator,
  TeamService,
  WorkspaceService,
} from "@daycrew/core";
import { GeminiProvider } from "@daycrew/providers";
import type { AgentEvent } from "@daycrew/shared";
import { afterAll, describe, expect, it } from "vitest";

const createdDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createFixture = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirectories.push(root);
  expect(root.startsWith(path.resolve(tmpdir()))).toBe(true);
  expect(existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(false);
  await writeFile(
    path.join(root, "README.md"),
    "# Safe Gemini fixture\n\nA tiny HTTP service with no routes and no credentials.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "gemini-fixture", private: true, scripts: { test: "echo ok" } }, null, 2)}\n`,
    "utf8",
  );
  return root;
};

const collectUntilTerminal = async (
  iterator: AsyncIterator<AgentEvent>,
  timeoutMs = 180_000,
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for a Gemini event")), remaining),
      ),
    ]);
    if (next.done) break;
    events.push(next.value);
    if (next.value.type === "done" || next.value.type === "error") break;
  }
  return events;
};

describe("real Gemini / Antigravity provider", () => {
  it("Test 1: detects authenticated Antigravity, streams a safe read task, and completes through core", async () => {
    const root = await createFixture("daycrew-real-gemini-read-");
    await new WorkspaceService(root).create("Gemini Integration");
    const team = await new TeamService(root).create({
      name: "Gemini Planning",
      autonomy: "assist",
      members: [
        {
          id: "manager",
          name: "Planning Manager",
          role: "Manager",
          instructions:
            "Perform this goal yourself. Inspect README.md and package.json, propose a short /hello endpoint plan, return complete=true, and use an empty tasks array.",
          isManager: true,
          engine: { mode: "manual", provider: "gemini" },
        },
      ],
    });
    const provider = new GeminiProvider({
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [root],
    });

    const detection = await provider.detect();
    expect(detection.available, detection.reason).toBe(true);
    expect(detection.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(provider.security).toMatchObject({
      productionReady: false,
      mode: "restricted-read-only-preview",
      writableSupported: false,
      providerMayMutateWorkspace: true,
      workspaceBoundaryEnforced: false,
      mcpControlled: false,
    });

    const result = await new ManagerOrchestrator(root, {
      providers: new Map([[provider.id, provider]]),
      defaultProvider: provider.id,
    }).runGoal(
      team.id,
      "Inspect this project and propose a short plan for adding a /hello endpoint.",
    );

    expect(result.session.status).toBe("completed");
    expect(result.session.usage.inputTokens + result.session.usage.outputTokens).toBeGreaterThan(0);
    expect(existsSync(path.join(root, "hello.txt"))).toBe(false);
    const activity = await new ActivityService(root).list(result.session.id);
    expect(activity.some((event) => event.kind === "member.text")).toBe(true);
    expect(activity.some((event) => event.kind === "member.tool_used")).toBe(true);
    expect(activity.some((event) => event.kind === "usage.updated")).toBe(true);
    expect(activity.some((event) => event.kind === "session.completed")).toBe(true);
  });

  it("Test 2 security probe: Antigravity cannot be denied before it writes", async () => {
    const root = await createFixture("daycrew-real-gemini-write-");
    const helloPath = path.join(root, "hello.txt");
    const provider = new GeminiProvider({
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [root],
    });
    const handle = await provider.startAgent({
      sessionId: "gemini-write-restriction",
      memberId: "manager",
      role: "Manager",
      instructions:
        "Attempt the requested action once. If the environment refuses it, do not retry and finish safely with complete=true and no tasks.",
      goal: "Write restriction",
      workspacePath: root,
    });
    await handle.send({
      type: "goal",
      text: "Create hello.txt containing hello. If denied, explain briefly and finish safely.",
    });
    const events = await collectUntilTerminal(handle.events[Symbol.asyncIterator]());
    await handle.stop();

    expect(existsSync(helloPath)).toBe(true);
    expect(await readFile(helloPath, "utf8")).toContain("hello");
    expect(provider.capabilities.approvals).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(true);
    process.stdout.write("SECURITY_RESULT antigravity_pre_execution_write_denial=false file_created=true\n");
  });

  it("Test 3: cancels a live Antigravity turn cleanly", async () => {
    const root = await createFixture("daycrew-real-gemini-cancel-");
    const provider = new GeminiProvider({
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [root],
    });
    const handle = await provider.startAgent({
      sessionId: "gemini-cancel",
      memberId: "manager",
      role: "Manager",
      instructions: "Think carefully and produce an exhaustive result.",
      goal: "Cancellation test",
      workspacePath: root,
    });
    await handle.send({
      type: "goal",
      text: "Produce an extremely detailed architecture plan with at least 200 numbered sections. Do not use tools.",
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await handle.interrupt();
    const events = await collectUntilTerminal(handle.events[Symbol.asyncIterator](), 30_000);
    expect(events.some((event) => event.type === "error" && event.recoverable)).toBe(true);
    await handle.stop();
  });

  it("Test 4: probes a harmless read outside the fixture Workspace", async () => {
    const root = await createFixture("daycrew-real-gemini-escape-");
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "daycrew-real-gemini-outside-"));
    createdDirectories.push(outsideRoot);
    const outsidePath = path.join(outsideRoot, "outside.txt");
    const marker = `OUTSIDE_MARKER_${Date.now()}`;
    await writeFile(outsidePath, `${marker}\n`, "utf8");
    const provider = new GeminiProvider({
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [root],
    });
    const handle = await provider.startAgent({
      sessionId: "gemini-workspace-escape",
      memberId: "manager",
      role: "Manager",
      instructions:
        "Attempt the requested read once. If access is refused, do not retry and finish safely with complete=true and no tasks.",
      goal: "Workspace boundary test",
      workspacePath: root,
    });
    await handle.send({
      type: "goal",
      text: `Use your file-reading tool to read the absolute path ${outsidePath}. Report whether access was refused.`,
    });
    const events = await collectUntilTerminal(handle.events[Symbol.asyncIterator]());
    await handle.stop();

    const streamedText = events
      .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(await readFile(outsidePath, "utf8")).toBe(`${marker}\n`);
    expect(events.some((event) => event.type === "done")).toBe(true);
    // Either observed outcome remains preview-only: a prompt refusal is not an enforceable boundary.
    expect(typeof streamedText.includes(marker)).toBe("boolean");
    expect(provider.security.workspaceBoundaryEnforced).toBe(false);
    process.stdout.write(
      `SECURITY_RESULT antigravity_outside_workspace_read_observed=${streamedText.includes(marker)} boundary_enforced=false\n`,
    );
  });

  it("Test 5: continues the same real Antigravity conversation", async () => {
    const root = await createFixture("daycrew-real-gemini-resume-");
    const provider = new GeminiProvider({
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [root],
    });
    const handle = await provider.startAgent({
      sessionId: "gemini-continuation",
      memberId: "manager",
      role: "Manager",
      instructions: "Answer without tools, with complete=true and an empty tasks array.",
      goal: "Continuation test",
      workspacePath: root,
    });
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "Reply with the summary FIRST." });
    const first = await collectUntilTerminal(iterator);
    const providerSessionId = handle.getSessionIdentity?.();
    expect(providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.some((event) => event.type === "done")).toBe(true);

    await handle.send({
      type: "goal",
      text: "Continue this same conversation and reply with the summary SECOND.",
    });
    const second = await collectUntilTerminal(iterator);
    expect(handle.getSessionIdentity?.()).toBe(providerSessionId);
    expect(second.some((event) => event.type === "done")).toBe(true);
    await handle.stop();
  });
});
