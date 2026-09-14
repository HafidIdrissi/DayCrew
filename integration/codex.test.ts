import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { CodexProvider } from "@daycrew/providers";
import type { AgentEvent, ChatMessage } from "@daycrew/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  await writeFile(
    path.join(root, "README.md"),
    "# Safe integration fixture\n\nThis isolated project has no credentials and must not be modified.\n",
    "utf8",
  );
  return root;
};

const provider = (root: string) =>
  new CodexProvider({ allowUnconfinedReads: true, allowedWorkspaceRoots: [root] });

const nextEvent = async (
  iterator: AsyncIterator<AgentEvent>,
  timeoutMs = 15_000,
): Promise<IteratorResult<AgentEvent>> =>
  Promise.race([
    iterator.next(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for a Codex event")), timeoutMs),
    ),
  ]);

const collectUntilTerminal = async (
  iterator: AsyncIterator<AgentEvent>,
  timeoutMs = 180_000,
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = await nextEvent(iterator, Math.max(1, deadline - Date.now()));
    if (next.done) break;
    events.push(next.value);
    if (next.value.type === "done" || next.value.type === "turn_end" || next.value.type === "error") break;
  }
  return events;
};

/** Codex turns run in a DayCrew-owned child process tree, identified by its launch policy. */
const codexTurnPids = (): readonly number[] => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*codex*' -and $_.CommandLine -like '*--ask-for-approval*' } | ForEach-Object ProcessId) | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8" },
  );
  const text = result.stdout.trim();
  if (text === "") return [];
  const parsed: unknown = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter((pid) => Number.isFinite(pid));
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const chatWorkspace = async (name: string) => {
  const root = await createFixture("daycrew-real-codex-chat-");
  await new WorkspaceService(root).create(name);
  const team = await new TeamService(root).create({
    name: "Codex Chat",
    autonomy: "assist",
    members: [
      {
        id: "manager",
        name: "Ada",
        role: "Manager",
        instructions: "Answer briefly and factually.",
        isManager: true,
        engine: { mode: "manual", provider: "codex" },
      },
    ],
  });
  return { root, teamId: team.id, service: new ConversationService(root) };
};

