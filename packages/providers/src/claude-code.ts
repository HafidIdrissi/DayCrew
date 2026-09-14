import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  AgentEventSchema,
  AgentInputSchema,
  AgentSpecSchema,
  type AgentEvent,
  type AgentHandle,
  type AgentInput,
  type AgentSpec,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderDetection,
  type RiskLevel,
  type RiskyAction,
} from "@daycrew/shared";

import { AsyncQueue } from "./async-queue.js";

/** Structured DayCrew result contract handed to Claude Code via `--json-schema`. */
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "complete", "tasks"],
  properties: {
    summary: { type: "string" },
    complete: { type: "boolean" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "description", "status", "ownerId", "dependsOn", "needsYou"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9]+(?:[-_][a-z0-9]+)*$" },
          title: { type: "string", minLength: 1 },
          description: { type: "string" },
          status: { enum: ["todo", "in-progress", "review", "done"] },
          ownerId: { type: "string", pattern: "^[a-z0-9]+(?:[-_][a-z0-9]+)*$" },
          dependsOn: {
            type: "array",
            items: { type: "string", pattern: "^[a-z0-9]+(?:[-_][a-z0-9]+)*$" },
          },
          needsYou: { type: "boolean" },
        },
      },
    },
  },
} as const;

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const arrayValue = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? (value as readonly unknown[]) : [];

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const errorEvent = (message: string, recoverable = false): AgentEvent => ({
  type: "error",
  message,
  recoverable,
});

const secretPatterns: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._-]{12,}/g,
  /eyJ[A-Za-z0-9._-]{20,}/g,
];

/** Removes provider credentials and bearer tokens before text reaches DayCrew state. */
export const redactSecrets = (value: string): string =>
  secretPatterns.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);

const clip = (value: string, limit = 2_000): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

/** Claude tool-use ids are mixed case; DayCrew ids are not. */
const normalizeCallId = (raw: string): string => {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "" ? "tool-call" : normalized;
};

const containsPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const credentialPathPattern =
  /(^|[\\/])(\.env(\..+)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd|id_rsa|id_ed25519|id_ecdsa|credentials|secrets?(\.[a-z0-9]+)?)$|[\\/]\.(ssh|aws|gnupg|kube|docker)[\\/]|\.(pem|pfx|p12|keystore)$/i;

const looksLikeCredentialPath = (candidate: string): boolean =>
  credentialPathPattern.test(candidate);

const fileToolPathKeys = ["file_path", "path", "notebook_path"] as const;

const toolPath = (input: unknown): string | undefined => {
  const value = objectValue(input);
  if (!value) return undefined;
  for (const key of fileToolPathKeys) {
    const candidate = stringValue(value[key]);
    if (candidate !== undefined && candidate.trim() !== "") return candidate;
  }
  return undefined;
};

/** DayCrew's own result channel, injected by `--json-schema`. It has no side effects. */
export const structuredOutputToolName = "StructuredOutput";

const readTools = new Set(["Read", "Glob", "Grep", "NotebookRead", "ListMcpResourcesTool"]);
const writeTools = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const shellTools = new Set(["Bash", "PowerShell", "BashOutput", "KillShell"]);
const networkTools = new Set(["WebFetch", "WebSearch"]);

interface ShellRule {
  readonly pattern: RegExp;
  readonly action: RiskyAction;
  readonly risk: RiskLevel;
}

/** Ordered most-dangerous first; the first match wins. */
const shellRules: readonly ShellRule[] = [
  { pattern: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i, action: "git.destructive", risk: "critical" },
  { pattern: /\bgit\s+push\b/i, action: "git.push", risk: "high" },
  {
    pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*[fd]|branch\s+-D|filter-branch|rebase|update-ref\s+-d|reflog\s+delete)\b/i,
    action: "git.destructive",
    risk: "critical",
  },
  {
    pattern: /\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+(release|pr\s+create|pr\s+merge)\b|\bdocker\s+push\b|\btwine\s+upload\b|\bcargo\s+publish\b/i,
    action: "external.publish",
    risk: "critical",
  },
  {
    pattern: /\b(curl|wget|nc|ncat|telnet|ssh|scp|rsync|ftp|Invoke-WebRequest|Invoke-RestMethod)\b/i,
    action: "network.sensitive",
    risk: "high",
  },
  {
    pattern: /\b(rm|rmdir|del|erase|unlink|Remove-Item|shred)\b|\bmkfs\b|\bdd\s+if=|\bformat\b|\bTrash\b/i,
    action: "filesystem.delete",
    risk: "critical",
  },
  {
    pattern: /\b(sudo|doas|runas|shutdown|reboot|halt|taskkill|kill|pkill|chown|chmod\s+-R|icacls|setx|reg\s+(add|delete)|systemctl|sc\s+(stop|delete))\b/i,
    action: "shell.destructive",
    risk: "critical",
  },
];

