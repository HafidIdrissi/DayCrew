import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import {
  AgentEventSchema,
  AgentInputSchema,
  AgentSpecSchema,
  type AgentEvent,
  type AgentHandle,
  type AgentInput,
  type AgentSpec,
  type EngineModel,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderDetection,
} from "@daycrew/shared";

import { AsyncQueue } from "./async-queue.js";

type GrokChild = ChildProcessByStdio<null, Readable, Readable>;

interface ResolvedCommand {
  readonly executable: string;
  readonly prefixArguments: readonly string[];
}

export interface GrokProviderOptions {
  /** Explicit command and fixed prefix arguments, mainly for packaged installs/tests. */
  readonly command?: readonly [string, ...string[]];
  /** Required because the CLI owns the sandbox and its read boundary is not bridged by DayCrew. */
  readonly allowUnconfinedReads?: boolean;
  readonly allowedWorkspaceRoots?: readonly string[];
  readonly detectionTimeoutMs?: number;
}

export interface GrokSecurityProfile {
  readonly mode: "read-only-planning";
  readonly productionReady: false;
  readonly nativeApprovalBridge: false;
  readonly writesAllowed: false;
  readonly unconfinedReadsRequireExplicitOptIn: true;
  readonly limitations: readonly string[];
}

export interface NormalizedGrokLine {
  readonly events: readonly AgentEvent[];
  readonly sessionId?: string;
  readonly assistantText?: string;
  readonly finished?: boolean;
  readonly failed?: boolean;
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const secretPatterns: readonly RegExp[] = [
  /xai-[A-Za-z0-9_-]{16,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._-]{12,}/g,
  /eyJ[A-Za-z0-9._-]{20,}/g,
];

export const redactGrokSecrets = (value: string): string =>
  secretPatterns.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);

const errorEvent = (message: string, recoverable = false): AgentEvent => ({
  type: "error",
  message: redactGrokSecrets(message),
  recoverable,
});

const clip = (value: string, limit = 2_000): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

const normalizeCallId = (raw: string): string => {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized === "" ? "tool-call" : normalized;
};

/** Converts one official Grok Build `streaming-json` record into DayCrew events. */
export const normalizeGrokStreamLine = (line: string): NormalizedGrokLine => {
  let value: Record<string, unknown> | undefined;
  try {
    value = objectValue(JSON.parse(line));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { events: [errorEvent(`Grok emitted invalid JSON: ${message}`)], failed: true };
  }
  if (!value) return { events: [errorEvent("Grok emitted a non-object stream record")], failed: true };

  const type = value["type"];
  if (type === "text") {
    const text = redactGrokSecrets(stringValue(value["data"]) ?? "");
    return text === "" ? { events: [] } : { events: [{ type: "text", text }], assistantText: text };
  }
  if (type === "thought") return { events: [] };
  if (type === "tool_call") {
    const rawId = stringValue(value["toolCallId"]);
    if (!rawId) return { events: [] };
    return {
      events: [{
        type: "tool_call",
        callId: normalizeCallId(rawId),
        name: stringValue(value["toolName"]) ?? stringValue(value["title"]) ?? "grok-tool",
        input: value["rawInput"] ?? {},
      }],
    };
  }
  if (type === "tool_call_update") {
    const rawId = stringValue(value["toolCallId"]);
    if (!rawId) return { events: [] };
    const status = stringValue(value["status"]);
    if (status === "in_progress" || status === "pending") return { events: [] };
    const output = value["rawOutput"] ?? value["content"] ?? "";
    return {
      events: [{
        type: "tool_result",
        callId: normalizeCallId(rawId),
        output: typeof output === "string" ? clip(redactGrokSecrets(output)) : output,
        ...(/fail|error|cancel/i.test(status ?? "") ? { isError: true } : {}),
      }],
    };
  }
  if (type === "usage") {
    const usage = objectValue(value["usage"]);
    return {
      events: [{
        type: "usage",
        usage: {
          inputTokens: numberValue(usage?.["input_tokens"]),
          outputTokens: numberValue(usage?.["output_tokens"]),
          costUsd: 0,
        },
      }],
    };
  }
  if (type === "end") {
    const sessionId = stringValue(value["sessionId"]);
    return { events: [], finished: true, ...(sessionId ? { sessionId } : {}) };
  }
  if (type === "error") {
    return {
      events: [errorEvent(stringValue(value["message"]) ?? "Grok turn failed")],
      failed: true,
    };
  }
  return { events: [] };
};

