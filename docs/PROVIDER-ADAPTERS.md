# DayCrew Provider Adapters

**Status:** SPEC v0.1 — the engine extension contract. Interface lands in M0; first
implementations M3 (`claude-code`) and M3.5 (`codex`).

A **provider adapter** teaches DayCrew to run a team member on a specific engine
(Claude Code, Codex CLI, Gemini CLI, a local model, …). It is the **only** place
engine-specific code is allowed. `packages/core` must contain **zero** provider
names — CI greps for this.

> Adding an engine = one new folder in `packages/providers/` implementing the
> interface below. No `core` changes, ever.

---

## 1. The interface

```ts
// packages/shared — the contract both core and every adapter import

export interface ProviderAdapter {
  /** stable engine id, kebab-case: "claude-code" | "codex" | "gemini-cli" | "mock" */
  readonly id: string;
  readonly displayName: string;

  /** Is the underlying CLI/runtime installed and authenticated on this machine? */
  detect(): Promise<DetectResult>;

  readonly capabilities: ProviderCapabilities;

  /** Spawn one team member as a running session. */
  startAgent(spec: AgentSpec, ctx: RunContext): Promise<AgentHandle>;
}

export interface DetectResult {
  available: boolean;
  version?: string;
  reason?: string;            // when unavailable, a human-readable why
}

export interface ProviderCapabilities {
  streaming: boolean;             // emits text incrementally
  nativeToolUse: boolean;         // the engine runs tools itself
  nativePermissionPrompts: boolean; // the engine gates risky actions itself
  resume: boolean;               // sessions can be resumed by id/token
  mcp: boolean;                  // accepts MCP server configs
}

export interface AgentSpec {
  agentId: string;               // runtime id for this member instance
  memberId: string;              // the pack member id
  title: string;                 // user-facing label
  instructions: string;          // resolved system prompt (template vars already expanded)
  objective: string;
  cwd: string;                   // workspace jail — the adapter MUST run the engine here
  model?: string;
  permissionPolicy: PermissionPolicy;
  allowedTools?: string[];
  mcpServers?: McpServerConfig[];
  context?: {
    tasks?: Task[];
    inbox?: Message[];
    memory?: string;
  };
}

export interface RunContext {
  runId: string;
  emit(event: EngineEvent): void;   // adapter → core, for lifecycle/telemetry
  logSink: (chunk: string) => void; // raw transcript (core redacts + persists)
  signal: AbortSignal;              // aborted on run cancel
}

export interface AgentHandle {
  /** Deliver a turn: an objective kick-off, a routed message, or approval feedback. */
  send(input: AgentInput): Promise<void>;
  /** Normalized event stream. Core consumes ONLY this. */
  readonly events: AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;       // stop current turn, keep session
  stop(): Promise<void>;            // end session, free resources
  status(): AgentStatus;
}

export type AgentInput =
  | { kind: "objective"; text: string }
  | { kind: "message"; from: string; subject: string; body: string }
  | { kind: "approval_result"; requestId: string; decision: "approved" | "denied"; feedback?: string };
```

---

## 2. Normalized `AgentEvent`

Every adapter maps its engine's native output to exactly this union. Core never sees
anything else.

```ts
export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: unknown; isError?: boolean }
  | { type: "approval_request";
      actionClass: "shell.exec" | "fs.write" | "fs.delete" | "net.request"
                 | "spend" | "git.push" | "external.publish";
      summary: string;            // one line, human-readable
      payload: unknown;           // e.g. { command } or { path } or { url, method }
      nativeId?: string }         // engine's own prompt id, if it has one
  | { type: "task_update";
      task: { id?: string; title?: string; description?: string;
              status?: TaskStatus; assignee?: string; deps?: string[] } }
  | { type: "message_out"; to: string; act: MessageAct; subject: string; body: string }
  | { type: "artifact"; path: string; kind: string; description?: string }
  | { type: "usage"; usd?: number; tokens?: number; turns?: number }
  | { type: "turn_end" }
  | { type: "done"; summary?: string }
  | { type: "error"; message: string; fatal?: boolean };

export type AgentStatus =
  | "idle" | "thinking" | "acting" | "blocked-on-approval"
  | "waiting-on-dep" | "done" | "error" | "stopped";
```

### How task/message events arise

Engines don't natively emit `task_update` / `message_out`. Two supported mechanisms,
adapter's choice (document which):

1. **Structured convention** — core injects a small instruction block + gives the
   member tool-like directives (`daycrew_task`, `daycrew_message`) via MCP or a
   sentinel syntax the adapter parses out of the text stream.
2. **Filesystem convention** — the member writes to `outbox/` and a `tasks.json` in
   its run dir (the `hive` pattern); the adapter tails those and emits events.

The `mock` adapter implements mechanism 1 cleanly and is the reference.

---

## 3. Trust boundary (per adapter, must be documented)

| Engine trait | Adapter responsibility |
|---|---|
| `nativePermissionPrompts: true` (claude-code) | **Bridge** the native prompt → `approval_request` event; do NOT auto-answer. Relay core's decision back to the native prompt. |
| `nativePermissionPrompts: false` | Run the engine in its most restricted mode; classify risky actions from the tool stream and emit `approval_request` **before** they execute, or run with tools disabled and require the engine to request them. |
| all | Honor `cwd` as a jail. Never spawn the engine outside `spec.cwd`. Pass through `permissionPolicy` where the engine supports it. |
| all | Redact nothing yourself — send raw to `ctx.logSink`; core does redaction. But never `console.log` secrets. |

An adapter that cannot uphold the trust boundary must set `detect().available = false`
with a clear `reason` until it can.

---

## 4. Adapter checklist (PR acceptance)

- [ ] Implements `ProviderAdapter`; no imports from `packages/core`.
- [ ] `detect()` is honest and fast (<2s), never throws.
- [ ] Maps to normalized `AgentEvent` only — no engine types leak out.
- [ ] Trust-boundary section added to the adapter's `README.md`.
- [ ] Contract test suite passes (shared harness replays a scripted session and
      asserts the normalized event sequence).
- [ ] `cwd` jail respected (test: attempt outside-cwd write → `approval_request` or refusal).
- [ ] Vendor-neutrality: `grep -ri "<engine>" packages/core` → no matches.
