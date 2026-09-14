import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { constants } from "node:fs";
import { access, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
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
  type EngineModel,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderDetection,
} from "@daycrew/shared";

import { AsyncQueue } from "./async-queue.js";

/** Cursor takes its prompt as an argument, so the child never needs a stdin pipe. */
type CursorChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Cursor CLI (`cursor-agent`), the official Cursor coding agent.
 *
 * Authentication belongs to the CLI: `cursor-agent login` stores credentials locally
 * and `cursor-agent status` reports them. DayCrew never reads, stores or asks for a
 * Cursor credential, and never passes `--api-key`.
 *
 * Like Codex, Cursor exposes no pre-execution permission callback that DayCrew can
 * turn into an approval, so this adapter reports `approvals: false`, never passes
 * `--force` / `--yolo`, and writes a deny-first permission file for the run.
 *
 * Verified against https://cursor.com/docs/cli/reference on 2026-09-13.
 */

export interface CursorProviderOptions {
  /** Explicit command and fixed prefix arguments, mainly for packaged installs/tests. */
  readonly command?: readonly [string, ...string[]];
  /** Required because Cursor's permission model is a static config file, not a callback. */
  readonly allowUnconfinedReads?: boolean;
  readonly allowedWorkspaceRoots?: readonly string[];
  readonly detectionTimeoutMs?: number;
}

export interface CursorSecurityProfile {
  readonly mode: "read-only-planning";
  readonly productionReady: boolean;
  readonly nativeApprovalBridge: boolean;
  readonly writesAllowed: boolean;
  readonly unconfinedReadsRequireExplicitOptIn: boolean;
  readonly limitations: readonly string[];
}

interface ResolvedCommand {
  readonly executable: string;
  readonly prefixArguments: readonly string[];
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const arrayValue = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const secretPatterns: readonly RegExp[] = [
  /key_[A-Za-z0-9]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._-]{12,}/g,
  /eyJ[A-Za-z0-9._-]{20,}/g,
];

/** Removes credentials and tokens before CLI text reaches DayCrew state. */
export const redactCursorSecrets = (value: string): string =>
  secretPatterns.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);

const errorEvent = (message: string, recoverable = false): AgentEvent => ({
  type: "error",
  message: redactCursorSecrets(message),
  recoverable,
});

const clip = (value: string, limit = 2_000): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

/** Cursor tool-call ids are opaque strings; DayCrew ids are lowercase and hyphenated. */
const normalizeCallId = (raw: string): string => {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized === "" ? "tool-call" : normalized;
};

const textFromContent = (message: Record<string, unknown> | undefined): string =>
  arrayValue(message?.["content"])
    .map((block) => (objectValue(block)?.["type"] === "text" ? stringValue(objectValue(block)?.["text"]) : undefined))
    .filter((text): text is string => text !== undefined)
    .join("");

export interface NormalizedCursorLine {
  readonly events: readonly AgentEvent[];
  readonly sessionId?: string;
  readonly assistantText?: string;
  readonly finished?: boolean;
  readonly failed?: boolean;
}

/**
 * Converts one `--output-format stream-json` record into normalized DayCrew events.
 * Field names follow https://cursor.com/docs/cli/reference/output-format.
 */
export const normalizeCursorStreamLine = (line: string): NormalizedCursorLine => {
  let value: Record<string, unknown> | undefined;
  try {
    value = objectValue(JSON.parse(line));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { events: [errorEvent(`Cursor emitted invalid JSON: ${message}`)] };
  }
  if (!value) return { events: [errorEvent("Cursor emitted a non-object stream record")] };
  const sessionId = stringValue(value["session_id"]);
  const carry = sessionId === undefined ? {} : { sessionId };
  const type = value["type"];

  if (type === "system") return { events: [], ...carry };
  // The prompt DayCrew just sent is echoed back; it is not an agent event.
  if (type === "user") return { events: [], ...carry };

  if (type === "assistant") {
    const text = redactCursorSecrets(textFromContent(objectValue(value["message"])));
    if (text === "") return { events: [], ...carry };
    return { events: [{ type: "text", text }], assistantText: text, ...carry };
  }

  if (type === "tool_call") {
    const callId = stringValue(value["call_id"]);
    const call = objectValue(value["tool_call"]);
    const name = call === undefined ? undefined : Object.keys(call)[0];
    if (callId === undefined || name === undefined) return { events: [], ...carry };
    const body = objectValue(call?.[name]);
    if (value["subtype"] === "started") {
      return {
        events: [{ type: "tool_call", callId: normalizeCallId(callId), name, input: body?.["args"] ?? {} }],
        ...carry,
      };
    }
    if (value["subtype"] === "completed") {
      const result = body?.["result"];
      const failed = objectValue(result)?.["error"] !== undefined;
      return {
        events: [{
          type: "tool_result",
          callId: normalizeCallId(callId),
          output: clip(redactCursorSecrets(JSON.stringify(result ?? null))),
          ...(failed ? { isError: true } : {}),
        }],
        ...carry,
      };
    }
    return { events: [], ...carry };
  }

  if (type === "result") {
    const failed = value["is_error"] === true || value["subtype"] !== "success";
    const text = redactCursorSecrets(stringValue(value["result"]) ?? "");
    const usage = objectValue(value["usage"]);
    const events: AgentEvent[] = [];
    if (usage) {
      events.push({
        type: "usage",
        usage: {
          inputTokens: numberValue(usage["input_tokens"]),
          outputTokens: numberValue(usage["output_tokens"]),
          costUsd: 0,
        },
      });
    }
    if (failed) {
      events.push(errorEvent(`Cursor did not finish this turn: ${text || String(value["subtype"] ?? "unknown")}`));
      return { events, failed: true, ...carry };
    }
    return { events, finished: true, assistantText: text, ...carry };
  }

  return { events: [], ...carry };
};

