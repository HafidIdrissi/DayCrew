# Codex adapter security and trust boundary

## Status

The Codex adapter is a **read-only preview**, not production-ready. It is intentionally
restricted until Codex exposes a native approval flow that DayCrew can intercept and
resume through the provider-neutral `AgentHandle` contract.

The implementation was verified with `codex-cli 0.153.4` and re-checked against
`0.154.0`, where `--sandbox read-only` and `--ask-for-approval never` are both still
accepted global options. Current CLI behavior should also be checked against the
[official Codex CLI documentation](https://developers.openai.com/codex/cli/) when
upgrading Codex.

**Turn-level behaviour was verified live after the account limit reset.** Two-turn
context, `exec resume`, cancellation, orchestration, controlled failure and write
refusal all passed. A real read task is still blocked on the tested Windows CLI: under
the exact `read-only` / `never` policy, Codex's tool router rejects its PowerShell host
before executing even a read command. See [ENGINE-VALIDATION.md](./ENGINE-VALIDATION.md).

## Capabilities

| Capability | Status | Implementation |
|---|---|---|
| Installation/version detection | Supported | `codex --version` |
| Authentication detection | Supported | `codex login status` |
| Start and stream | Supported | `codex exec --json` JSONL |
| Structured DayCrew tasks | Supported | Codex output schema normalized to `task_update` |
| Usage | Partial | Input/output tokens when emitted; cost is unavailable and reported as zero |
| Session continuation | Supported | Captured thread id plus `codex exec resume` |
| Cancellation | Supported | Terminates the owned process tree, verified against both a live turn and a stub CLI process tree |
| Clean shutdown | Supported | Stops the active process before closing the event stream |
| Native approval bridge | **Unsupported** | `capabilities.approvals=false` |
| Workspace writes | **Disabled** | Read-only sandbox only; the CLI's denial is verified through both `codex sandbox` and a live `codex exec` turn |
| Read-only command tools | **Blocked on tested Windows CLI** | The tool router rejected PowerShell before execution under `read-only` / `never`; no tool event was emitted |

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

That is not a theoretical concern. Running `codex doctor` under DayCrew's own launch
policy on `0.154.0` reports `filesystem sandbox restricted`, `network sandbox
restricted`, `sandbox backend elevated`, `sandbox provisioning complete`, and
`denied-read restrictions false`. Probing the same policy live through `codex sandbox`,
which costs no model turn, showed a write denied with `UnauthorizedAccessException`, an
outbound HTTP request denied with `WebException`, a read inside the folder allowed, and
**a read of a file planted outside the folder allowed**. The same sandbox also read
`%USERPROFILE%\.codex\auth.json` in full. The write denial is the Codex CLI's, not
DayCrew's, and it says nothing about reads.

## Verification

Normal CI uses the deterministic mock and unit-level Codex normalization tests. The
real integration test is separate and must be invoked explicitly:

```bash
pnpm test:integration:codex
```

It creates temporary projects outside the DayCrew repository and covers, in order:
real detection and a live model catalogue; the consent, allowlist, filesystem-root and
approval fail-closed gates DayCrew enforces itself; a characterisation of the CLI
sandbox that needs no model turn; a two-turn chat that must recall a code from the
first turn; thread continuation through `codex exec resume`; an attempted tool-using
task whose absence of tool events is reported as blocked; the CLI's own write refusal; cancellation of
a live turn including its process tree and the absence of orphan approvals; and
Manager → Codex / Member → Codex orchestration with a forced model error. Every fixture
is deleted afterward.

All turn-dependent tests are **skipped, with the CLI's own message printed as
`CODEX_TURNS_BLOCKED`, when a probe turn shows the engine refusing to run at all**. A
blocked engine must never read as a passing one. Unit-level coverage stands in for two
of those checks without a turn: `packages/providers/src/codex.test.ts` asserts the exact
launch arguments and the absence of every bypass flag, and it verifies that cancelling a
turn kills the whole spawned process tree, grandchild included. If turns run but the
CLI refuses the read command before execution, only the real tool task is skipped and
`CODEX_TOOL_TASK_BLOCKED` records the reason.

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
