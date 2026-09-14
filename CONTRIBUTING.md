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

## Choose a contribution path

| Level | Contribution | You need to understand |
|---|---|---|
| Easy | [Add a Skill](./docs/SKILLS.md#five-minute-skill-quickstart) | JSON metadata, Markdown instructions, capability declarations |
| Medium | [Create a Team Pack](./docs/TEAM-PACKS.md#contributor-quickstart) | professional roles, data-only manifests, Member instructions |
| Advanced | [Build a Provider Adapter](./docs/PROVIDER-ADAPTERS.md#contributor-quickstart) | the typed provider boundary, event normalization, safety testing |

You do not need to understand the whole orchestrator for any of these paths. Start with the linked validator and focused package tests, then run the repository gates before opening a pull request.

See [good first issue candidates](./docs/GOOD_FIRST_ISSUES.md) for bounded starter work.

## Pull requests

Open an issue for material product or architecture changes. Before requesting review,
complete the PR template and ensure `pnpm check` passes. Report security issues using
the private process in [SECURITY.md](./SECURITY.md), not a public issue.
