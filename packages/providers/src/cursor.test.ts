import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CursorProvider,
  normalizeCursorStreamLine,
  parseCursorModels,
  pickLatestCursorVersion,
  redactCursorSecrets,
  resolveCursorCommand,
} from "./cursor.js";
import type { AgentEvent } from "@daycrew/shared";

const directories: string[] = [];
afterEach(async () => {
  // Windows can still hold a just-exited child's cwd for a moment.
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

const temporary = async (prefix: string) => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(root);
  return root;
};

/**
 * A Node script on disk stands in for `cursor-agent`, so the suite proves the
 * argument list and the stream parsing without installing the CLI or making a paid
 * request. It must be a real file rather than `node -e`: an inline script would let
 * Node consume flags such as `--print` that belong to the command under test.
 */
const writeStub = async (body: string): Promise<[string, ...string[]]> => {
  const directory = await temporary("daycrew-cursor-stub-");
  const file = path.join(directory, "stub.cjs");
  await writeFile(file, body, "utf8");
  return [process.execPath, file];
};

const readyStub = (streamLines: readonly string[] = [], argvDump?: string) => writeStub(`
  const args = process.argv.slice(2);
  if (args.includes("--version")) { process.stdout.write("2026.9.1\\n"); process.exit(0); }
  if (args.includes("status")) { process.stdout.write("Logged in as qa@example.test\\n"); process.exit(0); }
  if (args.includes("models")) { process.stdout.write("composer-1\\ngpt-5\\n"); process.exit(0); }
  const dump = ${JSON.stringify(argvDump ?? "")};
  if (dump) require("fs").writeFileSync(dump, JSON.stringify(args));
  process.stdout.write(${JSON.stringify(streamLines.join("\n") + (streamLines.length ? "\n" : ""))});
  process.exit(0);
`);

const drain = async (events: AsyncIterable<AgentEvent>, until: AgentEvent["type"][]): Promise<AgentEvent[]> => {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (until.includes(event.type)) break;
  }
  return collected;
};

const spec = (root: string, extra: Record<string, unknown> = {}) => ({
  sessionId: "session-1",
  memberId: "dev",
  role: "Developer",
  instructions: "Implement carefully.",
  goal: "Ship the feature",
  workspacePath: root,
  ...extra,
});

describe("Cursor CLI detection", () => {
  it("separates installed from signed in, and reports both when ready", async () => {
    const provider = new CursorProvider({ command: await readyStub() });
    await expect(provider.detect()).resolves.toEqual({
      available: true, installed: true, authenticated: true, version: "2026.9.1",
    });
  });

  it("reports an installed but signed-out CLI without claiming it is missing", async () => {
    const provider = new CursorProvider({ command: await writeStub(`
      const args = process.argv.slice(2);
      if (args.includes("--version")) { process.stdout.write("2026.9.1\\n"); process.exit(0); }
      process.stdout.write("Not logged in. Run 'cursor-agent login'.\\n");
      process.exit(1);
    `) });
    const detection = await provider.detect();
    expect(detection).toMatchObject({ available: false, installed: true, authenticated: false });
    expect(detection.reason).toContain("login");
  });

  it("leaves sign-in unknown when `status` fails without a recognizable reason", async () => {
    const provider = new CursorProvider({ command: await writeStub(`
      const args = process.argv.slice(2);
      if (args.includes("--version")) { process.stdout.write("2026.9.1\\n"); process.exit(0); }
      process.stderr.write("network unreachable\\n");
      process.exit(3);
    `) });
    const detection = await provider.detect();
    expect(detection.available).toBe(false);
    expect(detection.installed).toBe(true);
    // A failed check is not proof of being signed out.
    expect(detection.authenticated).toBeUndefined();
  });

  it("reports a missing executable as not installed, and any other failure as unknown", async () => {
    const missing = await new CursorProvider({ command: ["daycrew-cursor-does-not-exist"] }).detect();
    expect(missing).toMatchObject({ available: false, installed: false });
    expect(missing.reason).toContain("not found");
    expect(missing.authenticated).toBeUndefined();
  });

  it("lists the models the signed-in account may use", async () => {
    const provider = new CursorProvider({ command: await readyStub() });
    await expect(provider.listModels()).resolves.toEqual([
      { id: "composer-1", label: "composer-1" },
      { id: "gpt-5", label: "gpt-5" },
    ]);
  });
});

