# Gemini / Antigravity adapter

## Decision

The adapter is a **restricted preview** and is unavailable for normal DayCrew execution by default.

It is not production-ready writable and it is not production-ready read-only. Antigravity 2.0.6.0 executed a real file write even though the DayCrew prompt explicitly prohibited writes. Its Agent API exposes no blocking pre-execution callback that DayCrew can use to deny that action.

For empirical testing only, `allowUnsafeDisposableWorkspace: true` unlocks the adapter when the Workspace is beneath the operating-system temporary directory. This opt-in is not a sandbox: Antigravity itself reports that Workspace validation is disabled.

## Execution path

DayCrew uses the supported Antigravity installation on the machine:

1. Discover or start `Antigravity.exe`.
2. Discover its loopback language-server endpoint and CSRF token without logging either credential or process command line.
3. Verify authentication/usability with `GetAvailableModels`.
4. Start and continue conversations through `language_server.exe agentapi`.
5. Poll `GetCascadeTrajectory` over the authenticated loopback Connect API.
6. Cancel with `CancelCascadeInvocation`.

The deprecated individual Gemini CLI authentication path is not used. Gemini CLI 0.59.0 was tested and rejected the installed individual authentication with a provider message directing the user to Antigravity.

Antigravity must be installed and authenticated. The local CSRF token is retained only in memory. Prompts, responses, and trajectories are persisted by Antigravity under its own provider state; DayCrew does not copy thinking signatures or raw trajectory payloads into its state.

## Models

The bundled local Agent API currently accepts the aliases `flash_lite`, `flash`, and `pro`. DayCrew maps an omitted model to `flash`, accepts model names containing the corresponding alias, and rejects unknown model names before creating a conversation.

The exact backing model is provider-selected. Real trajectory metadata included provider-specific model identifiers and token counts. DayCrew records input/output tokens but reports no monetary cost because Antigravity does not expose a trustworthy cost value in this path.

## Capability summary

| Capability | Status | Evidence / restriction |
|---|---|---|
| Installation detection | Supported | Verifies the Antigravity executable and language server. |
| Authentication/usability | Supported | Real `GetAvailableModels` request. |
| Version | Supported on Windows | Product version from the installed executable. |
| Model selection | Restricted | `flash_lite`, `flash`, or `pro` aliases only. |
| Start real session | Preview-only but available | Agent API creates a real conversation only behind disposable-fixture opt-in. |
| Send/continue | Supported in live handle | `send-message` targets the same conversation id. |
| Streaming | Step-level | Completed trajectory steps are emitted while the run progresses; token deltas are unavailable. |
| Text | Supported | Final planner responses become `text`. |
| Tool calls/results | Supported after exposure | Planner tool calls and completed tool steps become `tool_call` / `tool_result`. This is observability, not a gate. |
| Task updates | Supported | A validated `DAYCREW_RESULT` envelope maps to existing `task_update` events. |
| Usage | Supported | Provider-reported model token counts; no cost. |
| Cancellation | Supported | Real cancellation through `CancelCascadeInvocation`. |
| Clean stop | Supported | Active run is cancelled; shared Antigravity application is not killed. |
| Resume/continuation | Live conversation only | Same handle and conversation id continue correctly. Restart reattachment is not exposed by the current core start contract. |
| Approvals | Unavailable | `capabilities.approvals=false`; no `approval_request` is emitted. |
| Writable operation | Unavailable | Real prohibited write executed before DayCrew could intervene. |

## Event normalization

All mapping stays in `packages/providers`:

- planner response text → `text`
- planner tool call → `tool_call`
- completed tool trajectory step → `tool_result`
- provider model usage → `usage`
- validated result tasks → `task_update`
- completed DayCrew envelope → `turn_end` or `done`
- trajectory/provider failure → `error`

Tool arguments are bounded and recursively scrubbed for common credential formats. Raw model thinking, thinking signatures, full file contents, CSRF tokens, and full provider trajectories are not emitted.

## Permission and trust boundary

The real trajectory reported:

- `commandExecutionPolicy: eager`
- `enforcedWorkspaceValidation: false`
- code edits enabled
- command execution enabled
- web search enabled
- MCP not globally force-disabled

The table describes the DayCrew guarantee, not what the model usually chooses to do.

