# Claude Code adapter security and trust boundary

## Status

The Claude Code adapter is DayCrew's **first writable provider with a real pre-execution
approval boundary**. Unlike the Codex adapter, Claude Code exposes a host-controlled
permission callback that fires *before* a tool runs, and a denial provably prevents the
action.

Verified against `Claude Code 2.1.266`-`2.1.267` on Windows 11 with Node 20.19.4. Re-verify the
launch flags and control-protocol shape when upgrading the CLI.

## CLI invocation strategy

Each DayCrew Member owns one long-lived `claude` process driven over the bidirectional
`stream-json` protocol. Turns are additional user messages on the same stdin, so
continuation is native and no conversation state is re-sent.

```
claude --print --verbose
       --input-format stream-json --output-format stream-json
       --permission-prompts host --permission-prompt-tool stdio
       --permission-mode manual
       --setting-sources=            # ignore user/project/local settings
       --settings <PreToolUse ask-hook>
       --tools <allowlist>
       --json-schema <DayCrew result schema>
       --append-system-prompt <DayCrew rules>
       --strict-mcp-config           # no MCP servers unless explicitly supplied
       [--model <model>] [--resume <session-id>]
```

Flags DayCrew never passes: `--dangerously-skip-permissions`,
`--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`,
`--permission-mode acceptEdits`, `--permission-mode dontAsk`, `--add-dir`.

On Windows the adapter resolves the native `node_modules/@anthropic-ai/claude-code/bin/claude.exe`
next to the `claude.cmd` shim and spawns it directly. Going through the `.cmd` requires a
shell, and shell quoting corrupts the JSON passed to `--settings` and `--json-schema`.

## Auth assumptions

Credentials stay provider-managed. Detection runs `claude --version` and `claude auth status`,
and reads **only** the `loggedIn` boolean from the latter. That payload also contains the
account email, organisation id and subscription tier; none of it is stored, logged, or
copied into DayCrew state. The child process receives a sanitized environment allowlist,
so DayCrew never injects an API key and never forwards unrelated environment variables.

`detect()` costs no tokens — neither subcommand starts a model session.

## Capabilities

| Capability | Status | Implementation |
|---|---|---|
| Installation/version detection | Supported | `claude --version` |
| Authentication detection | Supported | `claude auth status` (`loggedIn` only) |
| Start and stream | Supported | `stream-json` over stdin/stdout |
| Text output | Supported | `assistant` → `text` |
| Tool calls / results | Supported | `tool_use` → `tool_call`, `tool_result` → `tool_result` |
| Structured DayCrew tasks | Supported | `--json-schema` → `StructuredOutput` → `task_update` |
| Usage | Supported | Tokens (including cache) and `total_cost_usd` |
| Session continuation | Supported | Long-lived process; `--resume <session-id>` after a restart |
| Cancellation | Supported | `control_request {subtype:"interrupt"}`, with termination as a fallback |
| Clean stop | Supported | Closes stdin, terminates the process tree, closes the event stream |
| Provider errors | Supported | Non-success `result` subtypes → non-recoverable `error` |
| **Pre-execution approval bridge** | **Supported** | `can_use_tool` control request → `approval_request` |
| Workspace writes | Supported, opt-in | `allowWrites: true` plus an explicit Workspace allowlist |

## Normalized event mapping

Provider-native JSON is parsed entirely inside `packages/providers`. Only DayCrew events
cross into core; `packages/core` contains no Claude-specific code.

| Claude Code stream message | DayCrew event |
|---|---|
| `system/init` | none (captures `session_id` for resume) |
| `assistant` → `text` block | `text` (secret-redacted) |
| `assistant` → `tool_use` block | `tool_call` (id lower-cased to a DayCrew id) |
| `user` → `tool_result` block | `tool_result` (`isError` preserved) |
| `control_request` `can_use_tool` | `approval_request`, or an immediate allow/deny |
| `result` `usage` / `total_cost_usd` | `usage` |
| `result` subtype `success` + structured output | `task_update`* + `text` + (`done` \| `turn_end`) |
| `result` non-success subtype | `error` (`recoverable: false`) |
| interrupt acknowledgement | `error` (`recoverable: true`) |
| unparseable line | `error` (`recoverable: false`) |

Cache-read and cache-creation tokens are added to `inputTokens`; without them Claude Code
reports a near-zero input count that would make usage meaningless.

`thinking_tokens`, `rate_limit_event`, partial-message and hook-lifecycle records are
ignored rather than forced into a DayCrew event type.

## Permission bridging

Claude Code emits a `can_use_tool` control request on stdout and blocks the tool until the
host answers on stdin. The adapter turns that into DayCrew's existing lifecycle:

