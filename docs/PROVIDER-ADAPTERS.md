# AI Engine Adapter Contract

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

## M0 reference

`MockProvider` is deterministic, always available, needs no credentials, and replays
an injected sequence of normalized events. It exists for core, server, CLI, and UI
tests; it never accesses a network or filesystem.
