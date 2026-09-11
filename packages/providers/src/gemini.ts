import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
} from "@daycrew/shared";

import { AsyncQueue } from "./async-queue.js";

interface JsonObject {
  readonly [key: string]: unknown;
}

interface ResolvedCommand {
  readonly executable: string;
  readonly prefixArguments: readonly string[];
}

export interface AntigravityConnectionOptions {
  readonly endpoint: string;
  /** Kept only in memory; never logged or persisted. */
  readonly csrfToken: string;
  readonly languageServerCommand: readonly [string, ...string[]];
  readonly projectId?: string;
  readonly version?: string;
}

export interface GeminiProviderOptions {
  /** Explicit local connection, primarily for packaged hosts and deterministic tests. */
  readonly connection?: AntigravityConnectionOptions;
  /** Explicitly permits empirical use only in an OS-temp disposable fixture. */
  readonly allowUnsafeDisposableWorkspace?: boolean;
  readonly allowedWorkspaceRoots?: readonly string[];
  readonly detectionTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly allowDayCrewRepository?: boolean;
}

export interface GeminiSecurityProfile {
  readonly mode: "restricted-read-only-preview";
  readonly productionReady: false;
  readonly nativeApprovalBridge: false;
  readonly writableSupported: false;
  readonly providerMayMutateWorkspace: true;
  readonly workspaceBoundaryEnforced: false;
  readonly mcpControlled: false;
  readonly limitations: readonly string[];
}

export interface NormalizedAntigravityStep {
  readonly events: readonly AgentEvent[];
  readonly assistantText?: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly providerError?: string;
}

interface AntigravityBridge {
  readonly endpoint: string;
  readonly csrfToken: string;
  readonly projectId: string;
  readonly command: ResolvedCommand;
  readonly version?: string;
}

interface DayCrewGeminiOutput {
  readonly summary: string;
  readonly complete: boolean;
  readonly tasks: readonly unknown[];
}

const objectValue = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const arrayValue = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const numberValue = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
};

const secretPatterns: readonly RegExp[] = [
  /AIza[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._-]{12,}/g,
  /eyJ[A-Za-z0-9._-]{20,}/g,
];

export const redactGeminiSecrets = (value: string): string =>
  secretPatterns.reduce((text, pattern) => text.replace(pattern, "[redacted]"), value);

const clip = (value: string, limit = 4_000): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

const sanitizeUnknown = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redactGeminiSecrets(clip(value));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => sanitizeUnknown(entry, depth + 1));
  const object = objectValue(value);
  if (!object) return String(value);
  return Object.fromEntries(
    Object.entries(object)
      .slice(0, 50)
      .map(([key, entry]) => [key, sanitizeUnknown(entry, depth + 1)]),
  );
};

const normalizeCallId = (raw: string): string => {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "" ? "antigravity-tool-call" : normalized;
};

const errorEvent = (message: string, recoverable = false): AgentEvent => ({
  type: "error",
  message: redactGeminiSecrets(message),
  recoverable,
});

const stepToolCall = (step: JsonObject): JsonObject | undefined => {
  const planner = objectValue(step["plannerResponse"]);
  const requested = objectValue(arrayValue(planner?.["toolCalls"])[0]);
  return requested ?? objectValue(objectValue(step["metadata"])?.["toolCall"]);
};

const toolResultSummary = (step: JsonObject): string => {
  const summary = stringValue(objectValue(step["metadata"])?.["toolSummary"]);
  if (summary) return redactGeminiSecrets(summary);
  const type = (stringValue(step["type"]) ?? "tool").replace(/^CORTEX_STEP_TYPE_/, "");
  return `${type.toLowerCase().replaceAll("_", " ")} completed`;
};

