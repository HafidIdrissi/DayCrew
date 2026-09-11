# DayCrew MVP Scope

## Exact MVP scope

The MVP is complete when a user can:

1. Create a local Workspace.
2. create a Team from a bundled Team Pack or define a custom Team;
3. give the Team Manager a goal and start a Work Session;
4. see the Manager decompose the goal, assign work, coordinate Member handoffs, and
   review results;
5. use a task board with Todo, In Progress, Review, and Done;
6. handle approvals, decisions, blockers, and review-ready work in one Needs You
   inbox;
7. choose Assist me, Work with approval, or Autonomous, subject to hard safety rules;
8. maintain shared Team Knowledge and basic per-Member memory;
9. use automatic AI Engine selection or manual engine/model choices in Advanced
   Settings;
10. inspect a local Activity/audit log and a Daily Brief;
11. operate through Home, Teams, Tasks, and optional Office views;
12. install data-only Team Packs and independently contributed AI Engine adapters.

The adapter architecture targets Codex, Claude Code, Gemini/Antigravity, and future
providers. The MVP release requires the abstraction, deterministic mock, and at least
two production-ready adapters; the order is decided milestone by milestone.

## Explicitly deferred

- Cloud hosting, hosted accounts, authentication, billing, and multi-tenant storage.
- A database, distributed queue, workers, or other always-on infrastructure.
- Electron or native mobile/desktop applications.
- Remote/LAN administration and remote approvals.
- Team hierarchies beyond Workspace -> Team -> Manager + Members.
- A public Team Pack marketplace, ratings, payments, or automatic remote updates.
- Large-scale semantic/vector memory and autonomous long-term memory consolidation.
- Enterprise permissions, SSO, organization administration, and policy servers.
- Real-time multi-user editing.
- Voice/video avatars, a game-like simulation, or Office features required for work.
- Broad integration catalogs and real providers beyond those selected for the MVP.
- Telemetry enabled by default.

## Milestones

### M0 — Foundation (implemented in this change)

- pnpm/TypeScript monorepo and package boundaries.
- `shared`, `core`, `providers`, `cli`, `server`, and `web` scaffolds.
- Basic zod domain schemas and neutral provider contract.
- Deterministic mock adapter and contract tests.
- Fastify health endpoint and minimal four-view React shell.
- Vitest, TypeScript checks, ESLint, CI, and OSS foundation files.
- Product, architecture, MVP, Team Pack, and adapter documentation.

Exit gate: install, build, test, typecheck, and lint succeed without credentials.

### M1 — Local foundations

- Atomic local Workspace store and Workspace creation.
- Team Pack discovery, validation, and one bundled software-development pack.
- Custom Team creation using the same schemas.
- Team/Member/Knowledge repositories and basic per-Member memory files.
- CLI commands needed to exercise these foundations without exposing internals.

Exit gate: create, reload, and validate a Workspace and Team entirely offline.

### M2 — Single-Member Work Session

- Work Session store, append-only Activity events, task projection, and guardrails.
- Single Manager turn loop against the mock adapter.
- Goal-to-task planning, task status transitions, usage accounting, stop/interrupt.
- CLI start/status/activity flows and deterministic end-to-end tests.

Exit gate: a mock-backed session survives restart and produces reproducible state.

### M3 — Human control

- Autonomy policy evaluator and hard safety boundaries.
- Approval/decision/blocker lifecycle and Needs You projection.
- Audited approve/deny/resume flow and Daily Brief projection.
- Adversarial tests for destructive actions, path escape, network, and secrets.

Exit gate: no classified risky mock action executes without the required decision.

### M4 — Team collaboration

- Multi-Member scheduling, Manager decomposition/delegation, dependency handling,
  handoffs, review, and completion.
- Shared Knowledge and per-Member memory injected with explicit size limits.
- At least two bundled Team Packs and a custom-Team acceptance test.

Exit gate: a deterministic multi-Member Team completes a delegated goal with visible
handoffs and Manager review.

### M5 — Product interface

- Stable local Fastify API and resumable WebSocket activity feed.
- Home, Teams, Tasks, and Office views.
- Manager conversation, task board, Needs You actions, Daily Brief, Knowledge, and
  Advanced AI Engine settings.
- Office remains optional and original to DayCrew.

Exit gate: the complete mock-backed MVP flow works without a terminal after startup.

### M6 — Real AI Engines and MVP release

- Production adapters selected from Codex, Claude Code, and Gemini/Antigravity.
- Adapter conformance, permission-bridge, cancellation, and recovery tests.
- Packaging, upgrade notes, threat-model review, accessibility pass, and release docs.

Exit gate: at least two real engines can participate in a Team without core changes;
all MVP acceptance tests pass.

## Scope control

Each milestone must pass lint, typecheck, and tests before the next starts. New
features or infrastructure require Product Owner approval and an update to this file.
