import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentEvent, ApprovalRequest } from "@daycrew/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  ClaudeCodeProvider,
  classifyClaudeToolUse,
  normalizeClaudeStreamMessage,
  redactSecrets,
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

const spec = (workspacePath: string) => ({
  sessionId: "session-1",
  memberId: "developer",
  role: "Developer",
  instructions: "Do the work.",
  goal: "Add a hello file.",
  workspacePath,
});

const decisionLog = (workspace: string): string => path.join(workspace, ".fake-decisions.log");

/**
 * A scripted Claude Code CLI speaking the real stream-json control protocol.
 * It reads nothing from the environment, because the adapter sanitizes it.
 */
const fakeCliSource = `
import { createInterface } from "node:readline";
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.266 (Claude Code)\\n");
  process.exit(0);
}
if (args.includes("auth") && args.includes("status")) {
  const loggedIn = !args.includes("--fake-logged-out");
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: "claude.ai", email: "someone@example.com" }));
  process.exit(0);
}

const log = path.join(process.cwd(), ".fake-decisions.log");
const outsideFile = path.resolve(process.cwd(), "..", "daycrew-fake-outside.txt");
const helloFile = path.join(process.cwd(), "hello.txt");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const record = (entry) => {
  appendFileSync(log, JSON.stringify(entry) + "\\n");
};

send({
  type: "system",
  subtype: "init",
  session_id: "fake-session-1",
  cwd: process.cwd(),
  tools: ["Read", "Write", "Bash"],
  mcp_servers: [],
});

let pendingWrite = false;
const result = (structured) =>
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.25,
    usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 },
    result: JSON.stringify(structured),
  });

createInterface({ input: process.stdin }).on("line", (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }

  if (value.type === "control_response") {
    const decision = value.response?.response?.behavior;
    record({ kind: "decision", behavior: decision, message: value.response?.response?.message ?? null });
    if (pendingWrite && decision === "allow") writeFileSync(helloFile, "hello from claude\\n");
    pendingWrite = false;
    send({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_ABC123",
            content: decision === "allow" ? "written" : "denied",
            is_error: decision !== "allow",
          },
        ],
      },
    });
    result({
      summary: decision === "allow" ? "Created hello.txt." : "The action was denied.",
      complete: true,
      tasks: [],
    });
    return;
  }

  if (value.type !== "user") return;
  const text = String(value.message?.content ?? "");

  if (text.includes("write-hello")) {
    pendingWrite = true;
    const input = { file_path: helloFile, content: "hello from claude\\n" };
    send({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_ABC123", name: "Write", input }] },
    });
    send({ type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Write", input } });
    return;
  }
  if (text.includes("escape-workspace")) {
    send({
      type: "control_request",
      request_id: "req-2",
      request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: outsideFile } },
    });
    return;
  }
  if (text.includes("plain-plan")) {
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Here is the plan." }] } });
    result({
      summary: "Plan ready.",
      complete: false,
      tasks: [
        {
          id: "hello-plan",
          title: "Plan endpoint",
          description: "Plan it.",
          status: "todo",
          ownerId: "developer",
          dependsOn: [],
          needsYou: false,
        },
      ],
    });
    return;
  }
  if (text.includes("leak-secret")) {
    send({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "found sk-ant-api03-abcdefghijklmnop" }] },
    });
    result({ summary: "Done.", complete: true, tasks: [] });
    if (existsSync(log)) record({ kind: "noop" });
  }
});
`;

const createFakeCli = async (): Promise<string> => {
  const root = await temporaryDirectory("daycrew-claude-fake-");
  const scriptPath = path.join(root, "fake-claude.mjs");
  await writeFile(scriptPath, fakeCliSource, "utf8");
  return scriptPath;
};

