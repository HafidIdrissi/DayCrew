# AI Engine Adapter Contract

## Contributor quickstart

1. Implement `ProviderAdapter` in `packages/providers`; do not add provider names to `packages/core`.
2. Report capabilities conservatively and implement a fast, credential-safe `detect()` call.
3. Declare the engine once in `ENGINE_REGISTRY` (`packages/shared/src/engine.ts`) so every screen picks it up.
4. Translate native output into normalized DayCrew events. Never expose provider protocol objects.
5. Fail closed on Workspace confinement, permission, approval, restart, or outcome uncertainty.
6. Add adapter conformance, redaction, cancellation, and boundary tests plus a security note under `docs/`.

Read the Claude and Codex adapters as contrasting actionable and read-only examples. New experiments are not eligible for Auto selection until their safety boundary is enforceable and reviewed.

An adapter lets a Team Member use an AI engine without leaking provider behavior
into `packages/core`. The TypeScript source of truth is
`packages/shared/src/provider.ts`.

## Contract

Each `ProviderAdapter` has a stable `id`, human-readable `displayName`, declared
capabilities, a fast `detect()` check, and `startAgent(spec)`. The returned
`AgentHandle` accepts goals, Member messages, and approval decisions; exposes one
`AsyncIterable<AgentEvent>`; and supports `interrupt()` and `stop()`.

The normalized events are:

- `text`
- `tool_call`
- `tool_result`
- `task_update`
- `message`
- `approval_request`
- `usage`
- `done`
- `error`

Provider-native event names, processes, session tokens, and tool protocols must not
cross this boundary.

## Adapter rules

1. Depend on `@daycrew/shared`, never `@daycrew/core`.
2. Validate inputs and emit only normalized events.
3. Run inside the supplied Workspace path and document how confinement is enforced.
4. Never auto-answer a native permission prompt. Convert it into an
   `approval_request` and wait for a decision.
5. Be honest about capability and detection failures.
6. Do not log credentials, tokens, raw environment values, or unredacted secrets.
7. Implement the shared conformance tests before being marked production-ready.

An adapter that cannot enforce the required safety boundary must report itself as
unavailable with a clear reason.

## Claude Code writable adapter

Claude Code exposes a host-controlled `can_use_tool` permission callback that fires
before a tool runs, so DayCrew bridges it directly into `approval_request` → Needs You →
allow/deny. Writes are opt-in, Workspace paths are confined by the adapter, MCP is off by
default, and every failure path denies. It is the first adapter to advertise approval
support and to be marked production-ready. See
[Claude Code adapter security](./CLAUDE-ADAPTER.md).

## Codex read-only preview

The first real adapter detects the Codex CLI and authentication, streams normalized
JSONL, reports token usage, resumes threads, and supports cancellation. It is not
production-ready and does not advertise approval support because the current native
approval flow cannot be bridged through DayCrew before execution. It is fail-closed
by default and can run only in explicitly acknowledged, isolated read-only
Workspaces. See [Codex adapter security](./CODEX-ADAPTER.md).

## What each adapter has actually been observed to do

Claims about a live engine belong in the [engine validation record](./ENGINE-VALIDATION.md),
which separates a real observation from a mock, an untested path, and a blocked one. An
adapter's capability table states what it implements; only that record says what was seen.

## Engine registry and model selection

`packages/shared/src/engine.ts` holds one `EngineDescriptor` per engine: the program it
runs, its classification, Auto eligibility, how its models are discovered, its
maintained model list, and the install/sign-in guidance Settings prints. The local API
serves this registry at `GET /api/engines`, so the agent form, Settings and the chat
header all read the same source. Adding an engine means adding an adapter and one
registry entry; no screen changes.

**Every engine is a local CLI that owns its own authentication.** No descriptor may
carry a credential field, and DayCrew has no credential store: a `setup` block names the
sign-in command and how DayCrew checks it, nothing more.

Model discovery is declared, not guessed:

| `modelDiscovery` | Meaning | Example |
|---|---|---|
| `dynamic` | The CLI publishes a catalogue command | `codex debug models`, `cursor-agent models` |
| `static` | The CLI documents accepted values but offers no listing command | Claude Code aliases, Antigravity tiers |
| `unsupported` | The engine takes no model parameter | Demo Mode |