```
Claude wants to use a tool
  → control_request {subtype: "can_use_tool"}
  → adapter classifies it into a RiskyAction + RiskLevel
  → approval_request  → Needs You → user approves/denies
  → control_response {behavior: "allow" | "deny"}
  → the tool runs, or never runs
```

There is no post-execution approval anywhere in this adapter. If DayCrew never answers,
the request times out (default 15 minutes) and is **denied**. If the process dies or the
handle is stopped or cancelled while a request is outstanding, every pending request is
denied before the handle closes. Failure always falls closed.

### Forcing confirm-all

Claude Code auto-approves a set of operations it considers safe — reading a file inside the
working directory, `ls`, `git status`, `git log` — and those never reach the host. That is
incompatible with DayCrew's "Assist me" promise, so the adapter installs a `PreToolUse` hook
with matcher `*` returning `permissionDecision: "ask"`. Verified: with the hook, a benign
`ls` reaches the host bridge; without it, it does not. **Every** tool call is therefore
classified and decided by DayCrew.

### Risk classification

Classification lives in the adapter (`classifyClaudeToolUse`) because it is Claude-specific;
the resulting vocabulary is provider-neutral.

| Claude tool | DayCrew action | Risk |
|---|---|---|
| `Read`, `Glob`, `Grep` inside the Workspace | `command.run` | low |
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | `filesystem.write` | medium |
| Any path matching a credential pattern | `credential.access` | critical |
| `Bash` — `ls`, `cat`, `git status/log/diff`, test runners | `command.run` | low |
| `Bash` — `npm/pnpm/yarn install\|add\|update` | `filesystem.write` | high |
| `Bash` — `rm`, `Remove-Item`, `dd`, `mkfs` | `filesystem.delete` | critical |
| `Bash` — `git push` | `git.push` | high |
| `Bash` — `git push --force`, `reset --hard`, `clean -fd`, `filter-branch` | `git.destructive` | critical |
| `Bash` — `npm publish`, `gh release`, `docker push` | `external.publish` | critical |
| `Bash` — `curl`, `wget`, `ssh`, `scp` | `network.sensitive` | high |
| `Bash` — `sudo`, `chmod -R`, `systemctl`, `taskkill` | `shell.destructive` | critical |
| `WebFetch`, `WebSearch` | `network.sensitive` | high |
| `mcp__*` | `network.sensitive` | critical |
| Anything unrecognised | `shell.destructive` | critical |

Shell classification defaults to **deny-by-escalation**: a command that redirects (`>`),
chains (`&&`, `;`, `|`), substitutes (`$(...)`), or starts with a binary that is not on the
known-safe list is classified `shell.destructive` / `critical`, so a human always decides.
This is deliberately over-strict — a shell command is not statically analysable, and DayCrew
would rather ask than guess.

### Shared-contract change

`RiskyActionSchema` gained two provider-neutral members, `filesystem.write` and
`command.run`. Every existing member of the enum describes a *hard boundary*; there was no
way to express "the agent wants to modify a file" or "the agent wants to run an ordinary
command", so a writable provider could not raise an approval request at all, and
"Assist me" had no label for the actions it must confirm. `hardBoundaries` in
`packages/core/src/policy.ts` is unchanged, so the two new actions are gated by autonomy
while every previously-hard boundary still always requires a human.

## Trust boundary

DayCrew autonomy stays authoritative. The adapter never reads a Team or an autonomy level;
the composition root injects a predicate:

```ts
new ClaudeCodeProvider({
  requiresApproval: (action, risk) => requiresHumanApproval(team.autonomy, action, risk),
})
```

The default when nothing is injected is `() => true` — ask a human about everything.

| DayCrew autonomy | Effect |
|---|---|
| Assist me | Every classified action becomes a Needs You approval |
| Work with approval | Medium/high/critical actions ask; low-risk reads and safe commands proceed |
| Autonomous | Low-risk work proceeds; **hard boundaries still ask** |

Autonomous cannot bypass a hard boundary, and this is enforced twice. `requiresHumanApproval`
returns `true` for every hard-boundary action and for `critical` risk regardless of autonomy;
independently, the adapter escalates any `critical` action or hard-boundary action to a human
*even if an injected predicate says otherwise*. A caller cannot configure the boundary away.

Claude's own permission vocabulary (`acceptEdits`, `bypassPermissions`, `permission-mode`)
is never surfaced to users. Users see DayCrew's three autonomy modes and Needs You.

## Workspace restrictions

- `startAgent()` canonicalizes the Workspace with `realpath` before any comparison.
- A filesystem root is rejected outright.
- Enabling writes **requires** an explicit `allowedWorkspaceRoots` allowlist.
- The adapter refuses to run against a DayCrew source checkout (detected by
  `pnpm-workspace.yaml` + `packages/shared/src`) unless explicitly overridden. Integration
  fixtures additionally assert they live under the OS temp directory.
