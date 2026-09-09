<!-- Thanks for contributing to DayCrew! Keep PRs small and focused. -->

## What & why

<!-- One or two sentences. Link the issue: Closes #123 -->

## Type

- [ ] `feat` — new capability
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `pack` — new/updated Team Pack
- [ ] `adapter` — new/updated provider adapter
- [ ] `chore` / `test` / `refactor`

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass locally
- [ ] Tests added or updated for the change
- [ ] Docs updated (`README`, `docs/`, `ROADMAP` as relevant)
- [ ] Conventional Commit messages

## Extension-point PRs only

- [ ] **This PR does not modify `packages/core`.**
      (Pack and adapter contributions must not need core changes — if yours does,
      open a separate issue describing the gap in the extension point.)
- [ ] Pack: `daycrew team validate` passes; `README.md` + license present
- [ ] Adapter: passes the shared contract test suite; trust-boundary section added
      to the adapter `README.md`; no imports from `packages/core`

## Security / permissions impact

<!-- Does this touch the approval gate, the workspace jail, network posture, or
     secret handling? If yes, describe. If no, write "none". -->
