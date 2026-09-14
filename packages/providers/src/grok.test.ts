import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentEvent } from "@daycrew/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  GrokProvider,
  normalizeGrokStreamLine,
  parseGrokModels,
  redactGrokSecrets,
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const temporary = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-grok-"));
  directories.push(root);
  return root;
};

const spec = (workspacePath: string, model?: string) => ({
  sessionId: "session-1",
  memberId: "manager",
  role: "Manager",
  instructions: "Answer briefly.",
  goal: "Review the project.",
  workspacePath,
  mode: "conversation" as const,
  ...(model ? { model } : {}),
});

const drain = async (iterator: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
    if (next.value.type === "done" || next.value.type === "error") return events;
  }
};

const stub = async (root: string, body: string): Promise<readonly [string, string]> => {
  const script = path.join(root, "fake-grok.mjs");
  await writeFile(
    script,
    `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("grok 1.0.30 (test)\\n"); process.exit(0); }
if (args[0] === "models") { process.stdout.write("Default model: grok-4.6\\nAvailable models:\\n  * grok-4.6 (default)\\n  - grok-4.5\\n"); process.exit(0); }
${body}
`,
    "utf8",
  );
  return [process.execPath, script];
};

describe("Grok streaming-json normalization", () => {
  it("maps text, tools, usage and the terminal session id", () => {
    expect(normalizeGrokStreamLine(JSON.stringify({ type: "text", data: "Hello" })))
      .toMatchObject({ events: [{ type: "text", text: "Hello" }], assistantText: "Hello" });
    expect(normalizeGrokStreamLine(JSON.stringify({
      type: "tool_call",
      toolCallId: "Call_1",
      title: "Read",
      toolName: "read_file",
      rawInput: { path: "README.md" },
    }))).toMatchObject({
      events: [{ type: "tool_call", callId: "call-1", name: "read_file", input: { path: "README.md" } }],
    });
    expect(normalizeGrokStreamLine(JSON.stringify({
      type: "tool_call_update",
      toolCallId: "Call_1",
      status: "completed",
      rawOutput: { lines: 4 },
    }))).toMatchObject({ events: [{ type: "tool_result", callId: "call-1", output: { lines: 4 } }] });
    expect(normalizeGrokStreamLine(JSON.stringify({
      type: "usage",
      usage: { input_tokens: 12, output_tokens: 7 },
    }))).toMatchObject({ events: [{ type: "usage", usage: { inputTokens: 12, outputTokens: 7, costUsd: 0 } }] });
    expect(normalizeGrokStreamLine(JSON.stringify({ type: "end", sessionId: "grok-session" })))
      .toEqual({ events: [], finished: true, sessionId: "grok-session" });
  });

  it("fails closed on malformed output and redacts credentials", () => {
    expect(normalizeGrokStreamLine("not-json")).toMatchObject({ failed: true, events: [{ type: "error" }] });
    expect(normalizeGrokStreamLine(JSON.stringify({ type: "error", message: "Bearer abcdefghijklmnop" })))
      .toMatchObject({ failed: true, events: [{ type: "error", message: "[redacted]" }] });
    expect(redactGrokSecrets("xai-abcdefghijklmnopqr")).toBe("[redacted]");
  });

  it("parses the installed catalogue without mistaking headings for models", () => {
    expect(parseGrokModels("You are not authenticated.\nDefault model: grok-4.6\nAvailable models:\n * grok-4.6 (default)\n - grok-4.5\n"))
      .toEqual([{ id: "grok-4.6", label: "grok-4.6" }, { id: "grok-4.5", label: "grok-4.5" }]);
  });
});

