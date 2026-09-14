# DayCrew

**Build an AI team that works like a real team.**

DayCrew is an open-source, local-first AI work operating system. Create a Team of specialized Members, give the Manager a goal, and review only the decisions that need you.

> **v0.1.0-alpha preview:** DayCrew is early software. Use disposable or backed-up Workspaces and review the [known limitations](./docs/KNOWN_LIMITATIONS.md).

<!-- Replace this clearly marked placeholder with a real Home capture before launch. -->
> **Hero screenshot placeholder** — capture `#home` from the reproducible [demo Workspace](./docs/DEMO.md).

[Get started](#quickstart) · [Documentation](./docs/ARCHITECTURE.md) · [Contribute](./CONTRIBUTING.md)

## Why DayCrew?

```text
Chatbot                         DayCrew

You ↔ AI                       You → Manager → AI Team
                                      ├─ Architect
                                      ├─ Developer
                                      └─ QA
```

The Manager understands the goal, creates Tasks, delegates work, coordinates real handoffs, and surfaces approvals, decisions, blockers, failures, and reviews through **Needs You**.

## Features

- **Teams:** one Manager coordinating any set of specialist Members.
- **Skills:** reusable instruction and workflow extensions that never grant tool access.
- **Tasks and handoffs:** visible ownership, dependencies, Review, and work history.
- **Human control:** autonomy policy, pre-execution approvals where supported, and an audit trail.
- **Local first:** Workspace state stays in the selected project under `.daycrew/`.
- **Multiple engines:** a provider-neutral core with honest capability boundaries.
- **Team Packs:** data-only Teams that contributors can understand without changing orchestration.

## Product views

| Home | Team | Tasks | Office |
|---|---|---|---|
| Current work, attention, and activity | Manager, Members, Skills, and goals | Board, handoffs, and global Needs You | Early visual view of the same Team state |

Real capture instructions for Home, Team, Skills, Tasks, Needs You, and Office are in [docs/DEMO.md](./docs/DEMO.md). Mock screenshots are never shipped as product evidence.

## Provider matrix

| AI Engine | Program | Position | Actions | DayCrew approvals | Auto selection |
|---|---|---|---:|---:|---:|
| Claude Code | `claude` | Production-ready actionable provider | Yes, within its documented boundary | Yes | Yes, when available |
| Codex CLI | `codex` | Read-only preview | No writes | No native approval bridge | No |
| Antigravity Agent API | Antigravity app bridge | Restricted experimental | Not trusted for normal work | No | Never |
| Cursor CLI | `cursor-agent` | Read-only preview | No writes | No native approval bridge | Never |
| Grok Build | `grok` | Read-only preview | No writes | No native approval bridge | Never |
| Deterministic demo | — | Demo and tests | Simulated, clearly labelled | Full test lifecycle | Never |

Every engine is a **command-line tool you install and sign in to yourself**. DayCrew
runs it locally, reuses the sign-in that tool already has, and never asks for an API
key. The Antigravity row is the Antigravity desktop app's local Agent API, not the
separate Gemini CLI, which is not integrated.

Each Member picks its own engine, and — in manual mode — its own model from that
engine's catalogue. Engines are declared once in `packages/shared/src/engine.ts`, so a
new one reaches every picker without touching a screen. Read the
[Claude](./docs/CLAUDE-ADAPTER.md), [Codex](./docs/CODEX-ADAPTER.md),
[Antigravity](./docs/GEMINI-ADAPTER.md), [Cursor](./docs/CURSOR-ADAPTER.md), and
[Grok](./docs/GROK-ADAPTER.md)
security notes before enabling a real engine, and the
[engine validation record](./docs/ENGINE-VALIDATION.md) for what was actually observed
against the live engines — including what each one does not enforce.

## Two separate experiences

DayCrew ships a public marketing site and a local product application. They are built and hosted independently.

| | What it is | Package | Command | Address |
|---|---|---|---|---|
| **Site** | Static public site that presents DayCrew | `packages/site` | `pnpm dev:site` | `http://127.0.0.1:4173` |
| **App** | The product you work in, plus its local server | `packages/web` + `packages/server` | `pnpm dev` | app `http://127.0.0.1:5173`, API `http://127.0.0.1:5005` |

The site is plain static HTML and CSS: `pnpm build:site` emits `packages/site/dist`, which can be hosted anywhere. It never talks to the local API, and it cannot launch the app for you — a web page has no reliable way to reach a program on your machine, so it links to the install steps instead.

The app is a browser application served by Vite that talks only to the local DayCrew server on loopback. Agents run from that server, never in the browser.

## Quickstart

Prerequisites: **Node.js 20.19+**, **Corepack**, Git, and pnpm 10.

```bash
git clone https://github.com/daycrew/daycrew.git
cd daycrew
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Open `http://127.0.0.1:5173` and follow the first-run flow. Auto selects only Claude Code, the actionable alpha provider. If you do not have a ready provider, you can finish setup without starting a Goal or use the clearly labelled isolated [Demo Mode](./docs/DEMO.md). Platform-specific setup and troubleshooting are in [Installation](./docs/INSTALLATION.md).

To work on the public site instead:

```bash
pnpm dev:site     # http://127.0.0.1:4173
pnpm build:site   # static output in packages/site/dist
```

### Where things are in the app

| View | Route | What it does |
|---|---|---|
| Home | `#home` | Today's brief, Needs You highlights, team status, activity, and a composer to brief a Manager |
| Team | `#teams` → `#teams/<id>` | Team list, Manager and Member conversations, `#teams/<id>/overview` for configuration and Skills |
| Tasks | `#tasks` | Board with filters; `#tasks/<session>/<task>` opens dependencies, handoffs, approvals, results, and history |
| Needs You | `#needs-you` | Approvals, decisions, blockers, failed Tasks, and reviews, with actions wired to the local API |
| Office | `#office` | Selectable Members with live state, engine, current Task, and pending decisions |
| Skills | `#skills` | Workspace Skill library with capability checks and permanent assignment per Member |
| Settings | `#settings` | Workspace, AI Engine readiness, default autonomy, extensions, diagnostics |

Before contributing:

```bash
pnpm check
pnpm build
```

## Contribute at the layer that fits you

| Level | Extension | Start here |
|---|---|---|
| **Easy** | Add a Skill | [Create your first Skill in 5 minutes](./docs/SKILLS.md#five-minute-skill-quickstart) |
| **Medium** | Add a Team Pack | [Create a Team Pack](./docs/TEAM-PACKS.md#contributor-quickstart) |
| **Advanced** | Add an AI Engine adapter | [Build a Provider Adapter](./docs/PROVIDER-ADAPTERS.md#contributor-quickstart) |

See [CONTRIBUTING.md](./CONTRIBUTING.md), the [roadmap](./ROADMAP.md), and [good first issue ideas](./docs/GOOD_FIRST_ISSUES.md).

## Security and license

Skills and Team Packs contain data and instructions, never executable extension code. A declaration of required capabilities never grants filesystem, shell, network, MCP, credential, publishing, or spending access. Report vulnerabilities privately through the process in [SECURITY.md](./SECURITY.md).

DayCrew is available under the [MIT License](./LICENSE).
