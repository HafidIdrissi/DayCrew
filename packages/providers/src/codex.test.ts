import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentEvent } from "@daycrew/shared";
import { afterEach, describe, expect, it } from "vitest";

import { CodexProvider, normalizeCodexJsonLine } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Signal 0 only reports whether the process still exists. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const eventually = async (check: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !check()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const spec = (workspacePath: string) => ({
  sessionId: "session-1",
  memberId: "manager",
  role: "Manager",
  instructions: "Coordinate the work.",
  goal: "Prepare a plan.",
  workspacePath,
});

describe("Codex JSONL normalization", () => {
  it("normalizes thread, structured task, usage, and tool events", () => {
    expect(
      normalizeCodexJsonLine(
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      ),
    ).toMatchObject({ threadId: "thread-1", events: [] });
    expect(
      normalizeCodexJsonLine(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item-1",
            type: "agent_message",
            text: JSON.stringify({
              summary: "Plan ready.",
              complete: false,
              tasks: [
                {
                  id: "task-plan",
                  title: "Plan endpoint",
                  description: "Plan the change.",
                  status: "todo",
                  ownerId: "developer",
                  dependsOn: [],
                  needsYou: false,
                },
              ],
            }),
          },
        }),
      ),
    ).toMatchObject({
      complete: false,
      events: [
        { type: "task_update", task: { id: "task-plan", ownerId: "developer" } },
        { type: "text", text: "Plan ready." },
      ],
    });
    expect(
      normalizeCodexJsonLine(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
      ),
    ).toMatchObject({
      turnCompleted: true,
      events: [{ type: "usage", usage: { inputTokens: 12, outputTokens: 7, costUsd: 0 } }],
    });
  });

  it("fails closed on invalid JSONL and file changes", () => {
    expect(normalizeCodexJsonLine("not-json").events[0]).toMatchObject({ type: "error" });
    expect(
      normalizeCodexJsonLine(
        JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "file_change" } }),
      ).events[0],
    ).toMatchObject({ type: "error", recoverable: false });
  });
});

