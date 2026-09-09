# DayCrew — MVP Architecture (v0.1)

**Status:** APPROVED by Product Owner 2026-09-09 (with changes, incorporated below). M0 in progress.
**Author:** 🏗️ Michael – Lead Architect · **Date:** 2026-09-09 · **Rev:** 3

### Changelog — Rev 3 (contract rulings from D1 review)
- **One event channel.** Removed `EngineEvent` / `RunContext.emit`. Adapters speak only
  through `AgentHandle.events` (`AgentEvent`); core derives lifecycle/audit from it.
- **`events.jsonl` payloads defined** per `kind` (§4.3), envelope gains `id` + `seq`.
- **`ApprovalRequest.risk`** vocabulary = `low | medium | high` with a `DEFAULT_RISK`
  map by `actionClass` (`docs/PROVIDER-ADAPTERS.md §2`). Advisory only.
- **`McpServerConfig`** defined (`stdio` | `http`), pass-through for MCP-capable adapters.
- **Team Pack `categories`** example fixed to the §6 vocabulary (`software-development`).

### Changelog — Rev 2 (Product Owner decisions)
1. Tech stack approved as-is. Keep it simple; no extra infra without justification.
2. **MVP boundary:** internal technical alpha = M0→M3. **First public release (v0.1) = M0→M4** —
   multi-member teams that delegate and collaborate are the core differentiation, not single-agent runs.
   M5 web dashboard is an immediate fast-follow after v0.1.
3. **Providers:** Claude Code is the first full provider; a **real Codex adapter is prioritized
   immediately after (or alongside M4)**. Target public demo: Architect→Claude Code, Developer→Codex.
   Gemini / Antigravity follow. Provider abstraction stays 100% vendor-neutral.
4. **Network posture:** deny-all-ask confirmed as default.
5. **Repository:** `git init` now, MIT license, contributor-facing files from day one (see §12).
   Local/private during M0; goes public once the skeleton is clean, documented, CI green.
6. **Terminology:** internal vs user-facing split — see §11.
7. **Team Packs:** the team/template format is a **first-class public extension point**. Community
   contributors add teams without touching the core engine. Spec: `docs/TEAM-PACKS.md`.

---

## 1. Product vision (as understood)

DayCrew is an **open-source, local-first work operating system**. A user defines a
*crew* — a small team of specialized AI agents — and runs it against an objective in
software development, e-commerce, job search, research, or any professional workflow.

Non-negotiables that shape the architecture:

1. **Model-agnostic.** Agents run on pluggable providers: Claude Code, Codex CLI,
   Gemini CLI, local models, and future engines. Provider-specific code lives *only*
   in adapters.
2. **Local-first.** Runs on the user's machine with real filesystem and shell access.
   State is plain files, git-diffable, inspectable.
3. **Human-in-the-loop.** Risky actions (shell, delete, network, spend, publish) pass
   through an approval gate with a full audit trail.
4. **Small, modular, shippable.** MVP is a CLI + engine + one real provider + mock
   provider. Web dashboard and multi-provider support are fast-follows, not blockers.

The existing `hive/` prototype (file-based inbox/outbox, `tasks.json` kanban, a god
orchestrator, circuit breakers) is an existence proof of the coordination model.
DayCrew productizes that pattern with clean contracts.

---

## 2. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 20+) | Matches provider CLIs, one language across engine/CLI/web, strong typing for contracts |
| Monorepo | pnpm workspaces | Simple, fast, no Nx/Turbo overhead for MVP |
| Schemas | zod | Single source of truth for types + runtime validation of config, events, messages |
| CLI framework | clipanion or commander | Minimal; `daycrew <verb>` |
| Local server (M5) | Fastify + `ws` | Lightweight HTTP + WebSocket for the dashboard |
| Web (M5) | Vite + React + Tailwind | Fast build, familiar, no SSR needed |
| Storage | JSON + JSONL files under `.daycrew/` | Git-diffable, zero infra, single-writer discipline; SQLite is a later optimization |
| Tests | vitest + a deterministic **mock provider** | Full engine/UI coverage without spending tokens |

Electron desktop app is explicitly **out of MVP scope** — the CLI + local web UI cover it.

---

## 3. Repository structure