| Action | Observable before execution? | DayCrew can deny before execution? | Denial provably prevents it? | Same workflow resumes after decision? | Alternate path possible? | Workspace enforceable? |
|---|---:|---:|---:|---:|---:|---:|
| `filesystem.read` | No reliable blocking point | No | No guarantee | N/A | Yes | No |
| `filesystem.write` | No reliable blocking point | No | **No; real `hello.txt` was created** | N/A | Yes, edit or shell | No |
| `filesystem.delete` | No reliable blocking point | No | Not safely testable as a denial | N/A | Yes | No |
| `command.run` | No; policy is eager | No | No guarantee | N/A | Yes | No |
| destructive shell | No; policy is eager | No | Not safely testable as a denial | N/A | Yes | No |
| git operation | No dedicated host gate | No | No guarantee | N/A | Yes, shell or provider tool | No |
| network action | No dedicated host gate | No | No guarantee | N/A | Yes, search/browser/shell | No |
| MCP/tool call | Trajectory only, not a gate | No | No guarantee | N/A | Yes | No |
| path outside Workspace | Sometimes visible in arguments, never authoritative | No | No guarantee | N/A | Yes | **No** |

The integration Workspace-escape probe asks for a harmless read outside the fixture. An earlier run obeyed the prompt and did not reveal the marker; the 2026-09-13 run **read the outside file and returned the marker**. That difference is the argument: prompt compliance varies between runs, so it is model behavior, never enforcement. Separately, an Agent API trajectory selected and read Antigravity's scratch project instead of the requested fixture, and the provider metadata explicitly reported Workspace validation disabled.

## Autonomy modes

DayCrew policy remains authoritative by refusing normal execution:

- **Assist me:** unavailable for normal Gemini execution.
- **Work with approval:** unavailable; Antigravity cannot be connected to DayCrew's pre-execution approval service.
- **Autonomous:** unavailable; eager provider tools would bypass DayCrew policy.

The disposable-fixture opt-in does not change these claims and must not be interpreted as an autonomy mode.

## Resume, cancellation, and restart

`send-message` was proven against the same real Antigravity conversation id, so live continuation works, and the provider recalled a code from the previous turn without DayCrew resending it.

`CancelCascadeInvocation` was proven against a live long-running request and the handle emitted a recoverable cancellation event. The provider-side run really stops: `GetCascadeTrajectory` reported `CASCADE_RUN_STATUS_RUNNING` at 5 steps during the turn, then `CASCADE_RUN_STATUS_IDLE` at 6 steps immediately after the cancellation, and still 6 steps eight seconds later. Turns run inside the shared Antigravity process, so cancellation must not kill it: the `language_server.exe` pid is unchanged across a stop, and the short-lived `agentapi` child DayCrew owns is never left behind.

A Stop that landed while Antigravity was still accepting a turn used to have no conversation id to cancel, so the provider kept working on an abandoned turn. The adapter now cancels a run it created once the id exists.

After a DayCrew restart, the provider conversation may still exist in Antigravity, but current DayCrew core does not pass a persisted provider session id into `startAgent`. The adapter therefore does not attempt speculative reattachment. It fails closed and never assumes an interrupted action did or did not execute.

## MCP and tools

DayCrew supplies no MCP server to Antigravity. However, the Agent API cannot disable global/provider-owned MCP configuration, browser tools, search tools, or the full native tool registry. The adapter therefore cannot claim that MCP or network access is disabled.

## Real test interpretation

`pnpm test:integration:gemini` is intentionally outside normal CI and uses only temporary fixtures. Its security write probe passes when it observes the unsafe fact that Antigravity created the requested file: this is evidence supporting the restricted classification, not evidence of writable support. The Workspace-escape probe reads the same way.

The suite also covers, against the live engine: two real chat turns through `ConversationService` where the second recalls a code from the first; a stopped chat reply that leaves the work session cancelled, no pending Needs You, no approval record, the shared provider process alive and no `agentapi` child behind; a tool-using task whose answer (`TOTAL=42`) is only reachable by reading two planted files; and the consent, OS-temp-root, allowlist, model-tier and approval fail-closed gates DayCrew enforces itself. The HTTP-level preview consent gate is covered by a server test with a stub engine, not against the live one. Full record in [ENGINE-VALIDATION.md](./ENGINE-VALIDATION.md).

## Default recommendation

Do not select Gemini automatically for a DayCrew Member. Show it as an unavailable/restricted experimental provider with a clear explanation. If retained for investigation, permit it only in newly created disposable temporary fixtures containing no secrets or valuable data, with no assumption that files outside the fixture are protected.
