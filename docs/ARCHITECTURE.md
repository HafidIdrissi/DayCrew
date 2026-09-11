# DayCrew Architecture

## Architecture goals

The implementation is local-first, provider-neutral, modular, and deliberately
small. The web app and CLI call the same local application services. Domain code
never imports a concrete AI Engine.

## Package boundaries

```text
web ---------> server ---------> core ---------> shared
                   |                               ^
cli ---------------+                               |
                   +---------> providers ----------+
```

- `shared`: zod schemas, types, stable identifiers, and the neutral AI Engine
  contract. It has no internal package dependencies.
- `core`: Workspace, Team, task, approval, knowledge, activity, and work-session
  services. It depends only on `shared`.
- `providers`: concrete adapters. M0 contains only the deterministic mock. It depends
  only on `shared` and never on `core`.
- `server`: composition root and local Fastify HTTP/WebSocket boundary. It may depend
  on `core`, `providers`, and `shared`.
- `cli`: local commands and another composition root. It may depend on the same
  application packages as `server`.
- `web`: React/Vite client. It talks to `server`; it does not coordinate Teams.

This dependency shape keeps provider names out of `core` and lets contributors add
an adapter without editing core logic.

## Runtime model

Each Work Session has one Team snapshot, one Manager runtime, zero or more Member
runtimes, tasks, messages/handoffs, shared Knowledge references, an autonomy policy,
and per-member engine/model choices. Auto selection is the default; manual choices
are an Advanced Setting.

The Manager owns planning and coordination. Core validates Manager requests, changes
task state, routes handoffs, applies autonomy and risk policy, persists state, and
produces Activity/Needs You projections. Providers only start Members and normalize
their output.

## AI Engine contract

`ProviderAdapter` supplies `detect()`, capabilities, and `startAgent()`. A returned
handle accepts input, can be interrupted or stopped, and exposes one asynchronous
stream of normalized events:

`text`, `tool_call`, `tool_result`, `task_update`, `message`, `approval_request`,
`usage`, `done`, and `error`.

The core consumes only this contract. Native process formats, session IDs, tool
protocols, and provider-specific permission prompts remain inside the adapter.

## Local persistence and Workspace selection

The installation root and the user Workspace root are independent. The web app
selects an existing user directory through the loopback API. Successful selection
is remembered in OS-local app config; no server or Vite working directory is
implicitly treated as a Workspace. CLI discovery is explicitly opt-in at the
composition boundary.

Core exports a canonical `WorkspaceRoot` and validates every derived state path.
Workspace metadata, Teams, Knowledge, Memory, Sessions, Tasks, approvals and
Activity stay under `<WorkspaceRoot>/.daycrew/`. Application config contains only
selected/recent Workspace locations and future UI preferences.

Server requests capture an immutable root and selection token. Switching rejects
stale requests and responses, and the Team dashboard loads as one aggregate from
that context. Provider handles retain their original root and safety policy.

See [Local Workspaces](./WORKSPACES.md) for the persistence layout, cross-platform
app config locations, API contracts, onboarding and security details.

## Live updates

Core publishes domain events in-process. The local server converts them to a stable
WebSocket feed for the web app. Persisted Activity is authoritative; a reconnecting
client resumes from the last sequence number. M0 creates only the HTTP/server shell;
the live session feed starts after core persistence exists.

## Team Packs

A Team Pack directory contains a versioned manifest, a Team definition, and Markdown
instructions for each role. Loading performs schema validation, ensures exactly one
Manager, resolves files inside the pack boundary, and does not execute pack code.
Project-local packs override user-installed and bundled packs. M0 defines the schema;
loading and discovery are M1 work.

## Safety boundary

Core is the policy authority. The default autonomy level is **Work with approval**.
Adapters must not bypass pending approval. Risky actions are classified into stable
action classes and create Needs You items before execution. Autonomous mode can relax
ordinary confirmations but cannot cross hard safety boundaries. All requests and
human decisions enter the audit trail.

Path confinement is resolved from canonical paths rather than string prefixes.
Credentials are never persisted by DayCrew, secrets are redacted from logs, and
network access is denied/asked by default. Provider adapters must document any limit
in their ability to enforce these constraints.

## M0 decisions

- Node.js 20.19+, TypeScript, pnpm workspaces, and strict compiler settings.
- zod is the source of runtime validation and inferred domain types.
- Vitest provides unit/contract tests; the mock adapter makes tests deterministic.
- ESLint provides a small common rule set.
- Fastify and React/Vite are present only as runnable scaffolds.
- No real provider, orchestration loop, persistence engine, or production UI is built
  in M0.