```
daycrew/
├── packages/
│   ├── shared/          # zod schemas, TS types, constants, ids, errors
│   ├── core/            # the engine: run store, turn loop, task manager, message
│   │                    #   router, approval/permission engine, event bus, pack loader
│   ├── providers/       # ProviderAdapter interface + built-in adapters:
│   │                    #   mock/ · claude-code/ · codex/ · gemini-cli/ (stub)
│   ├── cli/             # `daycrew` command (init, run, status, tail, approvals, team, serve)
│   ├── server/          # M5: Fastify HTTP+WS API over core (folded into cli `serve`)
│   └── web/             # M5: React dashboard
├── team-packs/          # FIRST-PARTY team packs, each a self-contained dir (see docs/TEAM-PACKS.md)
│   ├── software-development/
│   ├── ecommerce/
│   ├── job-search/
│   ├── academic-research/
│   ├── marketing/
│   └── cybersecurity/
├── examples/            # runnable example objectives + expected outputs
├── docs/
├── .github/             # issue templates, PR template, workflows (CI)
├── LICENSE · README.md · CONTRIBUTING.md · CODE_OF_CONDUCT.md · SECURITY.md · ROADMAP.md
└── package.json         # pnpm workspace root
```

Dependency direction (strict): `web → server → core → providers → shared`. `shared`
depends on nothing. Providers never import `core`. **Team packs are data, not code** —
`core` loads them through the pack loader; adding a pack never touches `core`.

---

## 4. Core data model

All entities are zod schemas in `packages/shared`. Persisted under a project's
`.daycrew/` directory.

### 4.1 Config (checked into the user's repo)

- **`daycrew.json`** — project config: which team pack is active, per-role provider
  bindings + overrides, default model, workspace root, global permission policy,
  telemetry opt-in (default `false`).
  ```jsonc
  {
    "team": "software-development",        // team pack id (built-in or installed)
    "providers": {                          // bind each role to a provider (overrides pack defaults)
      "architect": { "provider": "claude-code", "model": "claude-sonnet-5" },
      "developer": { "provider": "codex" }
    },
    "permissionPolicy": { "mode": "ask" },
    "network": "deny-all-ask",
    "telemetry": false
  }
  ```
- **`team.yaml`** — comes from the active **team pack** (see `docs/TEAM-PACKS.md`), not
  hand-written per project. Defines members, roles, instructions, orchestration, and
  *default* provider per role (user overrides win). Example member:
  ```yaml
  members:
    - id: architect
      title: "Lead Architect"                  # user-facing label
      instructions: instructions/architect.md
      defaultProvider: claude-code
      orchestrator: true
      permissionPolicy: { mode: ask }
    - id: developer
      title: "Developer"
      instructions: instructions/developer.md
      defaultProvider: codex
      permissionPolicy: { mode: ask }
  ```

### 4.2 Runtime state (under `.daycrew/state/`, gitignored by default)

```
.daycrew/
├── daycrew.json
├── team-packs/            # optional project-local packs (highest discovery precedence)
└── state/
    └── run-<runId>/
        ├── run.json           # Run entity
        ├── tasks.json         # Task[] kanban for this run
        ├── events.jsonl       # append-only event log (source of truth for UI/replay)
        ├── approvals.jsonl    # append-only approval request + decision log
        ├── messages/          # inter-agent messages (one JSON per message)
        ├── artifacts/         # files produced by the run (or manifest pointing into workspace)
        └── agents/<agentId>/
            ├── memory.md
            ├── inbox/  inbox/.done/
            ├── outbox/
            └── logs/          # raw provider transcript (redacted)
```

### 4.3 Entities

- **Run** — `{ id, crewName, objective, workspace, status, mode, createdAt, startedAt, endedAt, limits, usage }`
  - `status`: `created → planning → running → (paused | blocked) → running → review → done | failed | cancelled`
  - `mode`: `single` | `crew`
  - `limits`: `{ maxTurns, maxUsd, maxWallclockMs, idleTimeoutMs }`
  - `usage`: `{ turns, usd, tokens }`
- **Agent (run instance)** — `{ runId, agentId, role, provider, model, status, permissionPolicy }`
  - `status`: `idle | thinking | acting | blocked-on-approval | waiting-on-dep | done | error | stopped`
- **Task** — `{ id, runId, title, description, assignee, status, priority, deps[], parentId, artifacts[], createdBy, updatedAt }`
  - `status`: `todo → doing → (blocked | review) → done | failed`
- **Message** — `{ id, runId, from, to, act, subject, body, conversation?, inReplyTo?, createdAt }`
  - `act`: `request | inform | propose | query | agree | refuse | done`
  - `to`: agentId | `orchestrator` | `broadcast`
