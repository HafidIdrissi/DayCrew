# Codex adapter security and trust boundary

## Status

The Codex adapter is a **read-only preview**, not production-ready. It is intentionally
restricted until Codex exposes a native approval flow that DayCrew can intercept and
resume through the provider-neutral `AgentHandle` contract.

The implementation was verified with `codex-cli 0.153.4`. Current CLI behavior should
also be checked against the [official Codex CLI documentation](https://developers.openai.com/codex/cli/)
when upgrading Codex.

## Capabilities

| Capability | Status | Implementation |
|---|---|---|
| Installation/version detection | Supported | `codex --version` |
| Authentication detection | Supported | `codex login status` |
| Start and stream | Supported | `codex exec --json` JSONL |
| Structured DayCrew tasks | Supported | Codex output schema normalized to `task_update` |
| Usage | Partial | Input/output tokens when emitted; cost is unavailable and reported as zero |
| Session continuation | Supported | Captured thread id plus `codex exec resume` |
| Cancellation | Supported | Terminates the owned process tree |
| Clean shutdown | Supported | Stops the active process before closing the event stream |
| Native approval bridge | **Unsupported** | `capabilities.approvals=false` |
| Workspace writes | **Disabled** | Read-only sandbox only |

## Enforced launch policy

Every Codex turn uses:

- `--sandbox read-only`
- `--ask-for-approval never`, so an unavailable approval cannot be silently granted
- `--ignore-user-config` and `--ignore-rules`
- no `--search`, no `--add-dir`, and no approval/sandbox bypass flags
- a canonical, non-filesystem-root working directory
- an optional allowlist of canonical Workspace roots
- a sanitized environment that excludes API keys, tokens, and unrelated variables

Provider-native JSONL is parsed inside `packages/providers`; only normalized DayCrew
events cross into core. A native file-change event is treated as a non-recoverable
error.

## Sensitive-action matrix

| Action class | Native approval | Pre-execution interception | Current handling |
|---|---|---|---|
| Destructive filesystem | CLI can request approval, but DayCrew cannot bridge it reliably in `exec` JSONL | No verified bridge | Read-only sandbox; writes disabled |
| Dangerous shell mutations | Same limitation | No verified bridge | Read-only sandbox; mutation failure is returned to Codex |
| Git push/force | Same limitation | No verified bridge | No write mode and restricted sandbox network |
| External publishing | Same limitation | No verified bridge | Restricted sandbox network; no web-search flag |
| Sensitive network actions | Same limitation | No verified bridge | Restricted sandbox network |
| Spending | No DayCrew-verifiable dedicated control | No | Network/tool path disabled |
| Credential access | No DayCrew-verifiable read approval | **No** | Cannot be guaranteed blocked; explicit isolated-Workspace opt-in required |

The current Codex diagnostic reports filesystem/network sandboxing as restricted in
read-only mode, but reports `denied-read restrictions=false`. Consequently, DayCrew
cannot prove that reads outside the Workspace—including credential files—are denied.
`startAgent()` therefore fails closed unless `allowUnconfinedReads: true` is explicitly
set. This opt-in is appropriate only for a sanitized, isolated Workspace with no
credentials.

## Verification

Normal CI uses the deterministic mock and unit-level Codex normalization tests. The
real integration test is separate and must be invoked explicitly:

```bash
pnpm test:integration:codex
```

It creates a temporary project outside the DayCrew repository, runs Manager → Codex
and Member → Codex, verifies task/activity/usage state, tests cancellation, forces a
controlled model error, and deletes the fixture afterward.

CLI detection is available without enabling the provider:

```bash
pnpm --filter @daycrew/cli build
node packages/cli/dist/bin.js provider detect codex
```

Running Codex requires the explicit read-risk acknowledgement:

```bash
node packages/cli/dist/bin.js work start <team> "<goal>" \
  --engine codex --allow-unconfined-reads --path <isolated-workspace>
```