/** Commands DayCrew treats as ordinary, non-mutating work. Anything else fails closed. */
const safeShellPattern =
  /^(ls|dir|pwd|cd|cat|type|head|tail|wc|which|where|echo|printf|env|date|whoami|hostname|node|npm|pnpm|yarn|npx|python|python3|pip|go|cargo|dotnet|java|mvn|gradle|make|jq|sort|uniq|grep|rg|find|fd|stat|tree|diff|git)$/i;

const safeGitSubcommandPattern =
  /^git\s+(status|log|diff|show|branch|remote|config\s+--get|rev-parse|describe|ls-files|blame|shortlog|tag\s*$|stash\s+list)\b/i;

const mutatingScriptPattern = /^(npm|pnpm|yarn|npx)\s+(install|i|add|remove|uninstall|link|update|upgrade|exec|dlx|create)\b/i;

const hasRedirectOrChain = (command: string): boolean => /[>|&;`]|\$\(/.test(command);

const classifyShellCommand = (command: string): { action: RiskyAction; risk: RiskLevel } => {
  for (const rule of shellRules) {
    if (rule.pattern.test(command)) return { action: rule.action, risk: rule.risk };
  }
  if (mutatingScriptPattern.test(command.trim())) {
    return { action: "filesystem.write", risk: "high" };
  }
  if (hasRedirectOrChain(command)) {
    // A redirect writes, and a chain hides a second command from this classifier.
    return { action: "shell.destructive", risk: "critical" };
  }
  const executable = command.trim().split(/\s+/)[0] ?? "";
  if (safeGitSubcommandPattern.test(command.trim())) return { action: "command.run", risk: "low" };
  if (/^git$/i.test(executable)) return { action: "shell.destructive", risk: "critical" };
  if (safeShellPattern.test(executable)) return { action: "command.run", risk: "low" };
  return { action: "shell.destructive", risk: "critical" };
};

export interface ClaudeActionClassification {
  readonly action: RiskyAction;
  readonly risk: RiskLevel;
  readonly summary: string;
  /** True when the adapter must refuse the call outright, before any policy question. */
  readonly outsideWorkspace: boolean;
}

/**
 * Maps one Claude Code tool request onto DayCrew's provider-neutral risk vocabulary.
 * Unrecognised tools and unparseable shell fail closed at `critical`.
 */
export const classifyClaudeToolUse = (
  toolName: string,
  input: unknown,
  workspacePath: string,
): ClaudeActionClassification => {
  const targetPath = toolPath(input);
  const resolved =
    targetPath === undefined ? undefined : path.resolve(workspacePath, targetPath);
  const outsideWorkspace = resolved !== undefined && !containsPath(workspacePath, resolved);
  const shown = targetPath ?? "";

  if (toolName === structuredOutputToolName) {
    return {
      action: "command.run",
      risk: "low",
      summary: "Claude Code reported its DayCrew result",
      outsideWorkspace: false,
    };
  }
  if (resolved !== undefined && looksLikeCredentialPath(resolved)) {
    return {
      action: "credential.access",
      risk: "critical",
      summary: `${toolName} wants to touch a credential file: ${shown}`,
      outsideWorkspace,
    };
  }
  if (toolName.startsWith("mcp__")) {
    return {
      action: "network.sensitive",
      risk: "critical",
      summary: `MCP tool ${toolName} requested an action with unverified side effects`,
      outsideWorkspace,
    };
  }
  if (networkTools.has(toolName)) {
    const target =
      stringValue(objectValue(input)?.["url"]) ?? stringValue(objectValue(input)?.["query"]) ?? "";
    return {
      action: "network.sensitive",
      risk: "high",
      summary: `${toolName} wants network access: ${clip(target, 200)}`,
      outsideWorkspace,
    };
  }
  if (shellTools.has(toolName)) {
    const command = stringValue(objectValue(input)?.["command"]) ?? "";
    const { action, risk } = classifyShellCommand(command);
    return {
      action,
      risk,
      summary: `${toolName} wants to run: ${clip(command, 400)}`,
      outsideWorkspace,
    };
  }
  if (writeTools.has(toolName)) {
    return {
      action: "filesystem.write",
      risk: "medium",
      summary: `${toolName} wants to modify ${shown}`,
      outsideWorkspace,
    };
  }
  if (readTools.has(toolName)) {
    return {
      action: "command.run",
      risk: "low",
      summary: `${toolName} wants to read ${shown || "the Workspace"}`,
      outsideWorkspace,
    };
  }
  return {
    action: "shell.destructive",
    risk: "critical",
    summary: `Unrecognised Claude Code tool ${toolName}`,
    outsideWorkspace,
  };
};

/** Actions DayCrew always escalates to a human, whatever a caller's policy says. */
const alwaysHumanActions = new Set<RiskyAction>([
  "shell.destructive",
  "filesystem.delete",
  "external.publish",
  "money.spend",
  "git.destructive",
  "credential.access",
]);

export interface DayCrewClaudeOutput {
  readonly summary: string;
  readonly complete: boolean;
  readonly tasks: ReadonlyArray<Record<string, unknown>>;
}

const parseStructuredOutput = (value: unknown): DayCrewClaudeOutput | undefined => {
  const direct = objectValue(value);
  if (direct) {
    if (
      typeof direct["summary"] === "string" &&
      typeof direct["complete"] === "boolean" &&
      Array.isArray(direct["tasks"])
    ) {
      return direct as unknown as DayCrewClaudeOutput;
    }
    return undefined;
  }
  const text = stringValue(value);
  if (text === undefined) return undefined;
  try {
    return parseStructuredOutput(JSON.parse(text));
  } catch {
    return undefined;
  }
};

export interface NormalizedClaudeMessage {
  readonly events: readonly AgentEvent[];
  readonly sessionId?: string;
  readonly turnEnded?: boolean;
  readonly complete?: boolean;
  readonly failed?: boolean;
  readonly interrupted?: boolean;
}

const normalizeAssistantMessage = (value: Record<string, unknown>): AgentEvent[] => {
  const events: AgentEvent[] = [];
  const message = objectValue(value["message"]);
  for (const entry of arrayValue(message?.["content"])) {
    const block = objectValue(entry);
    if (!block) continue;
    if (block["type"] === "text") {
      const text = stringValue(block["text"]) ?? "";
      if (text.trim() !== "") {
        events.push(AgentEventSchema.parse({ type: "text", text: redactSecrets(text) }));
      }
      continue;
    }
    if (block["type"] === "tool_use") {
      const id = stringValue(block["id"]);
      const name = stringValue(block["name"]);
      if (id === undefined || name === undefined) continue;
      events.push(
        AgentEventSchema.parse({
          type: "tool_call",
          callId: normalizeCallId(id),
          name,
          input: JSON.parse(redactSecrets(JSON.stringify(block["input"] ?? {}))),
        }),
      );
    }
  }
  return events;
};

const normalizeToolResults = (value: Record<string, unknown>): AgentEvent[] => {
  const events: AgentEvent[] = [];
  const message = objectValue(value["message"]);
  for (const entry of arrayValue(message?.["content"])) {
    const block = objectValue(entry);
    if (!block || block["type"] !== "tool_result") continue;
    const id = stringValue(block["tool_use_id"]);
    if (id === undefined) continue;
    const content = block["content"];
    const output =
      typeof content === "string"
        ? redactSecrets(clip(content))
        : JSON.parse(redactSecrets(clip(JSON.stringify(content ?? ""))));
    events.push(
      AgentEventSchema.parse({
        type: "tool_result",
        callId: normalizeCallId(id),
        output,
        isError: block["is_error"] === true,
      }),
    );
  }
  return events;
};

const normalizeResultMessage = (value: Record<string, unknown>): NormalizedClaudeMessage => {
  const events: AgentEvent[] = [];
  const usage = objectValue(value["usage"]);
  if (usage) {
    const inputTokens =
      numberValue(usage["input_tokens"]) +
      numberValue(usage["cache_creation_input_tokens"]) +
      numberValue(usage["cache_read_input_tokens"]);
    // `modelUsage` is keyed by the model the CLI actually billed, which resolves an
    // alias such as `haiku` to its concrete id. Report it only when unambiguous.
    const billed = Object.keys(objectValue(value["modelUsage"]) ?? {});
    const model = billed.length === 1 ? billed[0] : undefined;
    events.push(
      AgentEventSchema.parse({
        type: "usage",
        usage: {
          inputTokens,
          outputTokens: numberValue(usage["output_tokens"]),
          costUsd: numberValue(value["total_cost_usd"]),
          ...(model === undefined ? {} : { model }),
        },
      }),
    );
  }

  const subtype = stringValue(value["subtype"]);
  if (subtype !== "success" || value["is_error"] === true) {
    const interrupted =
      subtype === "error_during_execution" &&
      JSON.stringify(value["errors"] ?? "").includes("interrupt");
    const detail =
      stringValue(value["result"]) ??
      redactSecrets(clip(JSON.stringify(value["errors"] ?? subtype ?? "unknown"), 500));
    events.push(errorEvent(`Claude Code turn failed (${subtype ?? "unknown"}): ${detail}`));
    return { events, failed: true, turnEnded: true, ...(interrupted ? { interrupted: true } : {}) };
  }

  const output =
    parseStructuredOutput(value["structured_output"]) ?? parseStructuredOutput(value["result"]);
  if (!output) {
    const text = stringValue(value["result"]);
    if (text !== undefined && text.trim() !== "") {
      events.push(AgentEventSchema.parse({ type: "text", text: redactSecrets(text) }));
    }
    return { events, turnEnded: true, complete: false };
  }

  for (const task of output.tasks) {
    const parsed = AgentEventSchema.safeParse({ type: "task_update", task });
    if (!parsed.success) {
      return {
        events: [errorEvent(`Claude Code returned an invalid DayCrew task: ${parsed.error.message}`)],
        failed: true,
        turnEnded: true,
      };
    }
    events.push(parsed.data);
  }
  if (output.summary.trim() !== "") {
    events.push(AgentEventSchema.parse({ type: "text", text: redactSecrets(output.summary) }));
  }
  return { events, turnEnded: true, complete: output.complete };
};

/** Converts one Claude Code `stream-json` record without exposing it to core. */
export const normalizeClaudeStreamMessage = (line: string): NormalizedClaudeMessage => {
  let value: Record<string, unknown>;
  try {
    const parsed = objectValue(JSON.parse(line));
    if (!parsed) throw new Error("Expected an object");
    value = parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { events: [errorEvent(`Claude Code emitted invalid stream JSON: ${message}`)] };
  }

  const type = stringValue(value["type"]);
  if (type === "system" && value["subtype"] === "init") {
    const sessionId = stringValue(value["session_id"]);
    return { events: [], ...(sessionId === undefined ? {} : { sessionId }) };
  }
  if (type === "assistant") return { events: normalizeAssistantMessage(value) };
  if (type === "user") return { events: normalizeToolResults(value) };
  if (type === "result" || value["total_cost_usd"] !== undefined) {
    return normalizeResultMessage(value);
  }
  return { events: [] };
};

export interface ClaudeCodeSecurityProfile {
  readonly mode: "workspace-write" | "read-only";
  readonly productionReady: boolean;
  readonly nativeApprovalBridge: true;
  readonly writesAllowed: boolean;
  readonly preExecutionInterception: true;
  readonly mcpEnabled: boolean;
  readonly limitations: readonly string[];
}

export interface ClaudeCodeProviderOptions {
  /** Explicit command and fixed prefix arguments, mainly for packaged installs/tests. */
  readonly command?: readonly [string, ...string[]];
  /** Canonical roots a Workspace must sit inside. Required when writes are enabled. */
  readonly allowedWorkspaceRoots?: readonly string[];
  /** Enables Write/Edit/Bash. Off by default so the adapter starts read-only. */
  readonly allowWrites?: boolean;
  /** Enables WebFetch/WebSearch. Off by default. */
  readonly allowNetworkTools?: boolean;
  /** MCP stays off unless a caller opts in and supplies a config. */
  readonly mcpConfig?: string;
  /**
   * DayCrew autonomy policy, injected by the composition root so that no Claude-specific
   * code lives in core. Defaults to fail-closed: every classified action asks a human.
   */
  readonly requiresApproval?: (action: RiskyAction, risk: RiskLevel) => boolean;
  /** Milliseconds to wait for a DayCrew approval decision before denying. */
  readonly approvalTimeoutMs?: number;
  readonly detectionTimeoutMs?: number;
  /** Escape hatch for running against a checkout of DayCrew itself. */
  readonly allowDayCrewRepository?: boolean;
}

interface ResolvedCommand {
  readonly executable: string;
  readonly prefixArguments: readonly string[];
}

const canAccess = async (filePath: string, mode = constants.F_OK): Promise<boolean> => {
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
};

const resolveCommand = async (
  configured?: readonly [string, ...string[]],
): Promise<ResolvedCommand> => {
  if (configured) return { executable: configured[0], prefixArguments: configured.slice(1) };
  const configuredBinary = process.env["DAYCREW_CLAUDE_BINARY"];
  if (configuredBinary) return { executable: configuredBinary, prefixArguments: [] };
  if (process.platform !== "win32") return { executable: "claude", prefixArguments: [] };

  // The Windows shim is a .cmd; spawning the native binary avoids shell quoting entirely.
  for (const entry of (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    if (!(await canAccess(path.join(entry, "claude.cmd")))) continue;
    const native = path.join(
      entry,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    if (await canAccess(native)) return { executable: native, prefixArguments: [] };
  }
  return { executable: "claude.exe", prefixArguments: [] };
};

const safeEnvironment = (): NodeJS.ProcessEnv => {
  const names = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "WINDIR",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "LANG",
    "CLAUDE_CONFIG_DIR",
  ];
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const capture = async (
  command: ResolvedCommand,
  arguments_: readonly string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.prefixArguments, ...arguments_], {
      env: safeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

const terminateProcess = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
};

/**
 * PreToolUse hook that forces every tool call — including ones Claude Code would
 * auto-approve — through the host permission bridge, so DayCrew stays authoritative.
 */
const askHookSource = `process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: "DayCrew reviews every action before it runs",
  },
}));
`;

interface PendingApproval {
  readonly claudeRequestId: string;
  readonly timer: NodeJS.Timeout;
}

interface HandleConfiguration {
  readonly command: ResolvedCommand;
  readonly spec: AgentSpec;
  readonly workspacePath: string;
  readonly hookScriptPath: string;
  readonly options: ClaudeCodeProviderOptions;
}

class ClaudeCodeAgentHandle implements AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly pending = new Map<string, PendingApproval>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private claudeSessionId: string | undefined;
  private stopped = false;
  private interrupting = false;
  private approvalCounter = 0;
  private stderrTail = "";
  private instructions: string;
  private instructionsChangedForLiveProcess = false;

  constructor(private readonly configuration: HandleConfiguration) {
    this.events = this.queue;
    this.instructions = configuration.spec.instructions;
  }

  getSessionIdentity(): string | undefined {
    return this.claudeSessionId;
  }

  async updateInstructions(instructions: string): Promise<void> {
    if (instructions === this.instructions) return;
    this.instructions = instructions;
    this.instructionsChangedForLiveProcess = this.child !== undefined;
  }

  async send(input: AgentInput): Promise<void> {
    const parsed = AgentInputSchema.parse(input);
    if (this.stopped) throw new Error("Claude Code agent is stopped");

    if (parsed.type === "approval-decision") {
      const pending = this.pending.get(parsed.requestId);
      if (!pending) throw new Error(`Unknown Claude Code approval request "${parsed.requestId}"`);
      this.pending.delete(parsed.requestId);
      clearTimeout(pending.timer);
      this.respondToPermission(
        pending.claudeRequestId,
        parsed.decision === "approved",
        parsed.decision === "approved"
          ? undefined
          : `DayCrew denied this action${parsed.feedback ? `: ${parsed.feedback}` : ""}`,
      );
      return;
    }

    const child = await this.ensureProcess();
    let text =
      parsed.type === "goal"
        ? parsed.text
        : `Message from ${parsed.message.fromMemberId} about task ${parsed.message.taskId ?? "none"}:\n${parsed.message.subject}\n${parsed.message.body}`;
    if (this.instructionsChangedForLiveProcess) {
      text = `Updated DayCrew Role and Skill instructions for this Task:\n${this.instructions}\n\nCurrent request:\n${text}`;
      this.instructionsChangedForLiveProcess = false;
    }
    child.stdin.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
    );
  }

  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child || this.stopped) return;
    this.interrupting = true;
    this.failPendingApprovals("DayCrew cancelled the turn");
    child.stdin.write(
      `${JSON.stringify({ type: "control_request", request_id: "daycrew-interrupt", request: { subtype: "interrupt" } })}\n`,
    );
    // Emitted before awaiting so the cancellation, not the aborted turn's failure, is the
    // first thing DayCrew sees.
    this.emit(errorEvent("Claude Code agent was cancelled", true));
    const settled = await Promise.race([
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      new Promise<boolean>((resolve) => child.once("close", () => resolve(true))),
    ]);
    if (!settled && child.exitCode === null) {
      // The control request is the clean path; terminating is the guaranteed one.
      await terminateProcess(child);
      this.child = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.failPendingApprovals("Claude Code agent stopped");
    const child = this.child;
    this.child = undefined;
    if (child) {
      child.stdin.end();
      await terminateProcess(child);
    }
    this.queue.close();
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null) return this.child;
    const { command, options, workspacePath, hookScriptPath, spec } = this.configuration;
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: `"${process.execPath}" "${hookScriptPath}"` }],
          },
        ],
      },
    };
    const tools = [
      "Read",
      "Glob",
      "Grep",
      ...(options.allowWrites === true ? ["Write", "Edit", "Bash"] : []),
      ...(options.allowNetworkTools === true ? ["WebFetch", "WebSearch"] : []),
    ];
    const arguments_ = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      // DayCrew is the permission host; nothing may answer a prompt on its behalf.
      "--permission-prompts",
      "host",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      "manual",
      "--setting-sources=",
      "--settings",
      JSON.stringify(settings),
      "--tools",
      tools.join(","),
      "--json-schema",
      JSON.stringify(outputSchema),
      "--append-system-prompt",
      this.systemPrompt(),
      ...(options.mcpConfig === undefined
        ? ["--strict-mcp-config"]
        : ["--strict-mcp-config", "--mcp-config", options.mcpConfig]),
      ...(spec.model === undefined ? [] : ["--model", spec.model]),
      ...(this.claudeSessionId === undefined ? [] : ["--resume", this.claudeSessionId]),
    ];

    const child = spawn(command.executable, [...command.prefixArguments, ...arguments_], {
      cwd: workspacePath,
      env: safeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = redactSecrets(`${this.stderrTail}${chunk}`).slice(-8_192);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.acceptLine(line));
    child.once("error", (error) => {
      if (!this.stopped) this.emit(errorEvent(`Failed to start Claude Code: ${error.message}`));
    });
    child.once("close", (code) => {
      if (this.child === child) this.child = undefined;
      this.failPendingApprovals("Claude Code exited before the decision was applied");
      if (this.stopped || this.interrupting) return;
      if (code !== 0 && code !== null) {
        this.emit(
          errorEvent(
            `Claude Code exited with code ${code}: ${this.stderrTail.trim() || "no diagnostic"}`,
          ),
        );
      }
    });
    return child;
  }

  private acceptLine(line: string): void {
    if (this.stopped || line.trim() === "") return;
    let value: Record<string, unknown> | undefined;
    try {
      value = objectValue(JSON.parse(line));
    } catch {
      value = undefined;
    }
    if (value?.["type"] === "control_request") {
      this.handleControlRequest(value);
      return;
    }
    if (value?.["type"] === "control_response") return;

    const normalized = normalizeClaudeStreamMessage(line);
    if (normalized.sessionId !== undefined) this.claudeSessionId = normalized.sessionId;
    for (const event of normalized.events) {
      // A cancelled turn reports its own abort; DayCrew already has the cancellation event.
      if (this.interrupting && event.type === "error") continue;
      this.emit(this.scopeTaskOwner(event));
    }
    if (normalized.turnEnded === true) {
      if (this.interrupting) {
        this.interrupting = false;
      } else if (!normalized.failed) {
        this.emit(normalized.complete === true ? { type: "done" } : { type: "turn_end" });
      }
    }
  }

  /** A specialist may only move its own work; a Manager may assign across the Team. */
  private scopeTaskOwner(event: AgentEvent): AgentEvent {
    const { spec } = this.configuration;
    if (
      event.type !== "task_update" ||
      spec.role.toLowerCase().includes("manager") ||
      event.task.ownerId === spec.memberId
    ) {
      return event;
    }
    return { type: "task_update", task: { ...event.task, ownerId: spec.memberId } };
  }

  private handleControlRequest(value: Record<string, unknown>): void {
    const request = objectValue(value["request"]);
    const claudeRequestId = stringValue(value["request_id"]);
    if (!request || claudeRequestId === undefined) return;
    if (request["subtype"] !== "can_use_tool") return;

    const toolName = stringValue(request["tool_name"]) ?? "unknown";
    const input = request["input"];
    if (toolName === structuredOutputToolName) {
      // Reporting a result is how a Member finishes; it is never a decision for a human.
      this.respondToPermission(claudeRequestId, true);
      return;
    }
    const classification = classifyClaudeToolUse(
      toolName,
      input,
      this.configuration.workspacePath,
    );

    if (classification.outsideWorkspace) {
      this.respondToPermission(
        claudeRequestId,
        false,
        "DayCrew confines this Member to its Workspace; the requested path is outside it",
      );
      return;
    }
    if (this.configuration.options.allowWrites !== true && classification.action !== "command.run") {
      this.respondToPermission(
        claudeRequestId,
        false,
        "DayCrew is running this Member in read-only mode",
      );
      return;
    }

    const policy = this.configuration.options.requiresApproval ?? (() => true);
    const needsHuman =
      alwaysHumanActions.has(classification.action) ||
      classification.risk === "critical" ||
      policy(classification.action, classification.risk);
    if (!needsHuman) {
      this.respondToPermission(claudeRequestId, true);
      return;
    }

    this.approvalCounter += 1;
    const requestId = `approval-${this.approvalCounter}`;
    const timeoutMs = this.configuration.options.approvalTimeoutMs ?? 900_000;
    const timer = setTimeout(() => {
      if (!this.pending.delete(requestId)) return;
      this.respondToPermission(
        claudeRequestId,
        false,
        "DayCrew denied this action because no decision arrived in time",
      );
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(requestId, { claudeRequestId, timer });

    this.emit({
      type: "approval_request",
      request: {
        requestId,
        action: classification.action,
        risk: classification.risk,
        summary: redactSecrets(classification.summary),
        payload: JSON.parse(redactSecrets(clip(JSON.stringify({ tool: toolName, input })))),
      },
    });
  }

  private respondToPermission(
    claudeRequestId: string,
    allow: boolean,
    message?: string,
  ): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const decision = allow
      ? { behavior: "allow" }
      : { behavior: "deny", message: message ?? "DayCrew denied this action" };
    child.stdin.write(
      `${JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: claudeRequestId, response: decision },
      })}\n`,
    );
  }

  private failPendingApprovals(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      this.respondToPermission(pending.claudeRequestId, false, reason);
    }
  }

  private emit(event: AgentEvent): void {
    if (this.stopped) return;
    this.queue.push(AgentEventSchema.parse(event));
  }

  private systemPrompt(): string {
    const { spec, options } = this.configuration;
    return [
      this.instructions,
      "",
      `Current DayCrew Member id: ${spec.memberId}`,
      `Current role: ${spec.role}`,
      "",
      "DayCrew provider rules:",
      "- Every tool call is reviewed by DayCrew before it runs. A denial is final; do not retry a denied action with a different tool.",
      "- Stay inside the Workspace directory. Never read or write outside it, and never touch credential files.",
      options.allowWrites === true
        ? "- You may create and edit files inside the Workspace once DayCrew approves the action."
        : "- This is a read-only session. Do not modify files or run commands that change state.",
      "- Report your result with the StructuredOutput tool using the required schema.",
      "- Use stable lowercase DayCrew ids with hyphens. Use only Member ids supplied in the prompt.",
      ...(spec.mode === "conversation" ? [
        "- This is a conversation, not an orchestration Goal. Reply naturally to the user's latest message. Use an empty tasks array and complete=true. Do not invent tasks, handoffs, or messages from other Members.",
      ] : [
        "- A Manager receiving a new goal should create delegated todo tasks and set complete=false.",
        `- A specialist must preserve ownerId=${spec.memberId}, update the supplied task id to review, and set complete=true.`,
        "- A Manager reviewing a completed task should preserve its owner, update it to done, and set complete=true when all work is reviewed.",
      ]),
      "- Use an empty tasks array only when no task operation is appropriate.",
    ].join("\n");
  }
}

const daycrewRepositoryMarkers = ["pnpm-workspace.yaml", path.join("packages", "shared", "src")];

const looksLikeDayCrewRepository = async (candidate: string): Promise<boolean> => {
  const results = await Promise.all(
    daycrewRepositoryMarkers.map((marker) => canAccess(path.join(candidate, marker))),
  );
  return results.every(Boolean);
};

export class ClaudeCodeProvider implements ProviderAdapter {
  readonly id = "claude-code";
  readonly displayName = "Claude Code";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolUse: true,
    approvals: true,
    interruption: true,
    resume: true,
    skillCapabilities: ["filesystem.read", "filesystem.write", "command.run", "browser", "network"],
  };

  constructor(private readonly options: ClaudeCodeProviderOptions = {}) {}

  get security(): ClaudeCodeSecurityProfile {
    const writesAllowed = this.options.allowWrites === true;
    return {
      mode: writesAllowed ? "workspace-write" : "read-only",
      productionReady: true,
      nativeApprovalBridge: true,
      writesAllowed,
      preExecutionInterception: true,
      mcpEnabled: this.options.mcpConfig !== undefined,
      limitations: [
        "An approved shell command is not sandboxed; DayCrew gates the invocation, not what the command then does.",
        "Shell commands that redirect, chain, or are otherwise unparseable are classified as shell.destructive and always require a human.",
        "MCP servers are disabled unless a caller supplies a config, and every MCP tool call is classified critical.",
        "Usage cost is reported by the Claude Code CLI and is not independently verified.",
      ],
    };
  }

  async detect(): Promise<ProviderDetection> {
    const timeout = this.options.detectionTimeoutMs ?? 15_000;
    try {
      const command = await resolveCommand(this.options.command);
      const versionResult = await capture(command, ["--version"], timeout);
      if (versionResult.code !== 0) {
        // The program answered, so it exists; nothing here proves anything about sign-in.
        return {
          available: false, installed: true,
          reason: redactSecrets(versionResult.stderr.trim()) || "Claude Code CLI failed to report its version",
        };
      }
      const version = (versionResult.stdout.trim().match(/\d+\.\d+\.\d+/) ?? [])[0] ?? "";
      const authResult = await capture(command, ["auth", "status"], timeout);
      // Only the boolean is read; the payload also carries account details DayCrew must not store.
      let loggedIn = false;
      try {
        loggedIn = objectValue(JSON.parse(authResult.stdout))?.["loggedIn"] === true;
      } catch {
        loggedIn = false;
      }
      if (!loggedIn) {
        return {
          available: false, installed: true, authenticated: false,
          ...(version === "" ? {} : { version }),
          reason: "Claude Code is installed but not authenticated; run `claude auth login`",
        };
      }
      return { available: true, installed: true, authenticated: true, ...(version === "" ? {} : { version }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only a missing executable proves absence; anything else leaves it unknown.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return {
        available: false, ...(missing ? { installed: false } : {}),
        reason: missing
          ? "Claude Code CLI was not found on PATH"
          : `Claude Code CLI could not be checked: ${redactSecrets(message)}`,
      };
    }
  }

  async startAgent(spec: AgentSpec): Promise<AgentHandle> {
    const parsed = AgentSpecSchema.parse(spec);
    const workspacePath = await realpath(parsed.workspacePath);
    if (workspacePath === path.parse(workspacePath).root) {
      throw new Error("Claude Code cannot use a filesystem root as its Workspace");
    }
    if (this.options.allowWrites === true && !this.options.allowedWorkspaceRoots) {
      throw new Error(
        "Claude Code requires an explicit allowedWorkspaceRoots list before writes are enabled",
      );
    }
    if (this.options.allowedWorkspaceRoots) {
      const allowedRoots = await Promise.all(
        this.options.allowedWorkspaceRoots.map((root) => realpath(root)),
      );
      if (!allowedRoots.some((root) => containsPath(root, workspacePath))) {
        throw new Error("Claude Code Workspace is outside the configured allowed roots");
      }
    }
    if (this.options.allowDayCrewRepository !== true && (await looksLikeDayCrewRepository(workspacePath))) {
      throw new Error(
        "Refusing to run Claude Code against a DayCrew source checkout; use an isolated Workspace",
      );
    }
    const detection = await this.detect();
    if (!detection.available) throw new Error(detection.reason ?? "Claude Code is unavailable");

    const hookDirectory = await mkdtemp(path.join(tmpdir(), "daycrew-claude-hook-"));
    const hookScriptPath = path.join(hookDirectory, "ask.mjs");
    await writeFile(hookScriptPath, askHookSource, "utf8");

    return new ClaudeCodeAgentHandle({
      command: await resolveCommand(this.options.command),
      spec: parsed,
      workspacePath,
      hookScriptPath,
      options: this.options,
    });
  }
}