const drain = async (
  iterator: AsyncIterator<AgentEvent>,
  stopAt: (event: AgentEvent) => boolean,
  limit = 20,
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for (let index = 0; index < limit; index += 1) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<AgentEvent>>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for a Claude Code event")), 15_000),
      ),
    ]);
    if (next.done) break;
    events.push(next.value);
    if (stopAt(next.value)) break;
  }
  return events;
};

const approvalOf = (events: readonly AgentEvent[]): ApprovalRequest => {
  const event = events.find((candidate) => candidate.type === "approval_request");
  if (event === undefined || event.type !== "approval_request") {
    throw new Error("Expected an approval_request event");
  }
  return event.request;
};

const isTurnBoundary = (event: AgentEvent): boolean =>
  event.type === "done" || event.type === "turn_end" || event.type === "error";

describe("Claude Code risk classification", () => {
  const workspace = path.resolve("/workspace");

  it("classifies filesystem, shell, git, network, and MCP actions", () => {
    expect(classifyClaudeToolUse("Write", { file_path: "src/app.ts" }, workspace)).toMatchObject({
      action: "filesystem.write",
      risk: "medium",
      outsideWorkspace: false,
    });
    expect(classifyClaudeToolUse("Read", { file_path: "README.md" }, workspace)).toMatchObject({
      action: "command.run",
      risk: "low",
    });
    expect(classifyClaudeToolUse("Bash", { command: "ls -la" }, workspace)).toMatchObject({
      action: "command.run",
      risk: "low",
    });
    expect(classifyClaudeToolUse("Bash", { command: "git status" }, workspace)).toMatchObject({
      action: "command.run",
      risk: "low",
    });
    expect(classifyClaudeToolUse("Bash", { command: "rm -rf build" }, workspace)).toMatchObject({
      action: "filesystem.delete",
      risk: "critical",
    });
    expect(classifyClaudeToolUse("Bash", { command: "git push origin main" }, workspace)).toMatchObject({
      action: "git.push",
      risk: "high",
    });
    expect(
      classifyClaudeToolUse("Bash", { command: "git push --force origin main" }, workspace),
    ).toMatchObject({ action: "git.destructive", risk: "critical" });
    expect(classifyClaudeToolUse("Bash", { command: "git reset --hard HEAD~3" }, workspace)).toMatchObject({
      action: "git.destructive",
      risk: "critical",
    });
    expect(classifyClaudeToolUse("Bash", { command: "npm publish" }, workspace)).toMatchObject({
      action: "external.publish",
      risk: "critical",
    });
    expect(classifyClaudeToolUse("Bash", { command: "curl https://example.com" }, workspace)).toMatchObject({
      action: "network.sensitive",
      risk: "high",
    });
    expect(classifyClaudeToolUse("WebFetch", { url: "https://example.com" }, workspace)).toMatchObject({
      action: "network.sensitive",
      risk: "high",
    });
    expect(classifyClaudeToolUse("mcp__probe__touch", { note: "x" }, workspace)).toMatchObject({
      action: "network.sensitive",
      risk: "critical",
    });
  });

  it("fails closed on redirects, chained commands, unknown binaries, and unknown tools", () => {
    expect(classifyClaudeToolUse("Bash", { command: "echo hi > out.txt" }, workspace)).toMatchObject({
      action: "shell.destructive",
      risk: "critical",
    });
    expect(classifyClaudeToolUse("Bash", { command: "ls && whoami" }, workspace)).toMatchObject({
      action: "shell.destructive",
      risk: "critical",
    });
    expect(classifyClaudeToolUse("Bash", { command: "some-unknown-binary --go" }, workspace)).toMatchObject({
      action: "shell.destructive",
      risk: "critical",
    });
    expect(classifyClaudeToolUse("Task", { prompt: "spawn" }, workspace)).toMatchObject({
      action: "shell.destructive",
      risk: "critical",
    });
  });

  it("treats DayCrew's own StructuredOutput result channel as ordinary work", () => {
    // Regression: it was classified as an unknown tool and denied, so a read-only
    // Member could never report its tasks and the work session stalled.
    expect(classifyClaudeToolUse("StructuredOutput", { summary: "x" }, workspace)).toMatchObject({
      action: "command.run",
      risk: "low",
      outsideWorkspace: false,
    });
  });

  it("flags credential paths and paths outside the Workspace", () => {
    expect(classifyClaudeToolUse("Read", { file_path: ".env" }, workspace)).toMatchObject({
      action: "credential.access",
      risk: "critical",
    });
    expect(
      classifyClaudeToolUse("Read", { file_path: path.join(workspace, "..", "other", "x.txt") }, workspace),
    ).toMatchObject({ outsideWorkspace: true });
    expect(classifyClaudeToolUse("Read", { file_path: "src/index.ts" }, workspace)).toMatchObject({
      outsideWorkspace: false,
    });
  });
});

