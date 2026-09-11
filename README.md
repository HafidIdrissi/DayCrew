# DayCrew

DayCrew is an open-source, local-first AI work operating system. Users create a
Workspace, assemble specialized Teams, give each Team Manager a goal, and review
only the decisions and work that need human attention.

> Status: M1-M3 functional local MVP core. Workspaces, Teams, deterministic
> Manager-led work sessions, tasks, and Needs You are available through CLI and API.

## Product shape

- A Workspace contains Teams.
- Every Team has exactly one Manager and zero or more specialist Members.
- The Manager plans, delegates, coordinates handoffs, and surfaces important items
  in one **Needs You** inbox.
- The normal interface has four views: Home, Teams, Tasks, and Office.
- AI engine and model details stay under Advanced Settings.

DayCrew is not a generic chat application. Its core experience is a human-controlled
team completing visible work through tasks and handoffs.

## Principles

Local-first · provider-neutral · secure by default · understandable to
non-technical users · extensible through Team Packs and AI Engine adapters.

## Development

Requirements: Node.js 20.19+ and pnpm 10.

```bash
corepack enable
pnpm install
pnpm check
pnpm dev
```

`pnpm dev` starts the local Fastify API and React application. Create or open a
Workspace by entering an existing folder's full path in the welcome screen.
DayCrew remembers this selection in OS-local app config; runtime state lives in
that folder's `.daycrew/`, independently of the DayCrew installation or command
working directory. See [Local Workspaces](./docs/WORKSPACES.md) for startup
overrides, CLI behavior, storage locations, APIs and safety boundaries.
The MVP mock engine is deterministic and requires no credentials or network access.

Claude Code is the first production-ready writable AI Engine. Every action it takes is
gated by DayCrew before it runs, and a denial prevents the action. Detect it with
`node packages/cli/dist/bin.js provider detect claude-code` after building the CLI, and
read the [Claude Code trust boundary](./docs/CLAUDE-ADAPTER.md) before enabling writes.

Codex is available as an explicitly enabled read-only preview. Detect it with
`node packages/cli/dist/bin.js provider detect codex` after building the CLI. Read
the [Codex trust boundary](./docs/CODEX-ADAPTER.md) before enabling it.

## Packages

- `packages/shared` — runtime schemas and provider-neutral contracts
- `packages/core` — persisted Workspace, Team, work-session, task, and human-control logic
- `packages/providers` — AI Engine adapters and deterministic mock
- `packages/cli` — command-line entry point
- `packages/server` — local Fastify API
- `packages/web` — React/Vite UI scaffold

See [Product](./docs/PRODUCT.md), [Architecture](./docs/ARCHITECTURE.md), and
[MVP scope](./docs/MVP.md).

## Contributing and security

Read [CONTRIBUTING.md](./CONTRIBUTING.md), [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md),
and [SECURITY.md](./SECURITY.md). DayCrew is licensed under the [MIT License](./LICENSE).