- **ApprovalRequest** — `{ id, runId, agentId, actionClass, risk, summary, payload, status, createdAt, decidedAt?, decidedBy?, decision?, feedback? }`
  - `actionClass`: `shell.exec | fs.write | fs.delete | net.request | spend | git.push | external.publish`
  - `risk`: `low | medium | high` — from the adapter's hint, else `DEFAULT_RISK[actionClass]`
    (see `docs/PROVIDER-ADAPTERS.md §2`). Advisory: it drives UI emphasis and policy
    rules, never auto-approval.
  - `status`: `pending | approved | denied | expired`
  - `decidedBy`: `"human"` (MVP has no other decider)
- **Artifact** — `{ id, runId, path, kind, producedBy, createdAt, description }`

### Event log (`events.jsonl`)

Envelope: `{ id, seq, ts, runId, kind, payload }` — `seq` is a monotonic integer per
run (ordering + replay cursor). Payload by `kind`:

| kind | payload |
|---|---|
| `run.created` | `{ objective, mode, teamId, workspace, limits }` |
| `run.status` | `{ from, to }` |
| `agent.spawned` | `{ agentId, memberId, provider, model }` |
| `agent.status` | `{ agentId, from, to }` |
| `agent.text` | `{ agentId, text }` |
| `agent.tool` | `{ agentId, callId, name, phase: "call" \| "result", isError? }` |
| `task.created` | `{ taskId, title, assignee?, createdBy }` |
| `task.updated` | `{ taskId, changes }` (partial Task) |
| `message.sent` | `{ messageId, from, to, act, subject }` |
| `approval.requested` | `{ approvalId, agentId, actionClass, risk, summary }` |
| `approval.decided` | `{ approvalId, decision, decidedBy, feedback? }` |
| `artifact.created` | `{ artifactId, path, kind, producedBy }` |
| `usage.updated` | `{ agentId?, totalUsd, totalTokens, turns }` |
| `guardrail.tripped` | `{ rule: "maxTurns" \| "maxUsd" \| "maxWallclock" \| "idle" \| "loop", detail }` |
| `run.ended` | `{ status, summary?, usage }` |

Events are the **single source of truth**; `run.json` / `tasks.json` are projections
rebuildable by replaying `events.jsonl`. Full-text bodies (message body, tool
input/output, artifact contents) live in their own files, not the event payload —
events carry ids and one-line summaries only.

---

## 5. Provider abstraction

The one interface everything else depends on. Lives in `packages/providers`.

```ts
interface ProviderAdapter {
  id: "claude-code" | "codex" | "gemini-cli" | "mock" | string;
  displayName: string;

  /** Is the underlying CLI installed and authenticated? */
  detect(): Promise<{ available: boolean; version?: string; reason?: string }>;

  capabilities: {
    streaming: boolean;
    nativeToolUse: boolean;
    nativePermissionPrompts: boolean;   // does the CLI gate risky actions itself?
    resume: boolean;
    mcp: boolean;
  };

  /** Spawn one agent process/session. */
  startAgent(spec: AgentSpec, ctx: RunContext): Promise<AgentHandle>;
}

interface AgentSpec {
  agentId: string;
  instructions: string;         // role / system prompt
  objective: string;
  cwd: string;                  // workspace jail
  model?: string;
  permissionPolicy: PermissionPolicy;
  allowedTools?: string[];
  mcpServers?: McpServerConfig[];
  context?: { tasks?: Task[]; inbox?: Message[]; memory?: string };
}

interface AgentHandle {
  send(input: string): Promise<void>;           // deliver a turn / message
  events: AsyncIterable<AgentEvent>;            // NORMALIZED events (below)
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown; id: string }
  | { type: "tool_result"; id: string; output: unknown; isError?: boolean }
  | { type: "approval_request"; actionClass: ApprovalRequest["actionClass"];
      summary: string; payload: unknown }
  | { type: "task_update"; task: Partial<Task> & { id?: string; title?: string } }
  | { type: "message_out"; to: string; act: Message["act"]; subject: string; body: string }
  | { type: "usage"; usd?: number; tokens?: number }
  | { type: "turn_end" }
  | { type: "done"; summary?: string }
  | { type: "error"; message: string };
```

**Rule:** `core` only ever consumes `AgentEvent` and calls `AgentHandle`. Every
provider-specific concern (transport, JSON stream format, permission prompt wire
protocol, resume tokens) is contained in the adapter.

