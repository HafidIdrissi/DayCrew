import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, writeFile } from "node:fs/promises";
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
  type EngineModel,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderDetection,
} from "@daycrew/shared";

import { AsyncQueue } from "./async-queue.js";

const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
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

interface DayCrewCodexOutput {
  readonly summary: string;
  readonly complete: boolean;
  readonly tasks: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly status: "todo" | "in-progress" | "review" | "done";
    readonly ownerId: string;
    readonly dependsOn: readonly string[];
    readonly needsYou: boolean;
  }>;
}

export interface NormalizedCodexLine {
  readonly events: readonly AgentEvent[];
  readonly threadId?: string;
  readonly turnCompleted?: boolean;
  readonly complete?: boolean;
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const errorEvent = (message: string, recoverable = false): AgentEvent => ({
  type: "error",
  message,
  recoverable,
});

const parseStructuredOutput = (text: string): DayCrewCodexOutput | undefined => {
  try {
    const value = objectValue(JSON.parse(text));
    if (
      !value ||
      typeof value["summary"] !== "string" ||
      typeof value["complete"] !== "boolean" ||
      !Array.isArray(value["tasks"])
    ) {
      return undefined;
    }
    return value as unknown as DayCrewCodexOutput;
  } catch {
    return undefined;
  }
};

/** Converts one Codex `exec --json` JSONL record without exposing it to core. */
export const normalizeCodexJsonLine = (line: string): NormalizedCodexLine => {
  let value: Record<string, unknown>;
  try {
    const parsed = objectValue(JSON.parse(line));
    if (!parsed) throw new Error("Expected an object");
    value = parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { events: [errorEvent(`Codex emitted invalid JSONL: ${message}`)] };
  }

  const type = value["type"];
  if (type === "thread.started" && typeof value["thread_id"] === "string") {
    return { events: [], threadId: value["thread_id"] };
  }
  if (type === "turn.completed") {
    const usage = objectValue(value["usage"]);
    const inputTokens = typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : 0;
    const outputTokens = typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : 0;
    return {
      events: [
        AgentEventSchema.parse({
          type: "usage",
          usage: { inputTokens, outputTokens, costUsd: 0 },
        }),
      ],
      turnCompleted: true,
    };
  }
  if (type === "turn.failed" || type === "error") {
    const nativeError = objectValue(value["error"]);
    const message =
      (typeof nativeError?.["message"] === "string" && nativeError["message"]) ||
      (typeof value["message"] === "string" && value["message"]) ||
      "Codex turn failed";
    return { events: [errorEvent(message)] };
  }
  if (type !== "item.started" && type !== "item.completed") return { events: [] };

  const item = objectValue(value["item"]);
  if (!item || typeof item["id"] !== "string" || typeof item["type"] !== "string") {
    return { events: [] };
  }
  if (item["type"] === "agent_message" && type === "item.completed") {
    const text = typeof item["text"] === "string" ? item["text"] : "";
    const output = parseStructuredOutput(text);
    if (!output) return { events: [AgentEventSchema.parse({ type: "text", text })] };
    const events: AgentEvent[] = [];
    for (const task of output.tasks) {
      const parsed = AgentEventSchema.safeParse({ type: "task_update", task });
      if (!parsed.success) {
        return { events: [errorEvent(`Codex returned an invalid DayCrew task: ${parsed.error.message}`)] };
      }
      events.push(parsed.data);
    }
    events.push(AgentEventSchema.parse({ type: "text", text: output.summary }));
    return { events, complete: output.complete };
  }
  if (item["type"] === "command_execution") {
    if (type === "item.started") {
      return {
        events: [
          AgentEventSchema.parse({
            type: "tool_call",
            callId: item["id"],
            name: "shell.read-only",
            input: { command: item["command"] },
          }),
        ],
      };
    }
    return {
      events: [
        AgentEventSchema.parse({
          type: "tool_result",
          callId: item["id"],
          output: item["aggregated_output"] ?? "",
          isError: typeof item["exit_code"] === "number" && item["exit_code"] !== 0,
        }),
      ],
    };
  }
  if (item["type"] === "file_change") {
    return {
      events: [errorEvent("Codex attempted a file change in DayCrew's read-only provider mode")],
    };
  }
  return { events: [] };
};

export interface CodexSecurityProfile {
  readonly mode: "read-only-planning";
  readonly productionReady: false;
  readonly nativeApprovalBridge: false;
  readonly writesAllowed: false;
  readonly unconfinedReadsRequireExplicitOptIn: true;
  readonly limitations: readonly string[];
}

export interface CodexProviderOptions {
  /** Explicit command and fixed prefix arguments, mainly for packaged installs/tests. */
  readonly command?: readonly [string, ...string[]];
  /** Required because current Codex read-only sandbox does not expose denied-read restrictions. */
  readonly allowUnconfinedReads?: boolean;
  readonly allowedWorkspaceRoots?: readonly string[];
  readonly detectionTimeoutMs?: number;
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

const resolveCommand = async (configured?: readonly [string, ...string[]]): Promise<ResolvedCommand> => {
  if (configured) return { executable: configured[0], prefixArguments: configured.slice(1) };
  const configuredBinary = process.env["DAYCREW_CODEX_BINARY"];
  if (configuredBinary) return { executable: configuredBinary, prefixArguments: [] };
  if (process.platform !== "win32") return { executable: "codex", prefixArguments: [] };

  for (const entry of (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    const shim = path.join(entry, "codex.cmd");
    const javascriptEntry = path.join(entry, "node_modules", "@openai", "codex", "bin", "codex.js");
    if ((await canAccess(shim)) && (await canAccess(javascriptEntry))) {
      return { executable: process.execPath, prefixArguments: [javascriptEntry] };
    }
  }
  return { executable: "codex.exe", prefixArguments: [] };
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
    "CODEX_HOME",
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

const ensureOutputSchema = async (): Promise<string> => {
  const schemaPath = path.join(tmpdir(), "daycrew-codex-output-v1.schema.json");
  await writeFile(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, "utf8");
  return schemaPath;
};

const containsPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

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

class CodexAgentHandle implements AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private threadId?: string;
  private active: ChildProcessWithoutNullStreams | undefined;
  private stopped = false;
  private readonly cancelledChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private lastComplete = false;
  private sawTurnCompletion = false;
  private instructions: string;

  constructor(
    private readonly command: ResolvedCommand,
    private readonly spec: AgentSpec,
    private readonly workspacePath: string,
    private readonly schemaPath: string,
  ) {
    this.events = this.queue;
    this.instructions = spec.instructions;
  }

  getSessionIdentity(): string | undefined {
    return this.threadId;
  }

  async updateInstructions(instructions: string): Promise<void> {
    this.instructions = instructions;
  }

  async send(input: AgentInput): Promise<void> {
    const parsed = AgentInputSchema.parse(input);
    if (this.stopped) throw new Error("Codex agent is stopped");
    if (this.active) throw new Error("Codex agent already has an active turn");
    if (parsed.type === "approval-decision") {
      throw new Error("Codex native approvals are not bridged; DayCrew fails closed");
    }
    this.lastComplete = false;
    this.sawTurnCompletion = false;
    const prompt = this.promptFor(parsed);
    const globalArguments = ["--sandbox", "read-only", "--ask-for-approval", "never"];
    const commonArguments = [
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--output-schema",
      this.schemaPath,
      ...(this.spec.model === undefined ? [] : ["--model", this.spec.model]),
    ];
    const arguments_ = this.threadId
      ? [...globalArguments, "exec", "resume", ...commonArguments, this.threadId, "-"]
      : [...globalArguments, "exec", ...commonArguments, "--color", "never", "-C", this.workspacePath, "-"];
    const child = spawn(this.command.executable, [...this.command.prefixArguments, ...arguments_], {
      cwd: this.workspacePath,
      env: safeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
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
      if (!this.stopped) this.emit(errorEvent(`Failed to start Codex: ${error.message}`));
    });
    child.once("close", (code) => {
      if (this.active === child) this.active = undefined;
      if (this.stopped || this.cancelledChildren.has(child)) return;
      if (code !== 0) {
        this.emit(errorEvent(`Codex exited with code ${code ?? "unknown"}: ${stderr.trim() || "no diagnostic"}`));
        return;
      }
      if (!this.sawTurnCompletion) {
        this.emit(errorEvent("Codex exited without a turn.completed event"));
        return;
      }
      this.emit(this.lastComplete ? { type: "done" } : { type: "turn_end" });
    });
    child.stdin.end(prompt, "utf8");
  }

  async interrupt(): Promise<void> {
    const child = this.active;
    if (!child) return;
    this.active = undefined;
    this.cancelledChildren.add(child);
    await terminateProcess(child);
    if (!this.stopped) this.emit(errorEvent("Codex agent was cancelled", true));
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
    const normalized = normalizeCodexJsonLine(line);
    if (normalized.threadId) this.threadId = normalized.threadId;
    if (normalized.complete !== undefined) this.lastComplete = normalized.complete;
    if (normalized.turnCompleted) this.sawTurnCompletion = true;
    for (const event of normalized.events) {
      if (
        event.type === "task_update" &&
        !this.spec.role.toLowerCase().includes("manager") &&
        event.task.ownerId !== this.spec.memberId
      ) {
        this.emit({
          type: "task_update",
          task: { ...event.task, ownerId: this.spec.memberId },
        });
      } else {
        this.emit(event);
      }
    }
  }

  private emit(event: AgentEvent): void {
    this.queue.push(AgentEventSchema.parse(event));
  }

  private promptFor(input: Exclude<AgentInput, { type: "approval-decision" }>): string {
    const inputText =
      input.type === "goal"
        ? input.text
        : `Message from ${input.message.fromMemberId} about task ${input.message.taskId ?? "none"}:\n${input.message.subject}\n${input.message.body}`;
    if (this.spec.mode === "conversation") {
      return `${this.instructions}\n\nYou are ${this.spec.memberId}, role: ${this.spec.role}.\nThis is a chat, not a work Goal. Respond to the latest user message using the structured output summary, tasks=[] and complete=true. Do not invent other agents' responses. This is a read-only preview: do not modify files, use network, publish, push, spend money or access credentials.\n\n${inputText}`;
    }
    return `${this.instructions}\n\nCurrent DayCrew Member id: ${this.spec.memberId}\nCurrent role: ${this.spec.role}\n\n${inputText}\n\nDayCrew provider rules:\n- This is a read-only planning and review session. Do not modify files, use network tools, publish, push, spend money, or access credentials.\n- Return only the structured object required by the output schema.\n- Use stable lowercase DayCrew ids with hyphens. Use only Member ids supplied in the prompt.\n- A Manager receiving a new goal should create delegated todo tasks and set complete=false.\n- A specialist must preserve ownerId=${this.spec.memberId}, update the supplied task id to review, and set complete=true.\n- A Manager reviewing a completed task should preserve its owner, update it to done, and set complete=true when all work is reviewed.\n- Use an empty tasks array only when no task operation is appropriate.`;
  }
}

export class CodexProvider implements ProviderAdapter {
  readonly id = "codex";
  readonly displayName = "Codex (read-only preview)";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolUse: true,
    approvals: false,
    interruption: true,
    resume: true,
    skillCapabilities: ["filesystem.read", "command.run"],
  };
  readonly security: CodexSecurityProfile = {
    mode: "read-only-planning",
    productionReady: false,
    nativeApprovalBridge: false,
    writesAllowed: false,
    unconfinedReadsRequireExplicitOptIn: true,
    limitations: [
      "Codex exec JSONL does not expose a DayCrew-controlled pre-execution approval bridge.",
      "The current read-only sandbox reports no denied-read restrictions, so credential reads cannot be guaranteed blocked.",
      "Workspace writes, git push, publishing, spending, and sensitive network actions are disabled.",
    ],
  };

  constructor(private readonly options: CodexProviderOptions = {}) {}

  /**
   * `codex debug models` prints the installed catalogue as JSON. Hidden entries are
   * internal aliases, so only listed, API-supported models are offered. Throws so a
   * caller can decide between falling back and surfacing the failure.
   */
  async listModels(): Promise<EngineModel[]> {
    const command = await resolveCommand(this.options.command);
    let result;
    try {
      result = await capture(command, ["debug", "models"], this.options.detectionTimeoutMs ?? 10_000);
    } catch (error) {
      // Surface a sentence someone can act on, never a raw spawn error.
      throw new Error((error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Codex CLI was not found on PATH. Install it, then run `codex login`."
        : `Codex CLI could not list its models: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Codex CLI could not list its models. Check that it is signed in.");
    }
    const start = result.stdout.indexOf("{");
    const end = result.stdout.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("Codex returned an unreadable model catalogue");
    const payload = objectValue(JSON.parse(result.stdout.slice(start, end + 1)));
    const models = Array.isArray(payload?.["models"]) ? (payload["models"] as readonly unknown[]) : [];
    return models.flatMap((entry): EngineModel[] => {
      const model = objectValue(entry);
      const slug = typeof model?.["slug"] === "string" ? model["slug"] : undefined;
      if (!model || !slug || model["visibility"] === "hide" || model["supported_in_api"] === false) return [];
      const label = typeof model["display_name"] === "string" && model["display_name"].trim() !== ""
        ? model["display_name"]
        : slug;
      const description = typeof model["description"] === "string" ? model["description"].slice(0, 300) : undefined;
      return [{ id: slug, label, ...(description === undefined ? {} : { description }) }];
    });
  }

  async detect(): Promise<ProviderDetection> {
    const timeout = this.options.detectionTimeoutMs ?? 10_000;
    try {
      const command = await resolveCommand(this.options.command);
      const versionResult = await capture(command, ["--version"], timeout);
      if (versionResult.code !== 0) {
        // The program answered, so it exists; nothing here proves anything about sign-in.
        return { available: false, installed: true, reason: versionResult.stderr.trim() || "Codex CLI failed to report its version" };
      }
      const version = versionResult.stdout.trim().replace(/^codex-cli\s+/i, "");
      const authResult = await capture(command, ["login", "status"], timeout);
      if (authResult.code !== 0 || !/logged in/i.test(`${authResult.stdout}\n${authResult.stderr}`)) {
        return {
          available: false, installed: true, authenticated: false,
          ...(version === "" ? {} : { version }),
          reason: authResult.stderr.trim() || authResult.stdout.trim() || "Codex is not authenticated; run `codex login`",
        };
      }
      return { available: true, installed: true, authenticated: true, ...(version === "" ? {} : { version }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only a missing executable proves absence; anything else leaves it unknown.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return {
        available: false, ...(missing ? { installed: false } : {}),
        reason: missing ? "Codex CLI was not found on PATH" : `Codex CLI could not be checked: ${message}`,
      };
    }
  }

  async startAgent(spec: AgentSpec): Promise<AgentHandle> {
    const parsed = AgentSpecSchema.parse(spec);
    if (!this.options.allowUnconfinedReads) {
      throw new Error(
        "Codex is restricted to explicit isolated-workspace opt-in because denied-read restrictions are unavailable",
      );
    }
    const workspacePath = await realpath(parsed.workspacePath);
    if (workspacePath === path.parse(workspacePath).root) {
      throw new Error("Codex cannot use a filesystem root as its Workspace");
    }
    if (this.options.allowedWorkspaceRoots) {
      const allowedRoots = await Promise.all(this.options.allowedWorkspaceRoots.map((root) => realpath(root)));
      if (!allowedRoots.some((root) => containsPath(root, workspacePath))) {
        throw new Error("Codex Workspace is outside the configured allowed roots");
      }
    }
    const detection = await this.detect();
    if (!detection.available) throw new Error(detection.reason ?? "Codex is unavailable");
    return new CodexAgentHandle(
      await resolveCommand(this.options.command),
      parsed,
      workspacePath,
      await ensureOutputSchema(),
    );
  }
}