describe("GrokProvider", () => {
  it("distinguishes an installed but signed-out CLI and still lists its models", async () => {
    const root = await temporary();
    const command = await stub(root, "");
    const script = command[1];
    await writeFile(
      script,
      `
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("grok 1.0.30 (test)\\n"); process.exit(0); }
if (args[0] === "models") { process.stdout.write("You are not authenticated.\\nAvailable models:\\n * grok-4.6 (default)\\n - grok-4.5\\n"); process.exit(0); }
`,
      "utf8",
    );
    const provider = new GrokProvider({ command });
    await expect(provider.detect()).resolves.toMatchObject({
      available: false,
      installed: true,
      authenticated: false,
      version: "1.0.30",
      reason: expect.stringMatching(/login --device-code/),
    });
    await expect(provider.listModels()).resolves.toEqual([
      { id: "grok-4.6", label: "grok-4.6" },
      { id: "grok-4.5", label: "grok-4.5" },
    ]);
  });

  it("streams normalized events under the exact read-only policy and resumes its session", async () => {
    const root = await temporary();
    const dump = path.join(root, "argv.json");
    const command = await stub(root, `
writeFileSync(${JSON.stringify(dump)}, JSON.stringify(args));
process.stdout.write(JSON.stringify({ type: "text", data: "Reviewed." }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_call", toolCallId: "call_1", toolName: "read_file", rawInput: { path: "README.md" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_call_update", toolCallId: "call_1", status: "completed", rawOutput: "ok" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "usage", usage: { input_tokens: 3, output_tokens: 2 } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "end", sessionId: "grok-session-1" }) + "\\n");
`);
    const provider = new GrokProvider({
      command,
      allowUnconfinedReads: true,
      allowedWorkspaceRoots: [root],
    });
    const handle = await provider.startAgent(spec(root, "grok-4.6"));
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "Review it" });
    const first = await drain(iterator);
    expect(first.map((event) => event.type)).toEqual(["text", "tool_call", "tool_result", "usage", "done"]);
    expect(handle.getSessionIdentity?.()).toBe("grok-session-1");

    const arguments_: string[] = JSON.parse(await readFile(dump, "utf8"));
    expect(arguments_).toEqual(expect.arrayContaining([
      "--output-format", "streaming-json",
      "--permission-mode", "dontAsk",
      "--sandbox", "read-only",
      "--tools", "Read,Grep,Glob",
      "--disable-web-search",
      "--no-subagents",
      "--model", "grok-4.6",
    ]));
    expect(arguments_).not.toContain("--always-approve");
    expect(arguments_).not.toContain("bypassPermissions");

    await handle.send({ type: "goal", text: "Continue" });
    await drain(iterator);
    const resumed: string[] = JSON.parse(await readFile(dump, "utf8"));
    expect(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2))
      .toEqual(["--resume", "grok-session-1"]);
    await handle.stop();
  });

  it("requires explicit consent, enforces allowed roots and refuses approval decisions", async () => {
    const root = await temporary();
    const other = await temporary();
    const command = await stub(root, "setInterval(() => {}, 1000);");
    await expect(new GrokProvider({ command }).startAgent(spec(root))).rejects.toThrow(/explicit isolated-workspace opt-in/i);
    await expect(new GrokProvider({ command, allowUnconfinedReads: true, allowedWorkspaceRoots: [other] }).startAgent(spec(root)))
      .rejects.toThrow(/outside the configured allowed roots/i);

    const provider = new GrokProvider({ command, allowUnconfinedReads: true, allowedWorkspaceRoots: [root] });
    const handle = await provider.startAgent(spec(root));
    await expect(handle.send({ type: "approval-decision", requestId: "approval-1", decision: "approved" }))
      .rejects.toThrow(/approvals are not bridged/i);
    expect(provider.capabilities.approvals).toBe(false);
    expect(provider.security.writesAllowed).toBe(false);
    await handle.stop();
  });

  it("cancels the owned headless process and emits a recoverable event", async () => {
    const root = await temporary();
    const command = await stub(root, "setInterval(() => {}, 1000);");
    const handle = await new GrokProvider({ command, allowUnconfinedReads: true, allowedWorkspaceRoots: [root] })
      .startAgent(spec(root));
    await handle.send({ type: "goal", text: "Wait" });
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.interrupt();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "error", recoverable: true },
    });
    await handle.stop();
  });
});
