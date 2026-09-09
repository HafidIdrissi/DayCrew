# DayCrew Roadmap

Kept in sync with [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Dates are targets,
not promises.

## Internal technical alpha — M0 → M3

| Milestone | Goal | State |
|---|---|---|
| **M0 — Skeleton** | pnpm monorepo, `shared` zod schemas, CLI scaffold, `mock` engine, Team Pack loader + schema, first-party `software-development` pack, CI green | 🚧 in progress |
| **M1 — Work session (single)** | file-based run store, turn loop, event log, task manager; `daycrew run` / `status` / `tail` green on `mock` | ⏳ |
| **M2 — Approvals** | permission policy engine, approval lifecycle + audit log, `deny-all-ask` network gate, `daycrew approvals` | ⏳ |
| **M3 — Claude Code engine** | real `claude-code` adapter, native-permission bridge, MCP passthrough; `daycrew run` on real Claude | ⏳ |

## First public release — v0.1 (M0 → M4, + M3.5)

| Milestone | Goal | State |
|---|---|---|
| **M3.5 — Codex engine** | real `codex` adapter; vendor-neutrality audit | ⏳ |
| **M4 — Team session (crew)** | orchestrator/Lead loop, inter-member messaging, task assignment + review; flagship demo: Lead→Claude Code, Developer→Codex; 2+ first-party packs | ⏳ |
| **Repo goes public** | once skeleton is clean, documented, CI green | ⏳ |

Multi-member teams that delegate and collaborate are the reason DayCrew exists — the
public v0.1 must include them.

## Fast-follow

| Milestone | Goal |
|---|---|
| **M5 — Web dashboard** | `daycrew serve`: sessions list, task kanban, live event stream, approval queue |
| **More engines** | Gemini CLI, Antigravity, local models (Ollama/llama.cpp) |
| **More first-party Team Packs** | ecommerce, job-search, academic-research, marketing, cybersecurity |
| **Community pack registry** | `daycrew team add <source>`, discoverable index |
| **Remote approvals** | approve from another device / phone |

## Guiding constraints

- Local-first, file-based state. No mandatory services or databases.
- The engine (`packages/core`) never names a provider.
- Team Packs and provider adapters are addable with zero core changes.
- Approval gate and workspace jail are on by default and cannot be silently disabled.
- Telemetry is opt-in.