### Adapters in the MVP

| Adapter | Scope | When |
|---|---|---|
| `mock` | **Full.** Deterministic, scripted scenarios. Emits every event type incl. `approval_request`. Powers all tests + the demo. | M0 |
| `claude-code` | **Full.** Drives `claude` CLI in stream-json mode; maps native permission prompts → `approval_request`; supports MCP. | M3 |
| `codex` | **Full.** Real adapter — drives `codex` CLI in headless/exec mode; permission bridge. Enables the flagship demo (Architect→Claude, Developer→Codex). | M3.5 / alongside M4 |
| `gemini-cli` | **Stub.** `detect()` returns `available:false, reason:"adapter not implemented"`. Interface wired, TODO documented. Antigravity same. | post-v0.1 |

The abstraction is **vendor-neutral**: no provider name appears in `core`. Adding a
provider = one new folder implementing `ProviderAdapter`, zero core changes. Full
contract lives in `docs/PROVIDER-ADAPTERS.md`.

---

## 6. Agent & task lifecycle

### 6.1 Run modes

- **`single`** (ship first): one agent, one objective. It plans, creates tasks,
  produces artifacts, signals `done`. Minimal orchestration.
- **`crew`** (M4 — required for public v0.1): an **orchestrator** member (flagged in the
  team pack) decomposes the objective into tasks and assigns them; members execute their
  tasks; orchestrator reviews `review`-state tasks and closes the run. Communication via
  Messages. This delegate-and-collaborate loop is DayCrew's core differentiation.

### 6.2 The turn loop (in `core`)

```
loop until run terminal:
  1. reconcile: load tasks, messages, approvals; compute each agent's readiness
     (deps satisfied, not blocked-on-approval, has pending input or is orchestrator)
  2. for each ready agent (bounded concurrency, default 1–2):
       - build turn context (its tasks, unread inbox, memory)
       - handle.send(context);  drain handle.events:
           text          → event log
           tool_call/res → event log
           approval_request → create ApprovalRequest, set agent blocked-on-approval,
                              pause this agent, emit event
           task_update   → apply to tasks.json, emit event
           message_out   → write to recipient inbox, emit event
           usage         → update run.usage
           done          → mark agent done
       - on turn_end: persist projections
  3. route: deliver queued messages, resume agents whose approvals were decided
  4. guardrails: check maxTurns / maxUsd / maxWallclock / idle / loop-detection
     → on breach: pause run, emit guardrail.tripped, require human decision
  5. completion check: orchestrator emitted done, OR (single mode) the agent done,
     OR all tasks terminal → run status = review → done
```

### 6.3 Guardrails (reuse hive's circuit-breaker idea)

- Hard limits from `run.limits` (turns, spend, wallclock).
- **Loop detection:** same tool + same input N times, or task bouncing between two
  states → pause + flag.
- **Idle detection:** no state change for `idleTimeoutMs` → pause + flag.
- All breaches are recoverable: human can raise limits and resume.

---

## 7. Human approval system

### 7.1 Permission policy

```ts
type PermissionPolicy = {
  mode: "auto" | "ask" | "readonly";      // default: "ask"
  rules?: Array<{
    actionClass: ApprovalRequest["actionClass"];
    match?: string;        // glob/regex on command or path or host
    effect: "allow" | "ask" | "deny";
  }>;
};
```

- `readonly` — deny every mutating actionClass outright.
- `ask` (default) — every risky action becomes an ApprovalRequest unless a rule says `allow`.
- `auto` — allow unless a rule says `ask`/`deny`. Opt-in, documented as unsafe for untrusted objectives.
- Ships with a **conservative built-in allowlist** for obviously-safe reads
  (`git status`, `ls`, `cat`, `pnpm test`, …). Everything else asks.

### 7.2 Flow

```
adapter emits approval_request  (or core classifies an intercepted action)
  → core appends ApprovalRequest{status:pending} to approvals.jsonl
  → agent.status = blocked-on-approval; agent paused
  → event approval.requested
  → surfaced in: CLI (`daycrew approvals`, or inline prompt), web approval queue
  → human decides: approve | deny (+ optional feedback text)
  → core appends decision, emits approval.decided
  → agent resumed: adapter told allow/deny; feedback injected as the next turn input
  → timeout (configurable, default 30 min) → status=expired → treated as deny
```

### 7.3 Trust boundary