const canAccess = async (filePath: string, mode = constants.F_OK): Promise<boolean> => {
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
};

/**
 * Picks the newest install directory, mirroring the vendor shim's rule:
 * YYYY.MM.DD-commit, optionally with a build timestamp between date and commit.
 */
export const pickLatestCursorVersion = (entries: readonly string[]): string | undefined => {
  const sortKey = (name: string): number => {
    const [year, month, day] = name.split("-")[0]!.split(".");
    return Number(`${year}${(month ?? "").padStart(2, "0")}${(day ?? "").padStart(2, "0")}`);
  };
  return [...entries]
    .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(name))
    .sort((a, b) => sortKey(b) - sortKey(a))[0];
};

const latestVersionDirectory = async (root: string): Promise<string | undefined> => {
  try {
    return pickLatestCursorVersion(await readdir(root));
  } catch {
    return undefined;
  }
};

/**
 * On Windows the Cursor CLI is a `cursor-agent.cmd` shim, and Node refuses to spawn
 * a `.cmd` without a shell (EINVAL). Running it through a shell would re-parse the
 * prompt text, so DayCrew instead resolves the bundled `node.exe index.js` exactly as
 * the vendor's own shim does, and passes every argument as real argv.
 */
const resolveWindowsCommand = async (directory: string): Promise<ResolvedCommand | undefined> => {
  const sameDirectory = path.join(directory, "node.exe");
  if ((await canAccess(sameDirectory)) && (await canAccess(path.join(directory, "index.js")))) {
    return { executable: sameDirectory, prefixArguments: [path.join(directory, "index.js")] };
  }
  const versions = path.join(directory, "versions");
  const latest = await latestVersionDirectory(versions);
  if (latest === undefined) return undefined;
  const node = path.join(versions, latest, "node.exe");
  const entry = path.join(versions, latest, "index.js");
  if (!(await canAccess(node)) || !(await canAccess(entry))) return undefined;
  return { executable: node, prefixArguments: [entry] };
};