/** Parses the stable human-readable output of `grok models`. */
export const parseGrokModels = (stdout: string): EngineModel[] => {
  const models: EngineModel[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/^[\s*•>-]+/, "").trim();
    const match = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)(?:\s+\([^)]*\))?$/.exec(line);
    const id = match?.[1];
    if (!id || seen.has(id) || !/[0-9./-]/.test(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
};

const resolveCommand = (configured?: readonly [string, ...string[]]): ResolvedCommand => {
  if (configured) return { executable: configured[0], prefixArguments: configured.slice(1) };
  const override = process.env["DAYCREW_GROK_BINARY"];
  return { executable: override || "grok", prefixArguments: [] };
};

const safeEnvironment = (): NodeJS.ProcessEnv => {
  const names = [
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "WINDIR",
    "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "LANG",
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

const canAccess = async (filePath: string, mode = constants.F_OK): Promise<boolean> => {
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
};

const containsPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const terminateProcess = async (child: GrokChild): Promise<void> => {
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

class GrokAgentHandle implements AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private sessionId: string | undefined;
  private active: GrokChild | undefined;
  private stopped = false;
  private readonly cancelledChildren = new WeakSet<GrokChild>();
  private finished = false;
  private failed = false;
  private assistantText = "";
  private instructions: string;

  constructor(
    private readonly command: ResolvedCommand,
    private readonly spec: AgentSpec,
    private readonly workspacePath: string,
  ) {
    this.events = this.queue;
    this.instructions = spec.instructions;
  }

  getSessionIdentity(): string | undefined {
    return this.sessionId;
  }

  async updateInstructions(instructions: string): Promise<void> {
    this.instructions = instructions;
  }

  async send(input: AgentInput): Promise<void> {
    const parsed = AgentInputSchema.parse(input);
    if (this.stopped) throw new Error("Grok agent is stopped");
    if (this.active) throw new Error("Grok agent already has an active turn");
    if (parsed.type === "approval-decision") {
      throw new Error("Grok native approvals are not bridged; DayCrew fails closed");
    }
    this.finished = false;
    this.failed = false;
    this.assistantText = "";
    const arguments_ = [
      "-p", this.promptFor(parsed),
      "--output-format", "streaming-json",
      "--permission-mode", "dontAsk",
      "--sandbox", "read-only",
      "--tools", "Read,Grep,Glob",
      "--disallowed-tools", "Edit,Write,Bash,WebFetch,WebSearch,Agent",
      "--deny", "MCPTool(*)",
      "--deny", "Bash",
      "--deny", "Edit",
      "--deny", "Write",
      "--disable-web-search",
      "--no-subagents",
      "--verbatim",
      "--cwd", this.workspacePath,
      ...(this.spec.model === undefined ? [] : ["--model", this.spec.model]),
      ...(this.sessionId === undefined ? [] : ["--resume", this.sessionId]),
    ];
    const child = spawn(this.command.executable, [...this.command.prefixArguments, ...arguments_], {
      cwd: this.workspacePath,
      env: safeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.active = child;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.acceptLine(line));
    child.once("error", (error) => {
      if (!this.stopped) this.emit(errorEvent(`Failed to start Grok: ${error.message}`));
    });
    child.once("close", (code) => {
      if (this.active === child) this.active = undefined;
      if (this.stopped || this.cancelledChildren.has(child)) return;
      if (this.failed) return;
      if (code !== 0) {
        this.emit(errorEvent(`Grok exited with code ${code ?? "unknown"}: ${redactGrokSecrets(stderr.trim()) || "no diagnostic"}`));
        return;
      }
      if (!this.finished) {
        this.emit(errorEvent("Grok exited without an end event"));
        return;
      }
      this.emit({ type: "done", ...(this.assistantText.trim() === "" ? {} : { summary: this.assistantText.trim() }) });
    });
  }

  async interrupt(): Promise<void> {
    const child = this.active;
    if (!child) return;
    this.active = undefined;
    this.cancelledChildren.add(child);
    await terminateProcess(child);
    if (!this.stopped) this.emit(errorEvent("Grok agent was cancelled", true));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.active;
    this.active = undefined;
    if (child) await terminateProcess(child);
    this.queue.close();
  }

  private acceptLine(line: string): void {
    if (this.stopped || line.trim() === "") return;
    const normalized = normalizeGrokStreamLine(line);
    if (normalized.sessionId) this.sessionId = normalized.sessionId;
    if (normalized.assistantText) this.assistantText += normalized.assistantText;
    if (normalized.finished) this.finished = true;
    if (normalized.failed) this.failed = true;
    for (const event of normalized.events) this.emit(event);
  }

  private emit(event: AgentEvent): void {
    if (!this.stopped) this.queue.push(AgentEventSchema.parse(event));
  }

  private promptFor(input: Exclude<AgentInput, { type: "approval-decision" }>): string {
    const inputText = input.type === "goal"
      ? input.text
      : `Message from ${input.message.fromMemberId} about task ${input.message.taskId ?? "none"}:\n${input.message.subject}\n${input.message.body}`;
    const boundary = "This is a read-only preview: do not modify files, use network tools, publish, push, spend money or access credentials.";
    if (this.spec.mode === "conversation") {
      return `${this.instructions}\n\nYou are ${this.spec.memberId}, role: ${this.spec.role}.\nThis is a chat, not a work Goal. Respond to the latest user message. Do not invent other agents' responses. ${boundary}\n\n${inputText}`;
    }
    return `${this.instructions}\n\nCurrent DayCrew Member id: ${this.spec.memberId}\nCurrent role: ${this.spec.role}\n\n${inputText}\n\nDayCrew provider rules:\n- ${boundary}\n- Report findings as prose. DayCrew reads your final message, not a task format.`;
  }
}

export class GrokProvider implements ProviderAdapter {
  readonly id = "grok";
  readonly displayName = "Grok Build (read-only preview)";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolUse: true,
    approvals: false,
    interruption: true,
    resume: true,
    skillCapabilities: ["filesystem.read"],
  };
  readonly security: GrokSecurityProfile = {
    mode: "read-only-planning",
    productionReady: false,
    nativeApprovalBridge: false,
    writesAllowed: false,
    unconfinedReadsRequireExplicitOptIn: true,
    limitations: [
      "Grok headless output does not expose a DayCrew-controlled approval bridge.",
      "The read-only sandbox and tool restrictions belong to the Grok CLI and are not yet verified in a signed-in live turn.",
      "Project and user Grok configuration may still be discovered by the CLI.",
    ],
  };

  constructor(private readonly options: GrokProviderOptions = {}) {}

  async listModels(): Promise<EngineModel[]> {
    const result = await capture(resolveCommand(this.options.command), ["models"], this.options.detectionTimeoutMs ?? 10_000);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Grok could not list its models.");
    return parseGrokModels(`${result.stdout}\n${result.stderr}`);
  }

  async detect(): Promise<ProviderDetection> {
    const command = resolveCommand(this.options.command);
    const timeout = this.options.detectionTimeoutMs ?? 10_000;
    try {
      const versionResult = await capture(command, ["--version"], timeout);
      if (versionResult.code !== 0) {
        return { available: false, installed: true, reason: versionResult.stderr.trim() || "Grok failed to report its version" };
      }
      const version = versionResult.stdout.trim().replace(/^grok\s+/i, "").split(/\s+/)[0];
      const modelResult = await capture(command, ["models"], timeout);
      const diagnostic = `${modelResult.stdout}\n${modelResult.stderr}`;
      if (/not authenticated|not signed in/i.test(diagnostic)) {
        return {
          available: false,
          installed: true,
          authenticated: false,
          ...(version ? { version } : {}),
          reason: "Grok Build is installed but not signed in. Run `grok login --device-code`.",
        };
      }
      if (modelResult.code !== 0) {
        return {
          available: false,
          installed: true,
          ...(version ? { version } : {}),
          reason: redactGrokSecrets(modelResult.stderr.trim() || "Grok could not check authentication."),
        };
      }
      return { available: true, installed: true, authenticated: true, ...(version ? { version } : {}) };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        ...(missing ? { installed: false } : {}),
        reason: missing ? "Grok Build was not found on PATH" : `Grok Build could not be checked: ${redactGrokSecrets(message)}`,
      };
    }
  }

  async startAgent(spec: AgentSpec): Promise<AgentHandle> {
    const parsed = AgentSpecSchema.parse(spec);
    if (!this.options.allowUnconfinedReads) {
      throw new Error("Grok requires explicit isolated-workspace opt-in because its read boundary is not controlled by DayCrew");
    }
    const workspacePath = await realpath(parsed.workspacePath);
    if (workspacePath === path.parse(workspacePath).root) {
      throw new Error("Grok cannot use a filesystem root as its Workspace");
    }
    if (!(await canAccess(workspacePath))) throw new Error("Grok Workspace is unavailable");
    if (this.options.allowedWorkspaceRoots) {
      const allowedRoots = await Promise.all(this.options.allowedWorkspaceRoots.map((root) => realpath(root)));
      if (!allowedRoots.some((root) => containsPath(root, workspacePath))) {
        throw new Error("Grok Workspace is outside the configured allowed roots");
      }
    }
    const detection = await this.detect();
    if (!detection.available) throw new Error(detection.reason ?? "Grok Build is unavailable");
    return new GrokAgentHandle(resolveCommand(this.options.command), parsed, workspacePath);
  }
}