describe("Claude Code stream normalization", () => {
  it("normalizes assistant text, tool calls, tool results, usage, and structured tasks", () => {
    expect(
      normalizeClaudeStreamMessage(
        JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" }),
      ),
    ).toMatchObject({ sessionId: "abc-123", events: [] });

    expect(
      normalizeClaudeStreamMessage(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Working on it." },
              { type: "tool_use", id: "toolu_XyZ01", name: "Read", input: { file_path: "a.ts" } },
            ],
          },
        }),
      ).events,
    ).toEqual([
      { type: "text", text: "Working on it." },
      { type: "tool_call", callId: "toolu-xyz01", name: "Read", input: { file_path: "a.ts" } },
    ]);

    expect(
      normalizeClaudeStreamMessage(
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_XyZ01", content: "ok" }] },
        }),
      ).events,
    ).toEqual([{ type: "tool_result", callId: "toolu-xyz01", output: "ok", isError: false }]);

    const result = normalizeClaudeStreamMessage(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.5,
        usage: { input_tokens: 4, cache_read_input_tokens: 96, output_tokens: 12 },
        result: JSON.stringify({
          summary: "Done.",
          complete: true,
          tasks: [
            {
              id: "hello-plan",
              title: "Plan endpoint",
              description: "Plan it.",
              status: "review",
              ownerId: "developer",
              dependsOn: [],
              needsYou: false,
            },
          ],
        }),
      }),
    );
    expect(result).toMatchObject({ turnEnded: true, complete: true });
    expect(result.events).toEqual([
      { type: "usage", usage: { inputTokens: 100, outputTokens: 12, costUsd: 0.5 } },
      {
        type: "task_update",
        task: {
          id: "hello-plan",
          title: "Plan endpoint",
          description: "Plan it.",
          status: "review",
          ownerId: "developer",
          dependsOn: [],
          needsYou: false,
        },
      },
      { type: "text", text: "Done." },
    ]);
  });

  it("fails closed on invalid JSON and failed turns", () => {
    expect(normalizeClaudeStreamMessage("not json").events[0]).toMatchObject({
      type: "error",
      recoverable: false,
    });
    expect(
      normalizeClaudeStreamMessage(
        JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
      ),
    ).toMatchObject({ failed: true, turnEnded: true });
  });

  it("redacts provider credentials from text", () => {
    expect(redactSecrets("token sk-ant-api03-abcdefghijklmnop here")).toBe("token [redacted] here");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrst")).toContain("[redacted]");
    expect(
      normalizeClaudeStreamMessage(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "key ghp_abcdefghijklmnopqrstuvwxyz01" }] },
        }),
      ).events[0],
    ).toEqual({ type: "text", text: "key [redacted]" });
  });
});