For providers with **native permission prompts** (claude-code), the adapter bridges
those prompts to our ApprovalRequest — we do **not** re-implement sandboxing. Our
policy engine is a second gate on the *input we send* and on classified
`message_out` / `net.request` actions. For providers without native gating, the
adapter must run the agent in a restricted mode or the policy engine must intercept
at the tool layer (documented per-adapter; codex/gemini stubs note this).

### 7.4 Remote approval

The approval queue is a clean integration point. MVP exposes it over the local
WS API (M5); the human can approve from the dashboard on any device on the LAN.
Native Claude Code remote-control style approval is a post-MVP enhancement.

---

## 8. Security / privacy / risk register

| Risk | Mitigation in MVP |
|---|---|
| Agent runs destructive shell (`rm -rf`, `git push --force`) | Default `ask` policy; `fs.delete` / `git.push` never auto-allowed; workspace `cwd` jail + path checks |
| Secret exfiltration (`.env`, keys) via network | `net.request` always asks; log redaction pass (strip token-shaped strings) before writing `agents/*/logs/` |
| Prompt injection from file/web/tool output | Tool output treated as data; risky follow-on actions still hit the approval gate; `deny-all-ask` network posture |
| Inter-agent message injection | Messages are untrusted input to the receiving agent; same approval gate applies downstream |
| Provider credentials leaking into repo | DayCrew never writes creds; relies on each CLI's own auth store; `.daycrew/state/` gitignored by `daycrew init` |
| Telemetry / phone-home (OSS trust) | Telemetry **off by default**, opt-in only, documented what is sent |
| Runaway spend | `run.limits.maxUsd` hard stop + `usage.updated` events + guardrail pause |
| Supply chain | Pin deps, minimal dependency surface, no post-install scripts in our packages |

**Decided:** default network posture = **`deny-all-ask`**. Every outbound request the
engine can classify becomes an approval. Users opt into an allowlist per project.

---

## 9. Milestones

| # | Milestone | Contents | Gate |
|---|---|---|---|
| **M0** | Skeleton | pnpm workspace, `shared` zod schemas, `cli` scaffold, `mock` adapter, `team-pack` loader + schema, one first-party pack (`software-development`), vitest, CI (lint+typecheck+test), `daycrew init` | — |
| **M1** | Work session (single) | run store (files), turn loop, event bus, task manager, `daycrew run "<objective>"`, `daycrew status`, `daycrew tail` — green against `mock` | — |
| **M2** | Approval system | policy engine, ApprovalRequest lifecycle, `approvals.jsonl` audit, `daycrew approvals` interactive, `deny-all-ask` network gate, mock emits approvals | — |
| **M3** | claude-code adapter | `detect`, `startAgent`, normalized events, permission-prompt bridge, MCP passthrough; `daycrew run` works on real Claude | **✅ Internal alpha** |
| **M3.5** | codex adapter | real `codex` CLI adapter (headless/exec), permission bridge, vendor-neutrality audit | with M4 |
| **M4** | Team session (crew) | orchestrator loop, inter-agent messages, task assign/review, 2+ first-party packs, flagship demo: Architect→Claude Code + Developer→Codex | **✅ Public v0.1** |
| **M5** | Web dashboard | `daycrew serve` (Fastify+WS), React board: sessions list, task kanban, live event stream, approval queue (approve/deny) | fast-follow after v0.1 |

- **Internal technical alpha = M0–M3.**
- **First public release (v0.1) = M0–M4** (+ M3.5 codex adapter). Multi-member teams
  that delegate and collaborate are the differentiator and must be in the public cut.
- **M5** ships immediately after v0.1.

---

## 10. Task delegation

### To 💻 Dwight – Core Developer