export const resolveCursorCommand = async (configured?: readonly [string, ...string[]]): Promise<ResolvedCommand> => {
  if (configured) return { executable: configured[0], prefixArguments: configured.slice(1) };
  const configuredBinary = process.env["DAYCREW_CURSOR_BINARY"];
  if (configuredBinary) return { executable: configuredBinary, prefixArguments: [] };
  // The installer ships `cursor-agent`; the docs use `agent` in examples.
  if (process.platform !== "win32") return { executable: "cursor-agent", prefixArguments: [] };
  const candidates = [
    ...(process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean),
    // The installer adds this to the user PATH, which a running server may predate.
    path.join(process.env["LOCALAPPDATA"] ?? "", "cursor-agent"),
  ];
  for (const entry of candidates) {
    if (!(await canAccess(path.join(entry, "cursor-agent.cmd")))) continue;
    const resolved = await resolveWindowsCommand(entry);
    if (resolved) return resolved;
  }
  for (const entry of candidates) {
    const executable = path.join(entry, "cursor-agent.exe");
    if (await canAccess(executable)) return { executable, prefixArguments: [] };
  }
  return { executable: "cursor-agent.exe", prefixArguments: [] };
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

const containsPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * Cursor enforces permissions from `<project>/.cursor/cli.json`, so DayCrew writes a
 * deny-first file for the disposable Workspace instead of relying on a prompt that
 * nothing can answer in headless mode.
 */
const writeDenyFirstPermissions = async (workspacePath: string): Promise<void> => {
  const directory = path.join(workspacePath, ".cursor");
  await mkdir(directory, { recursive: true });
  const policy = {
    permissions: {
      deny: ["Shell(*)", "Write(**)", "WebFetch(*)", "Mcp(*)"],
      allow: ["Read(**)"],
    },
  };
  await writeFile(path.join(directory, "cli.json"), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
};

/** Parses `cursor-agent models`, which prints one model identifier per line. */
export const parseCursorModels = (stdout: string): EngineModel[] => {
  const models: EngineModel[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    // Tolerate bullets, selection markers and trailing annotations without inventing ids.
    const line = raw.replace(/^[\s*\-•>]+/, "").trim();
    const id = line.split(/\s{2,}|\s*[(|]/)[0]?.trim() ?? "";
    if (id === "" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id) || seen.has(id)) continue;
    // A heading such as "Available models:" never matches the identifier shape above,
    // but a single bare word could, so require something model-like.
    if (!/[0-9.\-/]/.test(id) && id.length < 4) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
};

const terminateProcess = async (child: CursorChild): Promise<void> => {
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

class CursorAgentHandle implements AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private chatId: string | undefined;
  private active: CursorChild | undefined;
  private stopped = false;
  private readonly cancelledChildren = new WeakSet<CursorChild>();
  private sawResult = false;
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
    return this.chatId;
  }

  async updateInstructions(instructions: string): Promise<void> {
    this.instructions = instructions;
  }

  async send(input: AgentInput): Promise<void> {
    const parsed = AgentInputSchema.parse(input);
    if (this.stopped) throw new Error("Cursor agent is stopped");
    if (this.active) throw new Error("Cursor agent already has an active turn");
    if (parsed.type === "approval-decision") {
      throw new Error("Cursor native approvals are not bridged; DayCrew fails closed");
    }
    this.sawResult = false;
    this.failed = false;
    this.assistantText = "";
    const arguments_ = [
      "--print",
      "--output-format", "stream-json",
      // Never --force / --yolo: DayCrew must not bypass the CLI's permission rules.
      ...(this.spec.model === undefined ? [] : ["--model", this.spec.model]),
      ...(this.chatId ? ["--resume", this.chatId] : []),
      this.promptFor(parsed),
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
      if (!this.stopped) this.emit(errorEvent(`Failed to start Cursor: ${error.message}`));
    });
    child.once("close", (code) => {
      if (this.active === child) this.active = undefined;
      if (this.stopped || this.cancelledChildren.has(child)) return;
      if (code !== 0 && !this.sawResult) {
        this.emit(errorEvent(`Cursor exited with code ${code ?? "unknown"}: ${redactCursorSecrets(stderr.trim()) || "no diagnostic"}`));
        return;
      }
      if (!this.sawResult) {
        this.emit(errorEvent("Cursor exited without a result event"));
        return;
      }
      if (this.failed) return;
      this.emit({ type: "done", ...(this.assistantText.trim() === "" ? {} : { summary: this.assistantText.trim() }) });
    });
  }

  async interrupt(): Promise<void> {
    const child = this.active;
    if (!child) return;
    this.active = undefined;
    this.cancelledChildren.add(child);
    await terminateProcess(child);
    if (!this.stopped) this.emit(errorEvent("Cursor agent was cancelled", true));
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
    const normalized = normalizeCursorStreamLine(line);
    if (normalized.sessionId) this.chatId = normalized.sessionId;
    if (normalized.assistantText) this.assistantText = normalized.assistantText;
    if (normalized.finished) this.sawResult = true;
    if (normalized.failed) { this.sawResult = true; this.failed = true; }
    for (const event of normalized.events) this.emit(event);
  }

  private emit(event: AgentEvent): void {
    if (this.stopped) return;
    this.queue.push(AgentEventSchema.parse(event));
  }

  private promptFor(input: Exclude<AgentInput, { type: "approval-decision" }>): string {
    const inputText =
      input.type === "goal"
        ? input.text
        : `Message from ${input.message.fromMemberId} about task ${input.message.taskId ?? "none"}:\n${input.message.subject}\n${input.message.body}`;
    const boundary = "This is a read-only preview: do not modify files, use network tools, publish, push, spend money or access credentials.";
    if (this.spec.mode === "conversation") {
      return `${this.instructions}\n\nYou are ${this.spec.memberId}, role: ${this.spec.role}.\nThis is a chat, not a work Goal. Respond to the latest user message. Do not invent other agents' responses. ${boundary}\n\n${inputText}`;
    }
    return `${this.instructions}\n\nCurrent DayCrew Member id: ${this.spec.memberId}\nCurrent role: ${this.spec.role}\n\n${inputText}\n\nDayCrew provider rules:\n- ${boundary}\n- Report findings as prose. DayCrew reads your final message, not a task format.`;
  }
}

export class CursorProvider implements ProviderAdapter {
  readonly id = "cursor";
  readonly displayName = "Cursor CLI (read-only preview)";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolUse: true,
    approvals: false,
    interruption: true,
    resume: true,
    skillCapabilities: ["filesystem.read"],
  };
  readonly security: CursorSecurityProfile = {
    mode: "read-only-planning",
    productionReady: false,
    nativeApprovalBridge: false,
    writesAllowed: false,
    unconfinedReadsRequireExplicitOptIn: true,
    limitations: [
      "Cursor CLI permissions are a static allow/deny config file, not a pre-execution callback DayCrew can answer.",
      "DayCrew writes a deny-first .cursor/cli.json for the run and never passes --force or --yolo.",
      "Because the deny list cannot be verified from outside the CLI, runs are confined to an explicitly acknowledged disposable Workspace.",
      "Streaming granularity is one complete assistant message, not token deltas.",
      "Cost is not reported by the CLI and is recorded as zero.",
    ],
  };

  constructor(private readonly options: CursorProviderOptions = {}) {}

  /**
   * `cursor-agent status` reports whether the CLI is signed in. Installation and
   * authentication are reported separately so Settings can tell them apart.
   */
  async detect(): Promise<ProviderDetection> {
    const timeout = this.options.detectionTimeoutMs ?? 10_000;
    try {
      const command = await resolveCursorCommand(this.options.command);
      const versionResult = await capture(command, ["--version"], timeout);
      if (versionResult.code !== 0) {
        // The program answered, so it exists; nothing here proves anything about sign-in.
        return {
          available: false, installed: true,
          reason: redactCursorSecrets(versionResult.stderr.trim()) || "Cursor CLI failed to report its version",
        };
      }
      const version = (versionResult.stdout.trim().match(/\d+\.\d+\.\d+/) ?? [])[0] ?? "";
      const status = await capture(command, ["status"], timeout);
      const output = `${status.stdout}\n${status.stderr}`;
      const signedOut = /not\s+(logged|signed)\s*[- ]?in|unauthenticated|please\s+(log|sign)\s*in/i.test(output);
      if (status.code !== 0 || signedOut) {
        // A non-zero `status` without a recognizable signed-out message is ambiguous:
        // report sign-in as unknown rather than asserting the account is signed out.
        return {
          available: false, installed: true, ...(signedOut ? { authenticated: false } : {}),
          ...(version === "" ? {} : { version }),
          reason: signedOut
            ? "Cursor CLI is installed but not signed in; run `cursor-agent login`"
            : redactCursorSecrets(status.stderr.trim()) || "Cursor CLI did not report its sign-in status",
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
          ? "Cursor CLI was not found on PATH"
          : `Cursor CLI could not be checked: ${redactCursorSecrets(message)}`,
      };
    }
  }

  /** `cursor-agent models` lists what the signed-in account may actually use. */
  async listModels(): Promise<EngineModel[]> {
    const command = await resolveCursorCommand(this.options.command);
    let result;
    try {
      result = await capture(command, ["models"], this.options.detectionTimeoutMs ?? 10_000);
    } catch (error) {
      // Surface a sentence someone can act on, never a raw spawn error.
      throw new Error((error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Cursor CLI was not found on PATH. Install it, then run `cursor-agent login`."
        : `Cursor CLI could not list its models: ${redactCursorSecrets(error instanceof Error ? error.message : String(error))}`);
    }
    if (result.code !== 0) {
      throw new Error(redactCursorSecrets(result.stderr.trim()) || "Cursor CLI could not list its models. Check that it is signed in.");
    }
    return parseCursorModels(result.stdout);
  }

  async startAgent(spec: AgentSpec): Promise<AgentHandle> {
    const parsed = AgentSpecSchema.parse(spec);
    if (!this.options.allowUnconfinedReads) {
      throw new Error(
        "Cursor is restricted to explicit isolated-workspace opt-in because its permission model is a config file, not a DayCrew-answerable callback",
      );
    }
    const workspacePath = await realpath(parsed.workspacePath);
    if (workspacePath === path.parse(workspacePath).root) {
      throw new Error("Cursor cannot use a filesystem root as its Workspace");
    }
    if (this.options.allowedWorkspaceRoots) {
      const allowedRoots = await Promise.all(this.options.allowedWorkspaceRoots.map((root) => realpath(root)));
      if (!allowedRoots.some((root) => containsPath(root, workspacePath))) {
        throw new Error("Cursor Workspace is outside the configured allowed roots");
      }
    }
    const detection = await this.detect();
    if (!detection.available) throw new Error(detection.reason ?? "Cursor is unavailable");
    await writeDenyFirstPermissions(workspacePath);
    return new CursorAgentHandle(await resolveCursorCommand(this.options.command), parsed, workspacePath);
  }
}