describe("ClaudeCodeProvider", () => {
  it("detects an authenticated CLI", async () => {
    const scriptPath = await createFakeCli();
    await expect(
      new ClaudeCodeProvider({ command: [process.execPath, scriptPath] }).detect(),
    ).resolves.toEqual({ available: true, version: "2.1.266" });
  });

  it("reports an unauthenticated CLI as unavailable", async () => {
    const scriptPath = await createFakeCli();
    const detection = await new ClaudeCodeProvider({
      command: [process.execPath, scriptPath, "--fake-logged-out"],
    }).detect();
    expect(detection).toMatchObject({ available: false, version: "2.1.266" });
    expect(detection.reason).toContain("not authenticated");
  });

  it("bridges a write into an approval request, and a denial leaves the file uncreated", async () => {
    const scriptPath = await createFakeCli();
    const workspace = await temporaryDirectory("daycrew-claude-deny-");
    const provider = new ClaudeCodeProvider({
      command: [process.execPath, scriptPath],
      allowWrites: true,
      allowedWorkspaceRoots: [workspace],
      requiresApproval: () => true,
    });

    const handle = await provider.startAgent(spec(workspace));
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "write-hello" });

    const before = await drain(iterator, (event) => event.type === "approval_request");
    const request = approvalOf(before);
    expect(request).toMatchObject({ action: "filesystem.write", risk: "medium" });
    expect(existsSync(path.join(workspace, "hello.txt"))).toBe(false);

    await handle.send({
      type: "approval-decision",
      requestId: request.requestId ?? "approval-1",
      decision: "denied",
    });
    await drain(iterator, isTurnBoundary);
    await handle.stop();

    expect(existsSync(path.join(workspace, "hello.txt"))).toBe(false);
    expect(await readFile(decisionLog(workspace), "utf8")).toContain('"behavior":"deny"');
  });

  it("creates the file only after the approval is granted", async () => {
    const scriptPath = await createFakeCli();
    const workspace = await temporaryDirectory("daycrew-claude-allow-");
    const provider = new ClaudeCodeProvider({
      command: [process.execPath, scriptPath],
      allowWrites: true,
      allowedWorkspaceRoots: [workspace],
      requiresApproval: () => true,
    });

    const handle = await provider.startAgent(spec(workspace));
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "write-hello" });
    const before = await drain(iterator, (event) => event.type === "approval_request");
    expect(existsSync(path.join(workspace, "hello.txt"))).toBe(false);

    await handle.send({
      type: "approval-decision",
      requestId: approvalOf(before).requestId ?? "approval-1",
      decision: "approved",
    });
    await drain(iterator, isTurnBoundary);
    await handle.stop();

    expect(existsSync(path.join(workspace, "hello.txt"))).toBe(true);
    expect(await readFile(decisionLog(workspace), "utf8")).toContain('"behavior":"allow"');
  });

  it("denies a path outside the Workspace without asking a human", async () => {
    const scriptPath = await createFakeCli();
    const workspace = await temporaryDirectory("daycrew-claude-confine-");
    const provider = new ClaudeCodeProvider({
      command: [process.execPath, scriptPath],
      allowWrites: true,
      allowedWorkspaceRoots: [workspace],
      requiresApproval: () => false,
    });

    const handle = await provider.startAgent(spec(workspace));
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "escape-workspace" });
    const events = await drain(iterator, isTurnBoundary);
    await handle.stop();

    expect(events.some((event) => event.type === "approval_request")).toBe(false);
    const decisions = await readFile(decisionLog(workspace), "utf8");
    expect(decisions).toContain('"behavior":"deny"');
    expect(decisions).toContain("confines this Member to its Workspace");
  });

  it("denies every write when the adapter is running read-only", async () => {
    const scriptPath = await createFakeCli();
    const workspace = await temporaryDirectory("daycrew-claude-readonly-");
    const provider = new ClaudeCodeProvider({
      command: [process.execPath, scriptPath],
      allowedWorkspaceRoots: [workspace],
      requiresApproval: () => false,
    });

    const handle = await provider.startAgent(spec(workspace));
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "write-hello" });
    const events = await drain(iterator, isTurnBoundary);
    await handle.stop();

    expect(events.some((event) => event.type === "approval_request")).toBe(false);
    expect(existsSync(path.join(workspace, "hello.txt"))).toBe(false);
    expect(await readFile(decisionLog(workspace), "utf8")).toContain("read-only mode");
  });

  it("keeps hard boundaries human-gated even when the injected policy would allow them", () => {
    // An "Autonomous" policy approves ordinary work, but the classifier marks these critical,
    // and the adapter escalates every critical action regardless of the injected policy.
    for (const command of ["rm -rf build", "git push --force", "npm publish", "sudo reboot"]) {
      expect(classifyClaudeToolUse("Bash", { command }, path.resolve("/workspace")).risk).toBe(
        "critical",
      );
    }
  });

  it("streams a read-only plan with normalized task events", async () => {
    const scriptPath = await createFakeCli();
    const workspace = await temporaryDirectory("daycrew-claude-plan-");
    const provider = new ClaudeCodeProvider({
      command: [process.execPath, scriptPath],
      allowedWorkspaceRoots: [workspace],
    });
    const handle = await provider.startAgent(spec(workspace));
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "plain-plan" });
    const events = await drain(iterator, isTurnBoundary);
    await handle.stop();

    expect(events).toEqual([
      { type: "text", text: "Here is the plan." },
      { type: "usage", usage: { inputTokens: 110, outputTokens: 5, costUsd: 0.25 } },
      {
        type: "task_update",
        task: {
          id: "hello-plan",
          title: "Plan endpoint",
          description: "Plan it.",
          status: "todo",
          ownerId: "developer",
          dependsOn: [],
          needsYou: false,
        },
      },
      { type: "text", text: "Plan ready." },
      { type: "turn_end" },
    ]);
  });

  it("redacts credentials that appear in a streamed Claude response", async () => {
    const scriptPath = await createFakeCli();
    const workspace = await temporaryDirectory("daycrew-claude-redact-");
    const provider = new ClaudeCodeProvider({
      command: [process.execPath, scriptPath],
      allowedWorkspaceRoots: [workspace],
    });
    const handle = await provider.startAgent(spec(workspace));
    const iterator = handle.events[Symbol.asyncIterator]();
    await handle.send({ type: "goal", text: "leak-secret" });
    const events = await drain(iterator, isTurnBoundary);
    await handle.stop();

    const text = events.filter((event) => event.type === "text").map((event) => event.text).join(" ");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("sk-ant-");
  });

  it("refuses writes without an explicit Workspace allowlist", async () => {
    const scriptPath = await createFakeCli();
    const workspace = await temporaryDirectory("daycrew-claude-noallow-");
    await expect(
      new ClaudeCodeProvider({
        command: [process.execPath, scriptPath],
        allowWrites: true,
      }).startAgent(spec(workspace)),
    ).rejects.toThrow("allowedWorkspaceRoots");
  });

  it("refuses to run against a DayCrew source checkout", async () => {
    const scriptPath = await createFakeCli();
    const workspace = await temporaryDirectory("daycrew-claude-repo-");
    await writeFile(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
    await mkdir(path.join(workspace, "packages", "shared", "src"), { recursive: true });
    await expect(
      new ClaudeCodeProvider({
        command: [process.execPath, scriptPath],
        allowedWorkspaceRoots: [workspace],
      }).startAgent(spec(workspace)),
    ).rejects.toThrow("DayCrew source checkout");
  });

  it("advertises a bridged approval capability", () => {
    const provider = new ClaudeCodeProvider({ allowWrites: true, allowedWorkspaceRoots: ["."] });
    expect(provider.capabilities).toMatchObject({ approvals: true, interruption: true, resume: true });
    expect(provider.security).toMatchObject({
      mode: "workspace-write",
      nativeApprovalBridge: true,
      preExecutionInterception: true,
      productionReady: true,
      mcpEnabled: false,
    });
  });
});
