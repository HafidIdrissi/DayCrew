# Contributing to DayCrew

Thank you for helping build DayCrew. The project is early; small, focused changes and
clear design discussion are especially valuable.

## Development setup

Requirements: Node.js 20.19+ and pnpm 10.

```bash
corepack enable
pnpm install
pnpm check
```

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and
`chore:`. Keep one coherent concern per pull request. Update schemas, tests, and docs
together when a public contract changes.

## Architecture rules

- Keep provider-specific code out of `packages/core`.
- Keep Team Packs data-only.
- Preserve the user model: Workspace -> Team -> Manager + Members.
- Do not expose implementation jargon in normal UI copy.
- Do not weaken approval or audit behavior.
- Discuss new infrastructure or dependencies before adding them.

See [AI Engine adapters](./docs/PROVIDER-ADAPTERS.md) and
[Team Packs](./docs/TEAM-PACKS.md) for the two primary extension contracts.

## Pull requests

Open an issue for material product or architecture changes. Before requesting review,
complete the PR template and ensure `pnpm check` passes. Report security issues using
the private process in [SECURITY.md](./SECURITY.md), not a public issue.
