<h1 align="center">DayCrew</h1>

<p align="center">
  <b>An open-source work operating system.</b><br>
  Build a team of specialized AI members, give them an objective, and watch them
  delegate, collaborate, and ship — with you approving anything risky.
</p>

<p align="center">
  <i>Status: pre-alpha. Under active construction. Not yet usable.</i>
</p>

---

## What it is

DayCrew runs on your machine. You pick a **Team** — a small crew of members with
defined roles (a Lead, a Developer, a QA engineer, …) — and start a **work session**
against a goal. The Lead breaks the goal into tasks, hands them to teammates, reviews
the results, and reports back. Every shell command, file deletion, network call, or
spend passes through an **approval** you control.

- **Model-agnostic.** Each team member runs on a pluggable engine: Claude Code,
  Codex CLI, Gemini CLI, local models. Mix them in one team.
- **Local-first.** All state is plain JSON/JSONL files you can read, diff, and commit.
- **Human-in-the-loop.** Risky actions stop and wait for your yes/no, with a full
  audit trail.
- **Extensible by design.** Add a **Team Pack** or a **provider adapter** without
  touching the core engine.

## Use cases

Software development · e-commerce · job search · academic research · marketing ·
cybersecurity — each ships as a first-party Team Pack, and the community can add more.

## Quickstart

> Not available yet — the CLI lands with milestone M1. Track progress in
> [`ROADMAP.md`](./ROADMAP.md).

```bash
# (planned)
pnpm add -g daycrew
daycrew init
daycrew run "add pagination to the products API"
```

## Architecture

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the full design
- [`docs/TEAM-PACKS.md`](./docs/TEAM-PACKS.md) — how Teams are defined (extension point)
- [`docs/PROVIDER-ADAPTERS.md`](./docs/PROVIDER-ADAPTERS.md) — how engines plug in (extension point)

## Contributing

DayCrew is built in the open and designed to be contributor-friendly from day one.
See [`CONTRIBUTING.md`](./CONTRIBUTING.md), [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md),
and [`SECURITY.md`](./SECURITY.md).

## License

[MIT](./LICENSE)
