import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ActivityService,
  ApprovalService,
  ConversationService,
  ManagerOrchestrator,
  TeamService,
  WorkSessionService,
  WorkspaceService,
} from "@daycrew/core";
import { GeminiProvider } from "@daycrew/providers";
import type { AgentEvent, ChatMessage } from "@daycrew/shared";
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

/** Antigravity runs turns inside one shared local process that DayCrew must never kill. */
const languageServerPids = (): readonly number[] => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | ForEach-Object ProcessId) | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8" },
  );
  const text = result.stdout.trim();
  if (text === "") return [];
  const parsed: unknown = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter((pid) => Number.isFinite(pid));
};

/** Short-lived `agentapi` children are DayCrew-owned; none may outlive a stopped turn. */
const agentApiChildren = (): number => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Where-Object { $_.CommandLine -like '*agentapi*' }).Count",
    ],
    { encoding: "utf8" },
  );
  return Number(result.stdout.trim()) || 0;
};

const previewEngine = async () => {
  const disposable = await createFixture("daycrew-real-gemini-chat-preview-");
  return {
    provider: new GeminiProvider({
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [disposable],
      detectionTimeoutMs: 120_000,
    }),
    workspacePath: disposable,
  };
};

const chatWorkspace = async (name: string) => {
  const root = await createFixture("daycrew-real-gemini-chat-");
  await new WorkspaceService(root).create(name);
  const team = await new TeamService(root).create({
    name: "Antigravity Chat",
    autonomy: "assist",
    members: [
      {
        id: "manager",
        name: "Ada",
        role: "Manager",
        instructions: "Answer briefly and factually.",
        isManager: true,
        engine: { mode: "manual", provider: "gemini" },
      },
    ],
  });
  return { root, teamId: team.id, service: new ConversationService(root) };
};

