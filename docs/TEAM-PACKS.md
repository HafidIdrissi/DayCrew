# Team Pack Format

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

## Loading policy (M1)

Discovery precedence will be project-local, user-installed, then bundled. The loader
will validate both JSON files, reject absolute/traversing instruction paths, resolve
instructions as text, and never execute pack code. A duplicate ID at the same
precedence is an error rather than an arbitrary choice.

## Contribution acceptance

A Team Pack contribution must validate, include its role instructions and license,
avoid secrets/provider-specific tool syntax, and change no core source. The bundled
packs will live under `team-packs/`; community distribution mechanics are deferred.