- Every file-tool path is resolved against the canonical Workspace. A path outside it is
  **denied immediately, without asking a human** — a boundary violation is not a decision
  the user should be nagged into approving. Verified: Claude Code does raise a permission
  request for a read outside the working directory, so DayCrew sees and blocks it.
- The child process gets a sanitized environment allowlist, `NO_COLOR=1`, and no `--add-dir`.
- `--setting-sources=` prevents user, project and local settings from loosening any of this.

## MCP policy

MCP is **disabled by default**: the adapter always passes `--strict-mcp-config` and supplies
no `--mcp-config`, which was verified to produce `mcp_servers: []` in the session init.

Interception was tested rather than assumed. With a purpose-built stdio MCP server exposing
a tool that writes a marker file, the tool call produced a `can_use_tool` control request
*before* execution, and denying it left the marker file unwritten. **MCP tool calls respect
the same pre-execution boundary as built-in tools.**

Even so, MCP stays opt-in and every `mcp__*` call is classified `critical`, so it always
requires a human. DayCrew cannot statically reason about a third-party server's side
effects, and an MCP server is an arbitrary local process outside DayCrew's Workspace
confinement.

## Known limitations

1. **An approved shell command is not sandboxed.** DayCrew gates the *invocation* and shows
   the full command text, but once approved the command runs with the user's own privileges
   and can touch paths outside the Workspace. Workspace confinement is enforced for file
   tools, not for the shell. This is mitigated by classifying anything non-trivial as
   `shell.destructive` / `critical` so a human always reads the command first — but a human
   who approves `bash -c '...'` approves whatever it contains.
2. **Denial is not always the end of an attempt.** After a denial Claude may try a different
   tool for the same goal (observed: a denied `rm` followed by a `Remove-Item` attempt). Each
   attempt is separately gated, so nothing executes, but the user may see several requests
   for one intent.
3. **Core cannot yet resume a paused approval.** The M3 `ManagerOrchestrator` creates the
   Needs You item, pauses the work session, and returns `waiting`; it has no path that feeds
   the resolved decision back through `AgentHandle.send({type: "approval-decision"})`. The
   adapter implements the full round trip and it is proven at the adapter level, but the
   end-to-end approve-and-continue loop needs an orchestrator change that is out of scope
   for M4. No core contract was changed to work around this.
4. **Cost is self-reported.** `total_cost_usd` comes from the CLI and is not independently
   verified.
5. **Subagents are excluded.** The `Task` tool is not in the tool allowlist, and would be
   classified `critical` if it appeared.
6. **The ask-hook spawns a short-lived Node process per tool call.** Correct, but it adds
   latency proportional to tool-call count.

## Production readiness decision

**`productionReady = true`** for the writable Claude Code adapter, against the stated criteria:

| Criterion | Result |
|---|---|
| Writes permission-gated before execution | Yes — verified for `Write`, shell writes, deletes, `git`, and MCP |
| Denial prevents the action | Yes — the file/marker never appears after a denial |
| Workspace boundaries acceptably enforced | Yes for file tools (out-of-Workspace paths auto-denied); shell is gated but unsandboxed and documented |
| Cancellation works | Yes — clean `interrupt` control request, termination fallback |
| Errors fail closed | Yes — timeouts, process death, stop and cancel all deny pending requests |
| Credentials remain provider-managed | Yes — only `loggedIn` is read; sanitized child environment |
| DayCrew autonomy authoritative | Yes — injected predicate, with hard boundaries enforced twice |
| Known bypasses documented and acceptable | Yes — see Known limitations; the unsandboxed approved shell is the material one |

The one finding that argues against readiness is limitation 1: an approved shell command is
not confined. It is judged acceptable because a shell command only runs after a human has
read it, because the classifier escalates anything it cannot prove benign, and because the
same property is true of every local coding agent. A caller that wants to remove it entirely
can leave `allowWrites` off, which drops `Bash` from the tool allowlist and denies every
non-read action.

## Verification

Normal CI stays offline: `pnpm test` runs the deterministic classification, normalization,
redaction and approval-bridge tests against a scripted fake CLI that speaks the real
`stream-json` control protocol.

The real integration test is separate and must be invoked explicitly:

```bash
pnpm test:integration:claude
```

It creates temporary fixtures outside the DayCrew repository and covers a read-only
orchestrated planning session, the deny-then-approve write boundary, and cancellation.
The write test asserts the target file does not exist at the instant the approval request
is raised, not merely after the turn, so pre-execution ordering is proven rather than
inferred.

Detection is available without enabling the provider:

```bash
pnpm --filter @daycrew/cli build
node packages/cli/dist/bin.js provider detect claude-code
```

Running Claude Code with writes requires the explicit flag:

```bash
node packages/cli/dist/bin.js work start <team> "<goal>" \
  --engine claude-code --allow-writes --path <isolated-workspace>
```
