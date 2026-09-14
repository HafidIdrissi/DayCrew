# Cursor CLI adapter security and trust boundary

## Status

The Cursor adapter is a **read-only preview**, not production-ready, and is never
eligible for Auto selection. It drives `cursor-agent`, the official Cursor CLI, which
owns its own authentication: DayCrew never reads, stores, or asks for a Cursor
credential and never passes `--api-key`.

Verified against <https://cursor.com/docs/cli/reference> on 2026-09-13, and against the
real `cursor-agent` 2026.09.10 installed on a Windows machine. Detection and model
listing were exercised against that real binary; a conversation turn has **not** been
run, because the account was not signed in (`cursor-agent status` → "Not logged in").

## Capabilities

| Capability | Status | Implementation |
|---|---|---|
| Installation detection | Supported | `cursor-agent --version` |
| Sign-in detection | Supported | `cursor-agent status` |
| Model discovery | Supported | `cursor-agent models` |
| Model selection | Supported | `--model <id>` |
| Start and stream | Supported | `--print --output-format stream-json` |
| Session continuation | Supported | Captured `session_id` plus `--resume <id>` |
| Usage | Partial | Tokens when the CLI emits them; cost is unavailable and reported as zero |
| Cancellation | Supported | Terminates the owned process tree |
| Structured DayCrew tasks | **Unsupported** | The adapter reads prose, not a task schema |
| Native approval bridge | **Unsupported** | `capabilities.approvals=false` |
| Workspace writes | **Requested off** | Deny-first permission file, no `--force`; enforcement is the CLI's, and DayCrew cannot verify it |

## Enforced launch policy

Every Cursor turn runs with:

- `--print --output-format stream-json`, so only normalized events cross into DayCrew
- **never** `--force` or `--yolo` — DayCrew must not bypass the CLI's permission rules
- **never** `--api-key` — sign-in belongs to `cursor-agent login`
- a generated `<workspace>/.cursor/cli.json` denying `Shell(*)`, `Write(**)`,
  `WebFetch(*)` and `Mcp(*)`, allowing only `Read(**)`
- a canonical, non-filesystem-root working directory inside an explicitly
  acknowledged disposable folder, plus an optional allowlist of Workspace roots.
  These checks constrain *where DayCrew points the CLI*, not what the CLI may reach.
- a sanitized environment that excludes API keys, tokens, and unrelated variables

## Why it is not actionable

Cursor's permission system is a static allow/deny configuration file, not a
pre-execution callback that an external program can answer. DayCrew therefore cannot
turn a pending tool call into an `approval_request` and wait for a human decision, so
the adapter fails closed: `approvals: false`, writes disabled, and the only advertised
Skill capability is `filesystem.read`.

DayCrew starts the CLI with its working directory set to a disposable folder that the
person has explicitly acknowledged. **That is a starting point, not a sandbox.** DayCrew
does not confine the process: it cannot stop the CLI from reading or writing anywhere
the local user account can reach. The only restrictions in play are the ones the CLI
applies to itself from the generated `.cursor/cli.json`, and DayCrew has no way to
verify from outside that they were honoured.

Treat the disposable folder as a convention that keeps ordinary runs away from your
project, not as a boundary. Use it only with prompts and repositories you trust.

## Windows: why DayCrew does not run the `.cmd` shim

The Windows installer ships `cursor-agent.cmd`, which chains through PowerShell to a
bundled `node.exe index.js`. Node refuses to spawn a `.cmd` without a shell, so a direct
spawn fails with `EINVAL`; running it *through* a shell would let the shell re-parse the
prompt text. DayCrew therefore resolves the vendor's own target — the newest
`versions/<YYYY.MM.DD-commit>/node.exe` plus its `index.js` — and passes every argument
as real argv. `DAYCREW_CURSOR_BINARY` overrides the whole resolution.

## Limitations

- Streaming granularity is one complete assistant message, not token deltas. Cursor
  documents `--stream-partial-output` for finer deltas, but its event shape is not
  published, so DayCrew does not parse it.
- Available models depend on the signed-in account's plan, which is why DayCrew reads
  `cursor-agent models` instead of shipping a guessed list.
- Cost is not reported by the CLI and is recorded as zero.
- `cursor-agent status` output is not a documented machine format. DayCrew treats a
  clean exit as signed in and a recognizable "not logged in" message as signed out;
  anything else is reported as **unknown**, never as signed out.
- The disposable working directory is not an enforced boundary. DayCrew provides no
  sandbox, and nothing here has been shown to stop the CLI leaving that folder.