describe("Cursor CLI execution", () => {
  it("passes the selected model, never bypasses permissions, and writes a deny-first policy", async () => {
    const root = await temporary("daycrew-cursor-");
    const dump = path.join(root, "argv.json");
    const provider = new CursorProvider({
      command: await readyStub([
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reviewed."}]},"session_id":"chat-1"}',
        '{"type":"result","subtype":"success","is_error":false,"result":"Reviewed.","session_id":"chat-1"}',
      ], dump),
      allowUnconfinedReads: true,
      allowedWorkspaceRoots: [root],
    });
    const handle = await provider.startAgent(spec(root, { model: "composer-1", mode: "conversation" }));
    await handle.send({ type: "goal", text: "Review this" });
    const events = await drain(handle.events, ["done", "error"]);
    expect(events.find((event) => event.type === "text")).toMatchObject({ text: "Reviewed." });
    expect(events.at(-1)?.type).toBe("done");

    const argv: string[] = JSON.parse(await readFile(dump, "utf8"));
    // The chosen model actually reaches the CLI through its documented flag.
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("composer-1");
    expect(argv).toContain("--print");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    // DayCrew must never weaken the CLI's own permission rules.
    expect(argv).not.toContain("--force");
    expect(argv).not.toContain("--yolo");
    expect(argv).not.toContain("--api-key");

    const policy = JSON.parse(await readFile(path.join(root, ".cursor", "cli.json"), "utf8"));
    expect(policy.permissions.deny).toContain("Shell(*)");
    expect(policy.permissions.deny).toContain("Write(**)");
    await handle.stop();
  });

  it("omits --model when the agent uses the CLI default, and resumes its own chat id", async () => {
    const root = await temporary("daycrew-cursor-");
    const dump = path.join(root, "argv.json");
    const provider = new CursorProvider({
      command: await readyStub(['{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"chat-2"}'], dump),
      allowUnconfinedReads: true,
      allowedWorkspaceRoots: [root],
    });
    const handle = await provider.startAgent(spec(root, { mode: "conversation" }));
    await handle.send({ type: "goal", text: "Hello" });
    await drain(handle.events, ["done", "error"]);
    expect(JSON.parse(await readFile(dump, "utf8"))).not.toContain("--model");
    expect(handle.getSessionIdentity?.()).toBe("chat-2");

    // send() only starts the turn, so wait for it to finish before reading the dump.
    await handle.send({ type: "goal", text: "Follow up" });
    await drain(handle.events, ["done", "error"]);
    const second: string[] = JSON.parse(await readFile(dump, "utf8"));
    expect(second[second.indexOf("--resume") + 1]).toBe("chat-2");
    await handle.stop();
  });

  it("fails closed without the isolated-workspace opt-in and on an approval decision", async () => {
    const root = await temporary("daycrew-cursor-");
    await expect(new CursorProvider({ command: await readyStub() }).startAgent(spec(root)))
      .rejects.toThrow(/isolated-workspace opt-in/);
    const provider = new CursorProvider({ command: await readyStub(), allowUnconfinedReads: true, allowedWorkspaceRoots: [root] });
    const handle = await provider.startAgent(spec(root));
    await expect(handle.send({ type: "approval-decision", requestId: "request-1", decision: "approved" }))
      .rejects.toThrow(/approvals are not bridged/);
    await handle.stop();
  });

  it("refuses a Workspace outside the configured allowed roots", async () => {
    const outside = await temporary("daycrew-cursor-");
    const allowed = await temporary("daycrew-cursor-");
    const provider = new CursorProvider({ command: await readyStub(), allowUnconfinedReads: true, allowedWorkspaceRoots: [allowed] });
    await expect(provider.startAgent(spec(outside))).rejects.toThrow(/outside the configured allowed roots/);
  });

  it("advertises no approval bridge, so DayCrew never treats it as actionable", () => {
    const provider = new CursorProvider();
    expect(provider.capabilities.approvals).toBe(false);
    expect(provider.capabilities.skillCapabilities).toEqual(["filesystem.read"]);
    expect(provider.security.nativeApprovalBridge).toBe(false);
    expect(provider.security.writesAllowed).toBe(false);
  });
});