| Task | Milestone | Notes |
|---|---|---|
| **D1** Repo skeleton: pnpm workspace, `shared` zod schemas (all §4 entities + §5 adapter contract + §7 policy + team-pack manifest), `cli` scaffold, `mock` adapter, CI (lint/typecheck/test) | M0 | **Land the `ProviderAdapter` + `AgentEvent` + team-pack schemas FIRST** as a `docs/PROVIDER-ADAPTERS.md` + `docs/TEAM-PACKS.md` code sync, so Jim can build against them. Small PRs. |
| **D2** `team-pack` loader (discovery precedence, manifest validation, instruction resolution) + first-party `software-development` pack | M0 | Packs are data; loader lives in `core`. No provider names in the loader. |
| **D3** `core` engine: file-based run store, event bus, turn loop, task manager — single (`work session`) mode | M1 | Events = source of truth; `run.json`/`tasks.json` rebuildable from `events.jsonl` |
| **D4** Approval + permission engine + `deny-all-ask` network gate + audit log | M2 | Policy schema §7.1; conservative built-in read allowlist |
| **D5** `claude-code` provider adapter | M3 | detect, startAgent, event normalization, native-permission bridge, MCP passthrough |
| **D6** Crew/orchestrator mode: orchestrator loop, message router, task assign/review, run completion | M4 | The delegate-and-collaborate loop |
| **D7** `codex` provider adapter + vendor-neutrality audit (grep `core` for provider names → must be zero) | M3.5 | Enables flagship demo |

### To 🎨 Jim – Frontend & QA

| Task | Milestone | Notes |
|---|---|---|
| **J1** QA harness: end-to-end `work session` driven by `mock`, golden `events.jsonl` assertions; runs in CI | M0–M1 | Needs only the D1 contract |
| **J2** Independent contract review: adapter interface, event schema, team-pack manifest — challenge them before code hardens; own `examples/` + quickstart | M0–M1 | Architect-adjacent review role; report findings to Michael |
| **J3** CLI UX: `daycrew status`, `daycrew tail`/`watch`, `daycrew approvals` interactive TUI, `daycrew team` (list/show packs) | M1–M2 | One consistent output format + `--json` for scripting |
| **J4** Team-pack authoring test: build `academic-research` or `marketing` pack **using only public docs**, no core changes — this is the acceptance test for the extension point | M4 | If it needs a core change, the extension point failed |
| **J5** Crew-mode e2e: multi-member `mock` session with delegation + review + approval, golden log | M4 | Gates v0.1 |
| **J6** Web dashboard (Vite+React): sessions list, task kanban, live WS event stream, approval queue | M5 | Design the WS event contract with Dwight |

### Sequencing

```
D1 ─┬─> D2 ─> D3 ─> D4 ─> D5 ──> D6 ─> (v0.1)
    │                      └─> D7 (codex, parallel w/ D6)
    └─> J1, J2 (parallel, gate D-contracts)
D3 ─> J3
D6 ─> J4, J5  (gate v0.1)
D6 ─> J6 (M5)
```

---

## 11. Terminology

| Internal (code, docs, logs) | User-facing (CLI output, dashboard, marketing) |
|---|---|
| `member` — configured crew member (from a team pack) | **Team member** |
| `agent` — runtime instance of a member during a run | *(not exposed; "team member" everywhere)* |
| `run` — a runtime execution | **Work session** (single) / **Team session** (crew) |
| `task` | **Task** |
| `approval` / `ApprovalRequest` | **Approval** |
| `team pack` / `crew template` | **Team** / **Team pack** |
| `provider` / `adapter` | **Engine** (e.g. "runs on Claude Code") |
| `orchestrator` | **Lead** (the team member who coordinates) |

Rule: **do not surface "AI agent" vocabulary to non-technical users.** The product
talks about *teams* and *team members* doing *work sessions*.

---

## 12. Open-source / contributor foundation (ship with M0)

Repo is `git init`ed now, **MIT** licensed, local/private during M0, **made public
once the skeleton is clean, documented, and CI is green**. Present from the first commit:

| File | Purpose |
|---|---|
| `LICENSE` | MIT |
| `README.md` | What DayCrew is, quickstart, status (alpha), links |
| `CONTRIBUTING.md` | Dev setup (pnpm), branch/PR flow, commit style, how to add a **team pack** and a **provider adapter** (the two blessed extension points) |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `SECURITY.md` | Private disclosure contact, scope (agent sandbox / approval bypass / secret exfil), no-bug-bounty note |
| `ROADMAP.md` | M0→M4→M5 and beyond, kept in sync with this doc |
| `.github/ISSUE_TEMPLATE/` | `bug_report.yml`, `feature_request.yml`, `team_pack_submission.yml` |
| `.github/PULL_REQUEST_TEMPLATE.md` | checklist: tests, docs, changeset, no core change for pack/adapter PRs |

**Extension points are the community contract** (`docs/TEAM-PACKS.md`,
`docs/PROVIDER-ADAPTERS.md`): a contributor can add a team pack or a provider adapter
**without modifying `packages/core`**. Any PR that needs a core change to add a pack or
adapter is a design bug in the extension point.
