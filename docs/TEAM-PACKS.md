# Team Pack Format

## Contributor quickstart

1. Copy `team-packs/software-development` to a new kebab-case directory.
2. Replace the manifest, Team definition, and role instructions with a coherent professional workflow.
3. Keep every file data or Markdown; never add executable extension code.
4. Define exactly one Manager and use generic Team/Member/Task concepts rather than custom UI logic.
5. Run `pnpm check`, include a loader test, and explain why every role is needed.

Contributors do not need to change `packages/core`. A small mature pack is preferred to a large filler roster.

A Team Pack defines a reusable professional Team as data and Markdown instructions.
Adding one must not require changes to `packages/core`.

## Directory format

```text
software-development/
  pack.json
  team.json
  instructions/
    manager.md
    architect.md
    developer.md
    qa.md
  README.md
```

`pack.json` contains `schemaVersion`, a stable `id`, display `name`, semantic
`version`, `description`, `license`, and `author`.

`team.json` contains `schemaVersion`, display `name`, `description`, the default
autonomy level, and Members. Every pack must define exactly one Member with
`isManager: true`. Each Member points to an instruction file using
`instructionsFile`; paths must remain inside the pack directory. Engine selection is
`auto` unless an optional preference is supplied.

Example:

```json
{
  "schemaVersion": 1,
  "name": "Software Development",
  "description": "Plans, builds, and reviews software changes.",
  "autonomy": "work-with-approval",
  "members": [
    {
      "id": "manager",
      "name": "Engineering Manager",
      "role": "Manager",
      "instructionsFile": "instructions/manager.md",
      "isManager": true,
      "engine": { "mode": "auto" }
    }
  ]
}
```

The zod source of truth is `packages/shared/src/team-pack.ts`. Unknown keys are
rejected. Schema-version changes require migration documentation.

## Loading and safety

DayCrew currently ships the reviewed `software-development` pack from the repository
and installs a validated copy into the selected Workspace. The loader validates both
JSON files, rejects absolute or traversing instruction paths, resolves instructions as
text, and never executes pack code. Community pack discovery and distribution are
intentionally deferred until after the public alpha.

## Contribution acceptance

A Team Pack contribution must validate, include its role instructions and license,
avoid secrets/provider-specific tool syntax, and change no core source. Bundled packs
live under `team-packs/`; community distribution mechanics are deferred.
