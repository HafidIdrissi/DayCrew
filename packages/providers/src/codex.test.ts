import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentEvent } from "@daycrew/shared";
import { afterEach, describe, expect, it } from "vitest";

import { CodexProvider, normalizeCodexJsonLine } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

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

    await expect(provider.detect()).resolves.toEqual({ available: true, version: "1.2.3" });
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

  it("refuses to start without the explicit unconfined-read opt-in", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-codex-closed-"));
    directories.push(root);
    await expect(new CodexProvider().startAgent(spec(root))).rejects.toThrow(
      "explicit isolated-workspace opt-in",
    );
  });
});