A `dynamic` engine falls back to its maintained list, with a warning, when the command
cannot be run — a failed lookup must never block agent setup. `allowsCustomModelId`
records whether the CLI documents identifiers outside the listed set; only then may a
person type one. `validateEngineModel` runs again on the server before a Member is
saved, against the live catalogue when one could be read, and `ModelIdSchema` keeps a
stored model id from ever carrying a command-line argument. `AgentSpec.model` is how the
choice reaches the adapter, which passes it through the CLI's own documented option; an
adapter that receives no model must let the CLI use its default.

## Reporting readiness honestly

`ProviderDetection` carries three separate facts: `installed`, `authenticated`, and
`available`. **A failed check is not evidence of absence.** Only a missing executable
(`ENOENT`) sets `installed: false`; a timeout, a permission error, an unrecognized
status message, or an unsupported platform leaves the field `undefined`, which screens
render as *State unknown*. An adapter must never report `authenticated: false` unless
the tool actually said so.

## Cursor CLI read-only preview

`cursor-agent` is the official Cursor CLI. The adapter detects it with `--version` and
`status`, lists models with `cursor-agent models`, and runs turns with
`--print --output-format stream-json`, whose event schema Cursor documents. It never
passes `--force`, `--yolo` or `--api-key`, and writes a deny-first `.cursor/cli.json`
for the run. Because Cursor exposes no pre-execution approval callback, it advertises
`approvals: false` and is started in a disposable folder the person has acknowledged.
That folder is a convention, not a sandbox: DayCrew does not confine the process and
cannot verify that the CLI honoured the deny list. See
[Cursor adapter security](./CURSOR-ADAPTER.md).

## Reporting the model the engine actually ran

An agent asks for a model, often an alias. Only the engine knows what that resolved to,
so `Usage.model` carries the model the engine reports it billed, and a chat reply keeps
both: `model` (requested) and `resolvedModel` (confirmed). Claude Code reports it through
the `modelUsage` map on its result message — and only when that map has exactly one key,
since a multi-model turn has no single answer. Codex, Cursor, Grok and the Antigravity
bridge do not report a resolved model, so DayCrew shows the requested one alone rather
than implying a confirmation it never received.

## Grok Build read-only preview

Grok Build is integrated through its official `streaming-json` headless contract. The
adapter normalizes text, tool lifecycle, usage, errors and the terminal session id, then
uses `--resume` for follow-ups. It launches with read-only tools and sandboxing, disables
web search and subagents, denies write, shell and MCP tool families, and never enables
the CLI's approval bypass. It is excluded from Auto because DayCrew cannot bridge a
headless approval before execution.

The installed `grok 1.0.30` was observed signed out. Detection and the live model list
(`grok-4.6`, `grok-4.5`) are real; successful turns remain unverified until the CLI is
authenticated. See [Grok adapter security](./GROK-ADAPTER.md).

## Engines that are not integrated, and why

The Gemini CLI was installed and probed on a real machine, but could not be brought to
a verifiable working state with the available account.

| Tool | Official? | Status |
|---|---|---|
| Gemini CLI (`gemini`) | Official (Google) | **Blocked on this machine, for this account.** Installed (0.59.0) with stored OAuth credentials, but every call observed here failed before any turn, with the CLI's own message: `Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google` (`reasonCode: UNSUPPORTED_CLIENT`, `tierId: free-tier`). That is what this account and CLI version reported; DayCrew has not confirmed against any Google announcement how broadly it applies, and it may not apply to other accounts, tiers, or versions. Because no successful turn could be observed, no adapter ships. The interface would otherwise fit: `-p`, `-m`, `-o stream-json`, `--approval-mode plan`, `-r/--resume`. Note this is a **different program** from DayCrew's `gemini` engine, which drives the Antigravity Agent API. |

## M0 reference

`MockProvider` is deterministic, always available, needs no credentials, and replays
an injected sequence of normalized events. It exists for core, server, CLI, and UI
tests; it never accesses a network or filesystem.