/** Maps one Antigravity trajectory step to DayCrew's provider-neutral events. */
export const normalizeAntigravityTrajectoryStep = (value: unknown): NormalizedAntigravityStep => {
  const step = objectValue(value);
  if (!step || step["status"] !== "CORTEX_STEP_STATUS_DONE") return { events: [] };
  const metadata = objectValue(step["metadata"]);
  const modelUsage = objectValue(metadata?.["modelUsage"]);
  const inputTokens = numberValue(modelUsage?.["inputTokens"]);
  const outputTokens = numberValue(modelUsage?.["outputTokens"]);
  const usage = inputTokens === 0 && outputTokens === 0 ? undefined : { inputTokens, outputTokens };
  const type = stringValue(step["type"]) ?? "";

  if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
    const planner = objectValue(step["plannerResponse"]);
    const events: AgentEvent[] = [];
    for (const rawCall of arrayValue(planner?.["toolCalls"])) {
      const call = objectValue(rawCall);
      if (!call) continue;
      let arguments_: unknown = {};
      const argumentsJson = stringValue(call["argumentsJson"]);
      if (argumentsJson) {
        try {
          arguments_ = sanitizeUnknown(JSON.parse(argumentsJson));
        } catch {
          arguments_ = { unparsed: redactGeminiSecrets(clip(argumentsJson)) };
        }
      }
      events.push(
        AgentEventSchema.parse({
          type: "tool_call",
          callId: normalizeCallId(stringValue(call["id"]) ?? "antigravity-tool-call"),
          name: stringValue(call["name"]) ?? stringValue(call["originalName"]) ?? "Antigravity tool",
          input: arguments_,
        }),
      );
    }
    const response = redactGeminiSecrets(
      stringValue(planner?.["modifiedResponse"]) ?? stringValue(planner?.["response"]) ?? "",
    );
    if (response) events.push(AgentEventSchema.parse({ type: "text", text: response }));
    return {
      events,
      ...(response === "" ? {} : { assistantText: response }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  if (type === "CORTEX_STEP_TYPE_ERROR_MESSAGE") {
    const error = objectValue(objectValue(step["errorMessage"])?.["error"]);
    const message =
      stringValue(error?.["userErrorMessage"]) ??
      stringValue(error?.["shortError"]) ??
      "Antigravity execution failed";
    return {
      events: [],
      providerError: redactGeminiSecrets(message),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  const call = stepToolCall(step);
  const events = call
    ? [
        AgentEventSchema.parse({
          type: "tool_result",
          callId: normalizeCallId(stringValue(call["id"]) ?? "antigravity-tool-call"),
          output: toolResultSummary(step),
          isError: false,
        }),
      ]
    : [];
  return { events, ...(usage === undefined ? {} : { usage }) };
};

const containsPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const canAccess = async (filePath: string, mode = constants.F_OK): Promise<boolean> => {
  try {
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
};

const safeEnvironment = (): NodeJS.ProcessEnv => {
  const names = [
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "WINDIR", "USERPROFILE",
    "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "LANG",
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
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.prefixArguments, ...arguments_], {
      env: environment,
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

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const parseJsonObject = (text: string): JsonObject => {
  const parsed = objectValue(JSON.parse(text));
  if (!parsed) throw new Error("Expected a JSON object");
  return parsed;
};

const fetchConnect = async (
  bridge: Pick<AntigravityBridge, "endpoint" | "csrfToken">,
  method: string,
  body: JsonObject,
  timeoutMs: number,
): Promise<JsonObject> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${bridge.endpoint}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "x-codeium-csrf-token": bridge.csrfToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = stringValue(parseJsonObject(text)["message"]) ?? text;
      } catch {
        // Preserve a plain provider diagnostic.
      }
      throw new Error(redactGeminiSecrets(message || `Antigravity HTTP ${response.status}`));
    }
    return text.trim() === "" ? {} : parseJsonObject(text);
  } finally {
    clearTimeout(timer);
  }
};

const discoveryScript = [
  "$p=Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Select-Object -First 1",
  "if(-not $p){exit 4}",
  "$m=[regex]::Match($p.CommandLine,'csrf_token[= ]+([^ ]+)')",
  "if(-not $m.Success){exit 5}",
  "$ports=Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen | Where-Object LocalAddress -eq '127.0.0.1' | ForEach-Object LocalPort",
  "[pscustomobject]@{csrf=$m.Groups[1].Value.Trim('\\\"');ports=@($ports)}|ConvertTo-Json -Compress",
].join(";");

const installPaths = (): { app: string; languageServer: string } => {
  const localAppData = process.env["LOCALAPPDATA"];
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable");
  const root = path.join(localAppData, "Programs", "antigravity");
  return {
    app: path.join(root, "Antigravity.exe"),
    languageServer: path.join(root, "resources", "bin", "language_server.exe"),
  };
};

const discoverRunningBridge = async (
  languageServer: string,
  timeoutMs: number,
): Promise<AntigravityBridge | undefined> => {
  const result = await capture(
    { executable: "powershell.exe", prefixArguments: [] },
    ["-NoProfile", "-NonInteractive", "-Command", discoveryScript],
    safeEnvironment(),
    timeoutMs,
  );
  if (result.code !== 0 || result.stdout.trim() === "") return undefined;
  const discovered = parseJsonObject(result.stdout);
  const csrfToken = stringValue(discovered["csrf"]);
  if (!csrfToken) return undefined;
  const ports = arrayValue(discovered["ports"]).map(numberValue).filter((port) => port > 0);
  for (const port of ports) {
    const bridge: AntigravityBridge = {
      endpoint: `http://127.0.0.1:${port}`,
      csrfToken,
      projectId: "outside-of-project",
      command: { executable: languageServer, prefixArguments: [] },
    };
    try {
      await fetchConnect(bridge, "GetWorkspaceInfos", {}, Math.min(timeoutMs, 5_000));
      return bridge;
    } catch {
      // The other loopback port speaks raw gRPC rather than Connect JSON.
    }
  }
  return undefined;
};

const fileVersion = async (filePath: string, timeoutMs: number): Promise<string | undefined> => {
  const escaped = filePath.replaceAll("'", "''");
  const result = await capture(
    { executable: "powershell.exe", prefixArguments: [] },
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`],
    safeEnvironment(),
    timeoutMs,
  );
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
};

const bridgeFromOptions = (options: AntigravityConnectionOptions): AntigravityBridge => ({
  endpoint: options.endpoint.replace(/\/$/, ""),
  csrfToken: options.csrfToken,
  projectId: options.projectId ?? "outside-of-project",
  command: {
    executable: options.languageServerCommand[0],
    prefixArguments: options.languageServerCommand.slice(1),
  },
  ...(options.version === undefined ? {} : { version: options.version }),
});

const resolveModel = (model: string | undefined): "flash_lite" | "flash" | "pro" => {
  if (model === undefined || (/flash/i.test(model) && !/lite/i.test(model))) return "flash";
  if (/flash[_ -]?lite/i.test(model)) return "flash_lite";
  if (/pro/i.test(model)) return "pro";
  throw new Error(`Antigravity Agent API does not expose model ${model}`);
};

const parseAgentApiResponse = (stdout: string): JsonObject => {
  const payload = parseJsonObject(stdout);
  const error = stringValue(payload["error"]);
  if (error) throw new Error(redactGeminiSecrets(error));
  return objectValue(payload["response"]) ?? {};
};

const parseDayCrewOutput = (text: string): DayCrewGeminiOutput | undefined => {
  const marked = /DAYCREW_RESULT_START\s*([\s\S]*?)\s*DAYCREW_RESULT_END/i.exec(text)?.[1];
  const candidate = (marked ?? text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const value = parseJsonObject(candidate);
    if (
      typeof value["summary"] !== "string" ||
      typeof value["complete"] !== "boolean" ||
      !Array.isArray(value["tasks"])
    ) return undefined;
    return { summary: value["summary"], complete: value["complete"], tasks: value["tasks"] };
  } catch {
    return undefined;
  }
};

class AntigravityAgentHandle implements AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private conversationId: string | undefined;
  private active = false;
  private stopped = false;
  private generation = 0;
  private emittedSteps = 0;
  private assistantText = "";

  constructor(
    private readonly bridge: AntigravityBridge,
    private readonly spec: AgentSpec,
    private readonly workspacePath: string,
    private readonly timeoutMs: number,
    private readonly pollIntervalMs: number,
  ) {
    this.events = this.queue;
  }

  getSessionIdentity(): string | undefined {
    return this.conversationId;
  }

  async send(input: AgentInput): Promise<void> {
    const parsed = AgentInputSchema.parse(input);
    if (this.stopped) throw new Error("Gemini / Antigravity agent is stopped");
    if (this.active) throw new Error("Gemini / Antigravity agent already has an active turn");
    if (parsed.type === "approval-decision") {
      throw new Error("Antigravity exposes no safe DayCrew approval bridge; the adapter fails closed");
    }
    this.active = true;
    this.assistantText = "";
    const generation = ++this.generation;
    const prompt = this.promptFor(parsed);
    try {
      if (this.conversationId) {
        await this.runAgentApi(["send-message", this.conversationId, prompt]);
      } else {
        const response = await this.runAgentApi([
          "new-conversation",
          `--model=${resolveModel(this.spec.model)}`,
          prompt,
        ]);
        const created = objectValue(response["newConversation"]);
        const id = stringValue(created?.["conversationId"]);
        if (!id) throw new Error("Antigravity did not create a conversation");
        this.conversationId = id;
      }
      void this.pollTurn(generation);
    } catch (error) {
      this.active = false;
      const message = error instanceof Error ? error.message : String(error);
      this.emit(errorEvent(`Antigravity turn failed: ${message}`));
    }
  }

  async interrupt(): Promise<void> {
    if (!this.active || !this.conversationId) return;
    this.active = false;
    this.generation += 1;
    try {
      await fetchConnect(
        this.bridge,
        "CancelCascadeInvocation",
        { cascadeId: this.conversationId, killBackgroundTasks: true },
        this.timeoutMs,
      );
      this.emit(errorEvent("Gemini / Antigravity agent was cancelled", true));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(errorEvent(`Antigravity cancellation failed: ${message}`));
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.active) await this.interrupt();
    this.stopped = true;
    this.generation += 1;
    this.queue.close();
  }

  private async runAgentApi(arguments_: readonly string[]): Promise<JsonObject> {
    const environment = {
      ...safeEnvironment(),
      ANTIGRAVITY_LS_ADDRESS: new URL(this.bridge.endpoint).host,
      ANTIGRAVITY_CSRF_TOKEN: this.bridge.csrfToken,
      ANTIGRAVITY_PROJECT_ID: this.bridge.projectId,
    };
    const result = await capture(
      this.bridge.command,
      ["agentapi", ...arguments_],
      environment,
      this.timeoutMs,
    );
    if (result.code !== 0) {
      throw new Error(redactGeminiSecrets(result.stderr.trim() || "Antigravity Agent API failed"));
    }
    return parseAgentApiResponse(result.stdout);
  }

  private async pollTurn(generation: number): Promise<void> {
    let idleObservations = 0;
    while (!this.stopped && this.active && generation === this.generation) {
      try {
        const response = await fetchConnect(
          this.bridge,
          "GetCascadeTrajectory",
          { cascadeId: this.conversationId },
          this.timeoutMs,
        );
        const steps = arrayValue(objectValue(response["trajectory"])?.["steps"]);
        this.consumeSteps(steps);
        const hasRunningStep = steps.some(
          (step) => objectValue(step)?.["status"] !== "CORTEX_STEP_STATUS_DONE",
        );
        idleObservations = response["status"] === "CASCADE_RUN_STATUS_IDLE" && !hasRunningStep
          ? idleObservations + 1
          : 0;
        if (idleObservations >= 2) {
          this.active = false;
          this.finishTurn();
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/trajectory not found/i.test(message)) {
          this.active = false;
          this.emit(errorEvent(`Antigravity trajectory failed: ${message}`));
          return;
        }
      }
      await delay(this.pollIntervalMs);
    }
  }

  private consumeSteps(steps: readonly unknown[]): void {
    for (let index = this.emittedSteps; index < steps.length; index += 1) {
      const step = steps[index];
      if (objectValue(step)?.["status"] !== "CORTEX_STEP_STATUS_DONE") break;
      const normalized = normalizeAntigravityTrajectoryStep(step);
      this.emittedSteps = index + 1;
      if (normalized.assistantText) this.assistantText += normalized.assistantText;
      for (const event of normalized.events) this.emit(event);
      if (normalized.usage) {
        this.emit(
          AgentEventSchema.parse({
            type: "usage",
            usage: { ...normalized.usage, costUsd: 0 },
          }),
        );
      }
      if (normalized.providerError) this.emit(errorEvent(normalized.providerError));
    }
  }

  private finishTurn(): void {
    if (this.stopped) return;
    const result = parseDayCrewOutput(this.assistantText);
    if (!result) {
      this.emit(errorEvent("Antigravity did not return a valid DayCrew result envelope"));
      return;
    }
    for (const task of result.tasks) {
      const parsed = AgentEventSchema.safeParse({ type: "task_update", task });
      if (!parsed.success) {
        this.emit(errorEvent(`Antigravity returned an invalid DayCrew task: ${parsed.error.message}`));
        return;
      }
      if (
        parsed.data.type === "task_update" &&
        !this.spec.role.toLowerCase().includes("manager") &&
        parsed.data.task.ownerId !== this.spec.memberId
      ) {
        this.emit({ type: "task_update", task: { ...parsed.data.task, ownerId: this.spec.memberId } });
      } else this.emit(parsed.data);
    }
    this.emit(result.complete ? { type: "done", summary: result.summary } : { type: "turn_end" });
  }

  private promptFor(input: Exclude<AgentInput, { type: "approval-decision" }>): string {
    const inputText = input.type === "goal"
      ? input.text
      : `Message from ${input.message.fromMemberId} about task ${input.message.taskId ?? "none"}:\n${input.message.subject}\n${input.message.body}`;
    return [
      this.spec.instructions,
      "",
      `Current DayCrew Member id: ${this.spec.memberId}`,
      `Current role: ${this.spec.role}`,
      `Workspace absolute path: ${this.workspacePath}`,
      "",
      inputText,
      "",
      "DayCrew provider rules:",
      "- This is a restricted read-only preview. Never create, edit, move, or delete files; never run commands; never use network, browser, git, MCP, publishing, or credential tools.",
      `- Read only ordinary non-secret files below ${this.workspacePath}. Never access any other path.`,
      "- A denied or unavailable action is final. Do not retry it through another tool or path.",
      "- Finish with one machine-readable envelope between DAYCREW_RESULT_START and DAYCREW_RESULT_END.",
      "- The envelope is JSON: {\"summary\":string,\"complete\":boolean,\"tasks\":[{\"id\":string,\"title\":string,\"description\":string,\"status\":\"todo\"|\"in-progress\"|\"review\"|\"done\",\"ownerId\":string,\"dependsOn\":string[],\"needsYou\":boolean}]}",
      "- Use stable lowercase DayCrew ids with hyphens. Use only Member ids supplied in the prompt.",
      "- A Manager should create delegated todo tasks with complete=false only when another Member must work.",
      `- A specialist must preserve ownerId=${this.spec.memberId}, update the supplied task id to review, and set complete=true.`,
      "- A Manager reviewing completed work should update it to done and set complete=true when all work is reviewed.",
      "- Use an empty tasks array when no task operation is appropriate.",
    ].join("\n");
  }

  private emit(event: AgentEvent): void {
    if (!this.stopped) this.queue.push(AgentEventSchema.parse(event));
  }
}

const daycrewMarkers = ["pnpm-workspace.yaml", path.join("packages", "shared", "src")];
const looksLikeDayCrewRepository = async (candidate: string): Promise<boolean> =>
  (await Promise.all(daycrewMarkers.map((marker) => canAccess(path.join(candidate, marker))))).every(Boolean);

export class GeminiProvider implements ProviderAdapter {
  readonly id = "gemini";
  readonly displayName = "Gemini / Antigravity (restricted preview)";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolUse: true,
    approvals: false,
    interruption: true,
    resume: true,
  };
  readonly security: GeminiSecurityProfile = {
    mode: "restricted-read-only-preview",
    productionReady: false,
    nativeApprovalBridge: false,
    writableSupported: false,
    providerMayMutateWorkspace: true,
    workspaceBoundaryEnforced: false,
    mcpControlled: false,
    limitations: [
      "Antigravity exposes completed trajectory steps but no reliable pre-execution permission callback to DayCrew.",
      "Observed metadata reports commandExecutionPolicy=eager and enforcedWorkspaceValidation=false.",
      "Workspace scope and read-only behavior are prompt restrictions, not enforceable security boundaries.",
      "Global Antigravity MCP/tool configuration cannot be disabled through Agent API.",
      "Output streams at trajectory-step granularity; token deltas are unavailable.",
      "Usage tokens are reported by Antigravity; monetary cost is unavailable.",
    ],
  };
  private bridge: AntigravityBridge | undefined;

  constructor(private readonly options: GeminiProviderOptions = {}) {}

  async detect(): Promise<ProviderDetection> {
    const timeoutMs = this.options.detectionTimeoutMs ?? 30_000;
    try {
      const bridge = await this.ensureBridge(timeoutMs);
      const models = await fetchConnect(bridge, "GetAvailableModels", {}, timeoutMs);
      if (!objectValue(models["response"]) && !objectValue(models["models"])) {
        return {
          available: false,
          ...(bridge.version === undefined ? {} : { version: bridge.version }),
          reason: "Antigravity is installed but its authenticated model catalog is unavailable",
        };
      }
      this.bridge = bridge;
      return { available: true, ...(bridge.version === undefined ? {} : { version: bridge.version }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        reason: `Antigravity is not installed, running, authenticated, or usable: ${redactGeminiSecrets(message)}`,
      };
    }
  }

  async startAgent(spec: AgentSpec): Promise<AgentHandle> {
    const parsed = AgentSpecSchema.parse(spec);
    if (!this.options.allowUnsafeDisposableWorkspace) {
      throw new Error("Gemini / Antigravity execution is unavailable by default because pre-execution controls are not exposed");
    }
    const workspacePath = await realpath(parsed.workspacePath);
    if (workspacePath === path.parse(workspacePath).root) {
      throw new Error("Gemini / Antigravity cannot use a filesystem root as its Workspace");
    }
    const temporaryRoot = await realpath(tmpdir());
    if (!containsPath(temporaryRoot, workspacePath)) {
      throw new Error("Gemini / Antigravity restricted preview may run only in an OS-temp disposable Workspace");
    }
    if (this.options.allowedWorkspaceRoots) {
      const roots = await Promise.all(this.options.allowedWorkspaceRoots.map((root) => realpath(root)));
      if (!roots.some((root) => containsPath(root, workspacePath))) {
        throw new Error("Gemini / Antigravity Workspace is outside the configured allowed roots");
      }
    }
    if (this.options.allowDayCrewRepository !== true && await looksLikeDayCrewRepository(workspacePath)) {
      throw new Error("Refusing to run Gemini / Antigravity against a DayCrew source checkout");
    }
    resolveModel(parsed.model);
    const detection = await this.detect();
    if (!detection.available || !this.bridge) throw new Error(detection.reason ?? "Antigravity is unavailable");
    return new AntigravityAgentHandle(
      this.bridge,
      parsed,
      workspacePath,
      this.options.detectionTimeoutMs ?? 30_000,
      this.options.pollIntervalMs ?? 250,
    );
  }

  private async ensureBridge(timeoutMs: number): Promise<AntigravityBridge> {
    if (this.options.connection) return bridgeFromOptions(this.options.connection);
    if (this.bridge) return this.bridge;
    if (process.platform !== "win32") {
      throw new Error("automatic Antigravity Agent API discovery is currently available only on Windows");
    }
    const install = installPaths();
    if (!(await canAccess(install.app)) || !(await canAccess(install.languageServer))) {
      throw new Error("Antigravity installation was not found");
    }
    let bridge = await discoverRunningBridge(install.languageServer, timeoutMs);
    if (!bridge) {
      const app = spawn(install.app, [], {
        detached: true,
        env: safeEnvironment(),
        stdio: "ignore",
        windowsHide: true,
      });
      app.unref();
      const deadline = Date.now() + timeoutMs;
      while (!bridge && Date.now() < deadline) {
        await delay(500);
        bridge = await discoverRunningBridge(install.languageServer, Math.min(timeoutMs, 5_000));
      }
    }
    if (!bridge) throw new Error("Antigravity local Agent API did not start");
    const version = await fileVersion(install.app, timeoutMs);
    return { ...bridge, ...(version === undefined ? {} : { version }) };
  }
}