describe("Cursor CLI resolution on Windows", () => {
  it("picks the newest versioned install, in both documented directory shapes", () => {
    expect(pickLatestCursorVersion(["2026.09.10-fd3934a", "2026.1.2-aaaa", "2026.09.09-bbbb"]))
      .toBe("2026.09.10-fd3934a");
    expect(pickLatestCursorVersion(["2026.09.10-12-30-00-fd3934a", "2026.08.01-aaaa"]))
      .toBe("2026.09.10-12-30-00-fd3934a");
    expect(pickLatestCursorVersion(["not-a-version", "README.md"])).toBeUndefined();
    expect(pickLatestCursorVersion([])).toBeUndefined();
  });

  it("runs the bundled node entry point rather than the .cmd shim", async () => {
    // Regression: Node refuses to spawn a .cmd without a shell (EINVAL), and the
    // Windows Cursor installer ships exactly that shim. Resolution must reach the
    // vendor's own `node.exe index.js` instead, so no shell ever re-parses a prompt.
    const home = await temporary("daycrew-cursor-install-");
    const install = path.join(home, "cursor-agent");
    const version = path.join(install, "versions", "2026.09.10-fd3934a");
    await mkdir(version, { recursive: true });
    for (const file of [
      path.join(install, "cursor-agent.cmd"),
      path.join(version, "node.exe"),
      path.join(version, "index.js"),
    ]) await writeFile(file, "stub", "utf8");

    const previous = process.env["LOCALAPPDATA"];
    const previousPath = process.env["PATH"];
    const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    process.env["LOCALAPPDATA"] = home;
    process.env["PATH"] = "";
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const resolved = await resolveCursorCommand();
      expect(resolved.executable).toBe(path.join(version, "node.exe"));
      expect(resolved.prefixArguments).toEqual([path.join(version, "index.js")]);
      expect(resolved.executable.endsWith(".cmd")).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", previousPlatform);
      if (previous === undefined) delete process.env["LOCALAPPDATA"]; else process.env["LOCALAPPDATA"] = previous;
      if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
    }
  });

  it("honours an explicit binary override without touching the filesystem", async () => {
    const previous = process.env["DAYCREW_CURSOR_BINARY"];
    process.env["DAYCREW_CURSOR_BINARY"] = "/opt/cursor-agent";
    try {
      await expect(resolveCursorCommand()).resolves.toEqual({ executable: "/opt/cursor-agent", prefixArguments: [] });
    } finally {
      if (previous === undefined) delete process.env["DAYCREW_CURSOR_BINARY"]; else process.env["DAYCREW_CURSOR_BINARY"] = previous;
    }
  });
});

describe("Cursor stream normalization", () => {
  const line = (value: unknown) => JSON.stringify(value);

  it("maps documented stream-json records onto DayCrew events", () => {
    expect(normalizeCursorStreamLine(line({ type: "system", subtype: "init", session_id: "s1" })))
      .toEqual({ events: [], sessionId: "s1" });
    expect(normalizeCursorStreamLine(line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] }, session_id: "s1" })))
      .toMatchObject({ events: [{ type: "text", text: "Hi" }], assistantText: "Hi" });
    expect(normalizeCursorStreamLine(line({ type: "tool_call", subtype: "started", call_id: "Call_1", tool_call: { readToolCall: { args: { path: "a.txt" } } }, session_id: "s1" })))
      .toMatchObject({ events: [{ type: "tool_call", callId: "call-1", name: "readToolCall" }] });
    expect(normalizeCursorStreamLine(line({ type: "result", subtype: "success", is_error: false, result: "All done", session_id: "s1" })))
      .toMatchObject({ finished: true, assistantText: "All done" });
  });

  it("treats the echoed user turn as noise and a failed result as an error", () => {
    expect(normalizeCursorStreamLine(line({ type: "user", message: { role: "user", content: [{ type: "text", text: "prompt" }] } })).events).toEqual([]);
    const failed = normalizeCursorStreamLine(line({ type: "result", subtype: "error", is_error: true, result: "boom", session_id: "s1" }));
    expect(failed.failed).toBe(true);
    expect(failed.events.at(-1)).toMatchObject({ type: "error" });
  });

  it("reports malformed output instead of crashing the turn", () => {
    expect(normalizeCursorStreamLine("not json").events[0]).toMatchObject({ type: "error" });
    expect(normalizeCursorStreamLine("[1,2,3]").events[0]).toMatchObject({ type: "error" });
  });

  it("parses a model list without inventing identifiers", () => {
    expect(parseCursorModels("Available models:\n* composer-1\n  gpt-5  (default)\n\n")).toEqual([
      { id: "composer-1", label: "composer-1" },
      { id: "gpt-5", label: "gpt-5" },
    ]);
    expect(parseCursorModels("")).toEqual([]);
  });

  it("redacts tokens that would otherwise reach DayCrew state", () => {
    expect(redactCursorSecrets("token key_abcdefghijklmnopqr here")).toBe("token [redacted] here");
    expect(redactCursorSecrets("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: [redacted]");
  });
});
