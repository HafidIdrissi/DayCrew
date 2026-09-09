# Contributing to DayCrew

Thanks for being here. DayCrew is early — the best contributions right now are
sharp reviews of the contracts, new **Team Packs**, and new **provider adapters**.

## Ground rules

- Be kind. See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
- Discuss non-trivial changes in an issue before opening a PR.
- Security issues go through [`SECURITY.md`](./SECURITY.md), **not** public issues.

## Dev setup

Requirements: Node 20+, pnpm 9+.

```bash
git clone https://github.com/daycrew/daycrew
cd daycrew
pnpm install
pnpm build
pnpm test        # vitest, uses the deterministic `mock` engine — no API keys needed
pnpm lint
pnpm typecheck
```

The monorepo layout and dependency rules are in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#3-repository-structure).

## Branches, commits, PRs

- Branch from `main`: `feat/…`, `fix/…`, `docs/…`, `pack/…`, `adapter/…`.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- One logical change per PR. Keep them small.
- Every PR: tests pass, docs updated, `PULL_REQUEST_TEMPLATE` checklist complete.
- CI (lint + typecheck + test) must be green before review.

## The two extension points

DayCrew has exactly two blessed ways to extend it **without changing `packages/core`**.
A PR that adds a pack or adapter and also modifies `packages/core` will be sent back —
that means the extension point has a gap, which we fix separately.

### 1. Add a Team Pack

A Team Pack is data: a directory with `pack.yaml`, `team.yaml`, and instruction
markdown. Full spec: [`docs/TEAM-PACKS.md`](./docs/TEAM-PACKS.md).

```bash
daycrew team validate ./team-packs/community/my-team
```

Submit under `team-packs/community/<id>/`, or publish to npm as
`daycrew-team-pack-<id>` and add it to `docs/community-packs.md`.

### 2. Add a provider adapter

An adapter teaches DayCrew to run a member on a new engine. Full spec and the
acceptance checklist: [`docs/PROVIDER-ADAPTERS.md`](./docs/PROVIDER-ADAPTERS.md).

- One folder in `packages/providers/<engine>/`.
- No imports from `packages/core`.
- Maps the engine to the normalized `AgentEvent` stream only.
- Passes the shared adapter contract test suite.
- Documents its trust-boundary behavior in the adapter's `README.md`.

## What we won't merge

- Anything that weakens the approval gate or the `cwd` workspace jail by default.
- Provider names hard-coded in `packages/core`.
- New runtime infrastructure (databases, services) without a design discussion —
  DayCrew is deliberately file-based and local-first.
- Telemetry that is on by default.