const settledReply = async (
  service: ConversationService,
  teamId: string,
  index: number,
  timeoutMs = 240_000,
): Promise<ChatMessage> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = (await service.load(teamId, "dm-manager")).messages[index];
    if (message && message.status !== "responding" && message.status !== "waiting") return message;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("The reply never reached a final state");
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

  it("Test 5: continues the same real Antigravity conversation and recalls its context", async () => {
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
      mode: "conversation",
    });
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "Remember this build code: ZEBRA-4417. Acknowledge it." });
    const first = await collectUntilTerminal(iterator);
    const providerSessionId = handle.getSessionIdentity?.();
    expect(providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.some((event) => event.type === "done")).toBe(true);

    await handle.send({
      type: "goal",
      text: "What was the build code I gave you earlier? Reply with the code only.",
    });
    const second = await collectUntilTerminal(iterator);
    expect(handle.getSessionIdentity?.()).toBe(providerSessionId);
    expect(second.some((event) => event.type === "done")).toBe(true);
    // The provider kept its own conversation context: the code came back without
    // DayCrew resending it in the second prompt.
    const recalled = second
      .flatMap((event) => (event.type === "text" ? [event.text] : []))
      .concat(second.flatMap((event) => (event.type === "done" && event.summary ? [event.summary] : [])))
      .join(" ");
    expect(recalled).toContain("ZEBRA-4417");
    await handle.stop();
  });

  it("Test 6: keeps chat context across two real turns of a DayCrew conversation", async () => {
    const { teamId, service } = await chatWorkspace("Antigravity chat context");
    await service.send(
      teamId,
      "dm-manager",
      "Remember this build code: ZEBRA-4417. Just acknowledge it.",
      undefined,
      previewEngine,
    );
    const first = await settledReply(service, teamId, 1);
    expect(first.status, first.notice).toBe("complete");
    expect(first.provider).toBe("gemini");

    await service.send(
      teamId,
      "dm-manager",
      "What was the build code I gave you? Answer with the code only.",
      undefined,
      previewEngine,
    );
    const second = await settledReply(service, teamId, 3);
    await service.close();

    // Every chat turn starts a fresh provider session, so this proves DayCrew's own
    // bounded history reached Antigravity, not that the provider remembered.
    expect(second.status, second.notice).toBe("complete");
    expect(second.text).toContain("ZEBRA-4417");
    expect(second.text).not.toMatch(/DAYCREW_RESULT/);
  });

  it("Test 7: stops a live chat reply, ends the run, and leaves no orphan approval", async () => {
    const { root, teamId, service } = await chatWorkspace("Antigravity chat stop");
    const pidsBefore = languageServerPids();
    await service.send(
      teamId,
      "dm-manager",
      "Write an extremely detailed 200-section architecture review. Number every section.",
      undefined,
      previewEngine,
    );
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await service.stop(teamId, "dm-manager");
    await service.close();

    const reply = (await service.load(teamId, "dm-manager")).messages[1];
    expect(reply).toMatchObject({ status: "stopped" });
    expect(reply?.notice).toMatch(/stopped/i);
    const sessions = new WorkSessionService(root);
    expect((await sessions.list()).map((session) => session.status)).toEqual(["cancelled"]);
    // This engine never opens an approval, so none may be left pending by a stop.
    expect(await sessions.listNeedsYou("pending")).toEqual([]);
    expect(await new ApprovalService(root).list()).toEqual([]);
    // The Agent API runs turns inside the shared Antigravity process, so DayCrew owns
    // only the short-lived `agentapi` child: none may be left behind, and the shared
    // process must survive.
    expect(languageServerPids()).toEqual(pidsBefore);
    expect(agentApiChildren()).toBe(0);
  });

  it("Test 8: completes a real tool-using task in a disposable folder", async () => {
    const root = await createFixture("daycrew-real-gemini-task-");
    await writeFile(path.join(root, "alpha.txt"), "count: 17\n", "utf8");
    await writeFile(path.join(root, "beta.txt"), "count: 25\n", "utf8");
    const handle = await new GeminiProvider({
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [root],
    }).startAgent({
      sessionId: "gemini-real-task",
      memberId: "manager",
      role: "Manager",
      instructions: "Use your file tools to inspect the Workspace before answering.",
      goal: "Read task",
      workspacePath: root,
      mode: "conversation",
    });
    await handle.send({
      type: "goal",
      text: "Read alpha.txt and beta.txt in this folder, add the two count values, and reply with exactly: TOTAL=<sum>",
    });
    const events = await collectUntilTerminal(handle.events[Symbol.asyncIterator]());
    await handle.stop();

    const text = events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");
    // Real tool use, and an answer only reachable by reading both planted files.
    expect(events.filter((event) => event.type === "tool_call").length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(text).toContain("TOTAL=42");
  });

  it("Test 9: enforces the consent and fail-closed gates DayCrew owns", async () => {
    const disposable = await createFixture("daycrew-real-gemini-gates-");
    const otherDisposable = await createFixture("daycrew-real-gemini-gates-other-");
    const spec = (workspacePath: string, model?: string) => ({
      sessionId: "gemini-gates",
      memberId: "manager",
      role: "Manager",
      instructions: "Answer briefly.",
      goal: "Gate check",
      workspacePath,
      ...(model === undefined ? {} : { model }),
    });

    // Consent: the preview cannot start at all without the explicit opt-in.
    await expect(new GeminiProvider().startAgent(spec(disposable))).rejects.toThrow(/unavailable by default/i);
    // A disposable folder is a convention, not filesystem isolation, but DayCrew still
    // refuses to point the preview anywhere outside one.
    await expect(
      new GeminiProvider({ allowUnsafeDisposableWorkspace: true }).startAgent(spec(process.cwd())),
    ).rejects.toThrow(/OS-temp disposable Workspace/i);
    await expect(
      new GeminiProvider({
        allowUnsafeDisposableWorkspace: true,
        allowedWorkspaceRoots: [otherDisposable],
      }).startAgent(spec(disposable)),
    ).rejects.toThrow(/outside the configured allowed roots/i);
    // A model the Agent API does not expose fails before any conversation is created.
    await expect(
      new GeminiProvider({
        allowUnsafeDisposableWorkspace: true,
        allowedWorkspaceRoots: [disposable],
      }).startAgent(spec(disposable, "gemini-4-ultra")),
    ).rejects.toThrow(/does not expose model/i);

    const provider = new GeminiProvider({
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [disposable],
    });
    const handle = await provider.startAgent(spec(disposable));
    // No approval path exists, so a decision is refused rather than silently granted.
    expect(provider.capabilities.approvals).toBe(false);
    await expect(
      handle.send({ type: "approval-decision", requestId: "approval-1", decision: "approved" }),
    ).rejects.toThrow(/no safe DayCrew approval bridge/i);
    await expect(
      handle.send({ type: "approval-decision", requestId: "approval-1", decision: "denied" }),
    ).rejects.toThrow(/no safe DayCrew approval bridge/i);
    await handle.stop();
    process.stdout.write(
      "SECURITY_RESULT antigravity_daycrew_gates=consent,os-temp-root,allowed-roots,model-tier,approval-fail-closed" +
        " antigravity_delegated_to_provider=writes,commands,network,paths-outside-folder\n",
    );
  });
});