describe("CodexProvider", () => {
  it("detects an authenticated CLI and streams only normalized events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-codex-unit-"));
    directories.push(root);
    const scriptPath = path.join(root, "fake-codex.mjs");
    await writeFile(
      scriptPath,
      `
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 1.2.3\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using test\\n");
  process.exit(0);
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes("force-error")) {
  process.stderr.write("controlled failure\\n");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: {
    id: "item-1",
    type: "agent_message",
    text: JSON.stringify({
      summary: "Plan ready.",
      complete: true,
      tasks: [{
        id: "task-plan",
        title: "Plan endpoint",
        description: "Plan only.",
        status: "todo",
        ownerId: "manager",
        dependsOn: [],
        needsYou: false
      }]
    })
  }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 7 } }) + "\\n");
`,
      "utf8",
    );
    const provider = new CodexProvider({
      command: [process.execPath, scriptPath],
      allowUnconfinedReads: true,
      allowedWorkspaceRoots: [root],
    });

    await expect(provider.detect()).resolves.toEqual({ available: true, installed: true, authenticated: true, version: "1.2.3" });
    const handle = await provider.startAgent(spec(root));
    await handle.send({ type: "goal", text: "Prepare the endpoint plan." });
    const iterator = handle.events[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === "done") break;
    }
    await handle.stop();

    expect(events).toEqual([
      {
        type: "task_update",
        task: {
          id: "task-plan",
          title: "Plan endpoint",
          description: "Plan only.",
          status: "todo",
          ownerId: "manager",
          dependsOn: [],
          needsYou: false,
        },
      },
      { type: "text", text: "Plan ready." },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 7, costUsd: 0 } },
      { type: "done" },
    ]);
  });

  it("keeps every turn inside the read-only launch policy", async () => {
    // The CLI enforces the sandbox, so DayCrew's guarantee is the argument list it passes.
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-codex-policy-"));
    directories.push(root);
    const scriptPath = path.join(root, "fake-codex.mjs");
    const argumentsPath = path.join(root, "arguments.json");
    await writeFile(
      scriptPath,
      `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 1.2.3\\n"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { process.stdout.write("Logged in using test\\n"); process.exit(0); }
writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args), "utf8");
for await (const chunk of process.stdin) void chunk;
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: JSON.stringify({ summary: "Done.", complete: true, tasks: [] }) } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
`,
      "utf8",
    );
    const handle = await new CodexProvider({
      command: [process.execPath, scriptPath],
      allowUnconfinedReads: true,
      allowedWorkspaceRoots: [root],
    }).startAgent(spec(root));
    await handle.send({ type: "goal", text: "Prepare the plan." });
    const iterator = handle.events[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done || next.value.type === "done") break;
    }
    await handle.stop();

    const passed = JSON.parse(await readFile(argumentsPath, "utf8")) as string[];
    expect(passed.slice(0, 4)).toEqual(["--sandbox", "read-only", "--ask-for-approval", "never"]);
    expect(passed).toEqual(expect.arrayContaining(["--ignore-user-config", "--ignore-rules"]));
    for (const forbidden of [
      "--add-dir",
      "--search",
      "--approve-for-me",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "--worktree",
      "workspace-write",
      "danger-full-access",
    ]) {
      expect(passed).not.toContain(forbidden);
    }
  });

  it("refuses an approval decision instead of answering the CLI for the user", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-codex-approval-"));
    directories.push(root);
    const scriptPath = path.join(root, "fake-codex.mjs");
    await writeFile(
      scriptPath,
      `
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 1.2.3\\n"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { process.stdout.write("Logged in using test\\n"); process.exit(0); }
process.exit(0);
`,
      "utf8",
    );
    const provider = new CodexProvider({
      command: [process.execPath, scriptPath],
      allowUnconfinedReads: true,
      allowedWorkspaceRoots: [root],
    });
    expect(provider.capabilities.approvals).toBe(false);
    const handle = await provider.startAgent(spec(root));
    for (const decision of ["approved", "denied"] as const) {
      await expect(handle.send({ type: "approval-decision", requestId: "approval-1", decision })).rejects.toThrow(
        /native approvals are not bridged/i,
      );
    }
    await handle.stop();
  });

  it("terminates the whole process tree it started when a turn is cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-codex-cancel-"));
    directories.push(root);
    const scriptPath = path.join(root, "fake-codex.mjs");
    const childPath = path.join(root, "fake-codex-child.mjs");
    const pidsPath = path.join(root, "pids.json");
    await writeFile(childPath, `setInterval(() => {}, 1000);\n`, "utf8");
    await writeFile(
      scriptPath,
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 1.2.3\\n"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { process.stdout.write("Logged in using test\\n"); process.exit(0); }
const child = spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ parent: process.pid, child: child.pid }), "utf8");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\\n");
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const handle = await new CodexProvider({
      command: [process.execPath, scriptPath],
      allowUnconfinedReads: true,
      allowedWorkspaceRoots: [root],
    }).startAgent(spec(root));
    await handle.send({ type: "goal", text: "Take a long time." });
    let pids: { parent: number; child: number } | undefined;
    for (let attempt = 0; attempt < 100 && pids === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      pids = await readFile(pidsPath, "utf8").then((text) => JSON.parse(text) as typeof pids).catch(() => undefined);
    }
    expect(pids).toBeDefined();
    expect(alive(pids!.parent)).toBe(true);
    expect(alive(pids!.child)).toBe(true);

    await handle.interrupt();
    const iterator = handle.events[Symbol.asyncIterator]();
    const cancellation = await iterator.next();
    expect(cancellation.value).toMatchObject({ type: "error", recoverable: true });
    // Cancellation must leave nothing running, including a grandchild the CLI spawned.
    await eventually(() => !alive(pids!.parent) && !alive(pids!.child));
    expect(alive(pids!.parent)).toBe(false);
    expect(alive(pids!.child)).toBe(false);
    await handle.stop();
  }, 60_000);

  it("refuses to start without the explicit unconfined-read opt-in", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-codex-closed-"));
    directories.push(root);
    await expect(new CodexProvider().startAgent(spec(root))).rejects.toThrow(
      "explicit isolated-workspace opt-in",
    );
  });
});