const previewEngine = async () => {
  const disposable = await createFixture("daycrew-real-codex-chat-preview-");
  return { provider: provider(disposable), workspacePath: disposable };
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

/**
 * Codex authentication and quota are separate facts. `codex login status` can report a
 * signed-in account whose every turn is refused, so the turn-dependent tests below are
 * reported as blocked — never as passing — with the CLI's own message.
 */
let turnBlockedBy: string | undefined;
let toolTaskBlockedBy: string | undefined;

beforeAll(async () => {
  const root = await createFixture("daycrew-real-codex-probe-");
  const handle = await provider(root).startAgent({
    sessionId: "codex-probe",
    memberId: "manager",
    role: "Manager",
    instructions: "Answer with the shortest possible structured result.",
    goal: "Availability probe",
    workspacePath: root,
    mode: "conversation",
  });
  await handle.send({ type: "goal", text: "Reply with the single word OK." });
  const events = await collectUntilTerminal(handle.events[Symbol.asyncIterator](), 120_000);
  await handle.stop();
  const failure = events.find((event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error");
  if (failure) {
    turnBlockedBy = failure.message;
    process.stdout.write(`CODEX_TURNS_BLOCKED ${failure.message}\n`);
  }
}, 180_000);

describe("real Codex CLI", () => {
  it("reports a real installed, authenticated CLI and reads its live model catalogue", async () => {
    const root = await createFixture("daycrew-real-codex-detect-");
    const codex = provider(root);
    const detection = await codex.detect();
    expect(detection).toMatchObject({ available: true, installed: true, authenticated: true });
    expect(detection.version).toMatch(/^\d+\.\d+\.\d+/);
    // `installed` and `authenticated` are what the CLI reported; neither implies quota.
    const models = await codex.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) expect(model.id).toMatch(/^[A-Za-z0-9._:/-]+$/);
    process.stdout.write(
      `CODEX_REAL version=${detection.version} models=${models.map((model) => model.id).join(",")}\n`,
    );
  });

  it("enforces the consent and fail-closed gates DayCrew owns", async () => {
    const root = await createFixture("daycrew-real-codex-gates-");
    const otherRoot = await createFixture("daycrew-real-codex-gates-other-");
    const spec = (workspacePath: string) => ({
      sessionId: "codex-gates",
      memberId: "manager",
      role: "Manager",
      instructions: "Answer briefly.",
      goal: "Gate check",
      workspacePath,
    });

    // Consent: unconfined reads are an explicit opt-in, because Codex reports no
    // denied-read restrictions even in its read-only sandbox.
    await expect(new CodexProvider().startAgent(spec(root))).rejects.toThrow(
      /explicit isolated-workspace opt-in/i,
    );
    await expect(
      new CodexProvider({ allowUnconfinedReads: true, allowedWorkspaceRoots: [otherRoot] }).startAgent(spec(root)),
    ).rejects.toThrow(/outside the configured allowed roots/i);
    await expect(
      new CodexProvider({ allowUnconfinedReads: true }).startAgent(spec(path.parse(root).root)),
    ).rejects.toThrow(/filesystem root/i);

    const codex = provider(root);
    const handle = await codex.startAgent(spec(root));
    // No pre-execution approval bridge exists, so a decision is refused, never forwarded.
    expect(codex.capabilities.approvals).toBe(false);
    for (const decision of ["approved", "denied"] as const) {
      await expect(
        handle.send({ type: "approval-decision", requestId: "approval-1", decision }),
      ).rejects.toThrow(/native approvals are not bridged/i);
    }
    await handle.stop();
    process.stdout.write(
      "SECURITY_RESULT codex_daycrew_gates=consent,allowed-roots,no-filesystem-root,approval-fail-closed" +
        " codex_delegated_to_cli=read-only-sandbox,command-execution,network\n",
    );
  });

  it("characterises the CLI sandbox DayCrew delegates to, without a model turn", async () => {
    // `codex exec` turns are metered, but the sandbox they run in is not: this probes the
    // same `--sandbox read-only` policy through `codex sandbox`, so the boundary DayCrew
    // relies on can be checked even while turns are refused.
    const root = await createFixture("daycrew-real-codex-sandbox-");
    const outsideRoot = await createFixture("daycrew-real-codex-outside-");
    const marker = `OUTSIDE_MARKER_${Date.now()}`;
    await writeFile(path.join(outsideRoot, "outside.txt"), `${marker}\n`, "utf8");
    const probePath = path.join(root, "probe.ps1");
    await writeFile(
      probePath,
      [
        'try { Set-Content -Path "sandbox-write.txt" -Value "hello" -ErrorAction Stop; Write-Output "WRITE_OK" }',
        'catch { Write-Output ("WRITE_DENIED " + $_.Exception.GetType().Name) }',
        'try { $inside = Get-Content -Path "README.md" -Raw -ErrorAction Stop; Write-Output ("READ_INSIDE_OK len=" + $inside.Length) }',
        'catch { Write-Output ("READ_INSIDE_DENIED " + $_.Exception.GetType().Name) }',
        `try { $outside = Get-Content -Path ${JSON.stringify(path.join(outsideRoot, "outside.txt"))} -Raw -ErrorAction Stop; Write-Output ("READ_OUTSIDE_OK " + $outside.Trim()) }`,
        'catch { Write-Output ("READ_OUTSIDE_DENIED " + $_.Exception.GetType().Name) }',
        'try { $response = Invoke-WebRequest -Uri "http://example.com" -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop; Write-Output ("NET_OK " + $response.StatusCode) }',
        'catch { Write-Output ("NET_DENIED " + $_.Exception.GetType().Name) }',
      ].join("\n"),
      "utf8",
    );
    const probe = spawnSync(
      "codex",
      [
        "sandbox",
        "-c",
        'permissions.daycrew_readonly.sandbox_mode="read-only"',
        "-c",
        'permissions.daycrew_readonly.approval_policy="never"',
        "-P",
        "daycrew_readonly",
        "-C",
        // `shell: true` is needed for the `codex.cmd` shim, so the path is quoted here.
        `"${root}"`,
        "--",
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "probe.ps1",
      ],
      { encoding: "utf8", shell: true, timeout: 180_000 },
    );
    const observed = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    process.stdout.write(`CODEX_SANDBOX ${JSON.stringify(observed.trim())}\n`);

    // The CLI sandbox denies the write and the network. That denial is Codex's, not
    // DayCrew's, and it says nothing about reads.
    expect(observed).toContain("WRITE_DENIED");
    expect(existsSync(path.join(root, "sandbox-write.txt"))).toBe(false);
    expect(observed).toContain("NET_DENIED");
    expect(observed).toContain("READ_INSIDE_OK");
    // The disposable folder is a convention, not isolation: a read outside it succeeds,
    // which is exactly why `allowUnconfinedReads` has to be an explicit opt-in.
    expect(observed).toContain("READ_OUTSIDE_OK");
    expect(observed).toContain(marker);
    process.stdout.write(
      "SECURITY_RESULT codex_sandbox_write_denied=true codex_sandbox_network_denied=true" +
        " codex_sandbox_outside_read_denied=false enforced_by=codex-cli\n",
    );
  }, 300_000);

  it("keeps chat context across two real turns of a DayCrew conversation", async (context) => {
    if (turnBlockedBy) return context.skip();
    const { teamId, service } = await chatWorkspace("Codex chat context");
    await service.send(
      teamId,
      "dm-manager",
      "Remember this build code: ZEBRA-4417. Just acknowledge it.",
      undefined,
      previewEngine,
    );
    const first = await settledReply(service, teamId, 1);
    expect(first.status, first.notice).toBe("complete");
    expect(first.provider).toBe("codex");

    await service.send(
      teamId,
      "dm-manager",
      "What was the build code I gave you? Answer with the code only.",
      undefined,
      previewEngine,
    );
    const second = await settledReply(service, teamId, 3);
    await service.close();

    // Every chat turn starts a fresh Codex thread, so this proves DayCrew's own bounded
    // history reached the CLI, not that Codex remembered.
    expect(second.status, second.notice).toBe("complete");
    expect(second.text).toContain("ZEBRA-4417");
  });

  it("continues the same real Codex thread across two turns", async (context) => {
    if (turnBlockedBy) return context.skip();
    const root = await createFixture("daycrew-real-codex-resume-");
    const handle = await provider(root).startAgent({
      sessionId: "codex-continuation",
      memberId: "manager",
      role: "Manager",
      instructions: "Answer briefly, with tasks=[] and complete=true.",
      goal: "Continuation test",
      workspacePath: root,
      mode: "conversation",
    });
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "Remember this build code: ZEBRA-4417. Acknowledge it." });
    const first = await collectUntilTerminal(iterator);
    const threadId = handle.getSessionIdentity?.();
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.some((event) => event.type === "done" || event.type === "turn_end")).toBe(true);

    await handle.send({
      type: "goal",
      text: "What was the build code I gave you earlier? Reply with the code only.",
    });
    const second = await collectUntilTerminal(iterator);
    await handle.stop();
    // `codex exec resume` kept the thread, so the code came back without DayCrew resending it.
    expect(handle.getSessionIdentity?.()).toBe(threadId);
    expect(second.flatMap((event) => (event.type === "text" ? [event.text] : [])).join(" ")).toContain(
      "ZEBRA-4417",
    );
  });

  it("completes a real tool-using task in a disposable folder", async (context) => {
    if (turnBlockedBy) return context.skip();
    const root = await createFixture("daycrew-real-codex-task-");
    await writeFile(path.join(root, "alpha.txt"), "count: 17\n", "utf8");
    await writeFile(path.join(root, "beta.txt"), "count: 25\n", "utf8");
    const handle = await provider(root).startAgent({
      sessionId: "codex-real-task",
      memberId: "manager",
      role: "Manager",
      instructions: "Inspect the Workspace with your own tools before answering.",
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

    const toolCalls = events.filter((event) => event.type === "tool_call");
    const hasToolResult = events.some((event) => event.type === "tool_result");
    const answer = events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");
    if (toolCalls.length === 0 || !hasToolResult) {
      toolTaskBlockedBy = answer || "Codex emitted no tool events under the DayCrew launch policy";
      process.stdout.write(`CODEX_TOOL_TASK_BLOCKED ${JSON.stringify(toolTaskBlockedBy)}\n`);
      return context.skip();
    }

    // Real tool use, and an answer only reachable by reading both planted files.
    expect(answer).toContain("TOTAL=42");
  });

  it("sees the Codex CLI refuse a write inside the read-only sandbox DayCrew asks for", async (context) => {
    if (turnBlockedBy) return context.skip();
    const root = await createFixture("daycrew-real-codex-write-");
    const helloPath = path.join(root, "hello.txt");
    const handle = await provider(root).startAgent({
      sessionId: "codex-write-restriction",
      memberId: "manager",
      role: "Manager",
      instructions:
        "Attempt the requested action once. If the environment refuses it, do not retry and finish safely.",
      goal: "Write restriction",
      workspacePath: root,
      mode: "conversation",
    });
    await handle.send({
      type: "goal",
      text: "Create hello.txt containing hello in this folder. If it is refused, say so and finish.",
    });
    const events = await collectUntilTerminal(handle.events[Symbol.asyncIterator]());
    await handle.stop();

    // This denial belongs to the Codex CLI sandbox, not to DayCrew, and it says nothing
    // about reads: the same sandbox reports no denied-read restrictions.
    expect(existsSync(helloPath)).toBe(false);
    process.stdout.write(
      `SECURITY_RESULT codex_write_file_created=false enforced_by=codex-cli-read-only-sandbox` +
        ` events=${events.map((event) => event.type).join(",")}\n`,
    );
  });

  it("cancels a live turn, kills its process tree, and leaves no orphan approval", async (context) => {
    if (turnBlockedBy) return context.skip();
    const root = await createFixture("daycrew-real-codex-cancel-");
    await new WorkspaceService(root).create("Codex cancel");
    const handle = await provider(root).startAgent({
      sessionId: "codex-cancel",
      memberId: "manager",
      role: "Manager",
      instructions: "Think carefully and answer at length.",
      goal: "Cancellation test",
      workspacePath: root,
      mode: "conversation",
    });
    await handle.send({
      type: "goal",
      text: "Write an extremely detailed plan with at least 100 numbered sections. Do not use tools.",
    });
    let pids: readonly number[] = [];
    for (let attempt = 0; attempt < 60 && pids.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pids = codexTurnPids();
    }
    expect(pids.length).toBeGreaterThan(0);

    await handle.interrupt();
    const cancelled = await nextEvent(handle.events[Symbol.asyncIterator]());
    expect(cancelled.value).toMatchObject({ type: "error", recoverable: true });
    for (const pid of pids) expect(alive(pid)).toBe(false);
    await handle.stop();

    // This engine never opens an approval, so a cancellation may not leave one behind.
    expect(await new ApprovalService(root).list()).toEqual([]);
    expect(await new WorkSessionService(root).listNeedsYou("pending")).toEqual([]);
    process.stdout.write(`CODEX_CANCEL killed=${pids.join(",")}\n`);
  }, 240_000);

  it("orchestrates a Manager and Member through core, and surfaces a controlled failure", async (context) => {
    if (turnBlockedBy) return context.skip();
    const root = await createFixture("daycrew-real-codex-orchestration-");
    await new WorkspaceService(root).create("Codex Integration");
    const team = await new TeamService(root).create({
      name: "Codex Planning",
      autonomy: "assist",
      members: [
        {
          id: "manager",
          name: "Planning Manager",
          role: "Manager",
          instructions:
            "For a new goal, create exactly one todo task with id hello-plan owned by planner and complete=false. For a returned result, mark hello-plan done and complete=true.",
          isManager: true,
          engine: { mode: "manual", provider: "codex" },
        },
        {
          id: "planner",
          name: "Implementation Planner",
          role: "Implementation planning",
          instructions:
            "Create a short implementation plan without modifying files. Update the supplied task id to review and complete=true.",
          isManager: false,
          engine: { mode: "manual", provider: "codex" },
        },
      ],
    });
    const codex = provider(root);
    const result = await new ManagerOrchestrator(root, {
      providers: new Map([[codex.id, codex]]),
      defaultProvider: codex.id,
    }).runGoal(
      team.id,
      "Create a short implementation plan for adding a /hello endpoint to this test project.",
    );

    expect(result.session.status).toBe("completed");
    expect(result.tasks).toMatchObject([{ id: "hello-plan", ownerId: "planner", status: "done" }]);
    expect(result.session.usage.inputTokens + result.session.usage.outputTokens).toBeGreaterThan(0);
    const activity = await new ActivityService(root).list(result.session.id);
    expect(activity.some((event) => event.kind === "member.text")).toBe(true);
    expect(activity.some((event) => event.kind === "usage.updated")).toBe(true);
    expect(activity.some((event) => event.kind === "session.completed")).toBe(true);

    const failing = await codex.startAgent({
      sessionId: "session-error",
      memberId: "manager",
      role: "Manager",
      instructions: "Return the requested structured result.",
      goal: "Error test",
      workspacePath: root,
      model: "daycrew-intentionally-invalid-model",
    });
    await failing.send({ type: "goal", text: "Return an empty plan." });
    const events = await collectUntilTerminal(failing.events[Symbol.asyncIterator](), 60_000);
    expect(events.at(-1)).toMatchObject({ type: "error", recoverable: false });
    await failing.stop();
  }, 600_000);

  it("records whether real Codex turns could run at all", () => {
    // Deliberately last: it states the observed fact instead of hiding a blocked engine.
    if (turnBlockedBy) {
      process.stdout.write(`CODEX_STATUS turns=blocked reason=${JSON.stringify(turnBlockedBy)}\n`);
      expect(turnBlockedBy).toEqual(expect.any(String));
      return;
    }
    process.stdout.write(
      `CODEX_STATUS turns=verified tool_task=${toolTaskBlockedBy ? "blocked" : "verified"}` +
        `${toolTaskBlockedBy ? ` reason=${JSON.stringify(toolTaskBlockedBy)}` : ""}\n`,
    );
    expect(turnBlockedBy).toBeUndefined();
  });
});
