# Grok Build adapter security and trust boundary

## Status

The Grok Build adapter is a **read-only preview**, not production-ready and never
eligible for Auto selection. It runs the official `grok` CLI in headless mode and uses
the CLI's own authentication. DayCrew never reads or stores a Grok credential.

On the machine tested, `grok 1.0.30` is installed but not signed in. Detection and model
discovery are verified live: `grok models` reports the signed-out state and lists
`grok-4.6` and `grok-4.5`. A successful model turn and the resulting filesystem boundary
remain unverified until the user completes `grok login --device-code`.

## Launch policy

Every DayCrew turn passes these controls explicitly:

- `--output-format streaming-json`
- `--permission-mode dontAsk`
- `--sandbox read-only`
- `--tools Read,Grep,Glob`
- `--disallowed-tools Edit,Write,Bash,WebFetch,WebSearch,Agent`
- deny rules for `MCPTool(*)`, `Bash`, `Edit`, and `Write`
- `--disable-web-search` and `--no-subagents`
- no `--always-approve` or `bypassPermissions`

The deny rules and sandbox are enforced by Grok Build, not DayCrew. The headless stream
does not provide a DayCrew-controlled approval callback, so the adapter advertises
`approvals: false` and refuses every approval decision. Explicit preview consent and a
canonical Workspace allowlist are required before a turn can start.

## Normalization

The official `streaming-json` records are converted inside `packages/providers`:

| Grok record | DayCrew event |
|---|---|
| `text` | `text` |
| `tool_call` | `tool_call` |
| `tool_call_update` | `tool_result` |
| `usage` | `usage` |
| `end` | `done`, plus the session id used by `--resume` |
| `error` or invalid JSON | non-recoverable `error` |

Cancellation terminates the complete process tree owned by the turn and emits a
recoverable cancellation event. Provider text and diagnostics are redacted before they
cross into DayCrew state.

## Verification

`packages/providers/src/grok.test.ts` covers stream normalization, secret redaction,
model parsing, signed-out detection, exact launch arguments, session continuation,
consent, root allowlisting, approval refusal, and cancellation. The server and UI tests
cover registry exposure, readiness, model selection and preview consent.

Run the credential-free checks with:

```bash
node packages/cli/dist/bin.js provider detect grok
pnpm exec vitest run packages/providers/src/grok.test.ts
```

After signing in, Grok can be selected for a Member in DayCrew. It remains a restricted
preview until a separate live suite verifies conversation context, tool use,
cancellation and the read-only boundary against the authenticated CLI.
