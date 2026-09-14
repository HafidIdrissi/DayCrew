# DayCrew v0.1.0-alpha — draft release notes

> **ALPHA SOFTWARE:** review the known limitations and use a disposable or backed-up Workspace. This draft is prepared for Product Owner review and has not been published.

DayCrew is an open-source, local-first AI work operating system. Build a Team with a Manager and specialized Members, give the Manager a goal, and let the Team coordinate Tasks and handoffs while Needs You keeps the human in control.

## Included

- Workspace-isolated local state
- Teams, Manager-led goals, Tasks, dependencies, and handoffs
- permanent and Task-scoped Skills
- Needs You and real approval decisions
- Home, Team, Tasks, and early Office views
- one mature Software Development Team Pack
- twelve curated Skills with explicit capability declarations

## Providers

- **Claude Code:** production-ready actionable provider within its documented alpha boundary; supports DayCrew approval bridging.
- **Codex:** read-only preview; writes and native approval bridging are unavailable.
- **Gemini / Antigravity:** restricted experimental; never Auto-selected.
- **Demo:** deterministic, explicitly labelled simulated engine; never Auto-selected.

## Install

Requires Node.js 20.19+ and pnpm 10. Run `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm build`, then `pnpm dev`. See [Installation](./INSTALLATION.md).

## Security model

DayCrew checks provider capabilities and autonomy policy at runtime. Skills and Team Packs are data and instructions, not executable permission bundles. A Skill requirement never grants a Tool. Risky actions use Needs You before execution where the adapter can provide a trustworthy approval bridge.

## Contribute

- Easy: add a Skill.
- Medium: create a Team Pack.
- Advanced: implement the provider-neutral adapter contract.

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [good first issue candidates](./GOOD_FIRST_ISSUES.md).
