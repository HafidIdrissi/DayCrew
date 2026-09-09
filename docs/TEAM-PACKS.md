# DayCrew Team Packs

**Status:** SPEC v0.1 — the community extension contract. Implemented in M0.

A **Team Pack** is a self-contained, versioned definition of a team: its members,
their roles and instructions, how they collaborate, and which engine each member
uses by default. Packs are **data, not code** — DayCrew's `core` engine loads a pack
through the pack loader and never needs changes to support a new one.

> If adding a team pack requires editing `packages/core`, that is a bug in this spec.

---

## 1. Anatomy of a pack

```
software-development/
├── pack.yaml               # manifest (required)
├── team.yaml               # team definition (required)
├── instructions/           # one markdown file per member (required if referenced)
│   ├── lead.md
│   ├── developer.md
│   └── qa.md
├── playbooks/              # optional: reusable task templates / checklists
│   └── ship-a-feature.md
├── assets/                 # optional: diagrams, reference docs the team can read
└── README.md               # optional but recommended: what this team is for
```

A pack may also be published as an npm package whose root contains these files.

---

## 2. `pack.yaml` — manifest

```yaml
schema: daycrew.pack/v1          # spec version this pack targets
id: software-development         # kebab-case, unique; matches directory name
name: Software Development        # user-facing
version: 1.0.0                   # semver
description: >
  A lead architect, a developer, and a QA engineer that design, build,
  and review software changes with human approval on risky actions.
author: DayCrew                  # name or handle
license: MIT
homepage: https://github.com/daycrew/daycrew   # optional
tags: [engineering, coding, review]     # free-form, for search
minDayCrewVersion: 0.1.0                 # optional
categories: [software-development]       # 1+ values from the fixed vocabulary in §6
```

Validated by the `PackManifest` zod schema in `packages/shared`. Unknown keys are
rejected (forward-compat is handled via `schema:` version bumps).

---

## 3. `team.yaml` — team definition

```yaml
schema: daycrew.team/v1

# Optional: declare the *roles* this team needs. daycrew.json binds roles → engines.
engines:
  lead:      { default: claude-code }
  developer: { default: codex }
  qa:        { default: claude-code }

members:
  - id: lead
    title: "Lead Architect"           # user-facing "team member" label
    role: lead                        # key into engines{} above
    instructions: instructions/lead.md
    orchestrator: true                # exactly one member must be the orchestrator (the "Lead")
    permissionPolicy: { mode: ask }
    allowedTools: [read, write, shell] # advisory; the engine's own policy still applies

  - id: developer
    title: "Developer"
    role: developer
    instructions: instructions/developer.md
    permissionPolicy: { mode: ask }

  - id: qa
    title: "QA Engineer"
    role: qa
    instructions: instructions/qa.md
    permissionPolicy: { mode: readonly }

# Optional: how the orchestrator should decompose work. Free-form guidance the Lead reads.
workflow: playbooks/ship-a-feature.md

# Optional: default run limits for sessions started from this pack
limits:
  maxTurns: 60
  maxUsd: 5
  maxWallclockMs: 3600000
```

### Instruction files

`instructions/<member>.md` is plain markdown — the member's system prompt. It should
describe the member's responsibilities, boundaries, and how to hand work off. It must
**not** contain engine-specific syntax; it is delivered verbatim as the member's
instructions regardless of which engine backs it.

Template variables available in instruction files (resolved by `core`):
`{{team.name}}`, `{{member.title}}`, `{{objective}}`, `{{workspace}}`,
`{{members}}` (roster list). No other interpolation.

---

## 4. Discovery & precedence

The pack loader resolves a pack `id` by searching, **highest precedence first**:

1. `./.daycrew/team-packs/<id>/` — project-local
2. `~/.daycrew/team-packs/<id>/` — user-installed (`daycrew team add <source>`)
3. npm: a dependency named `daycrew-team-pack-<id>` or `@daycrew-packs/<id>`
4. `<daycrew>/team-packs/<id>/` — first-party, bundled

`daycrew team list` shows all discovered packs and where each resolved from.
`daycrew team show <id>` prints the resolved manifest + roster.

---

## 5. Engine binding (vendor-neutral)

A pack never hard-codes a vendor as mandatory. It may express a **preference**
(`engines.<role>.default`), but the user's `daycrew.json` `providers` block always
wins, and any member can be pointed at any installed engine:

```jsonc
// .daycrew/daycrew.json
{
  "team": "software-development",
  "providers": {
    "lead":      { "provider": "claude-code" },
    "developer": { "provider": "codex" },
    "qa":        { "provider": "claude-code" }
  }
}
```

If a role has no binding and no default, `core` falls back to the project
`defaultProvider`. A pack that only works with one specific engine must say so in its
`README.md` and `description`, but the format does not enforce it.

---

## 6. Category vocabulary (first-party packs)

`software-development`, `ecommerce`, `job-search`, `academic-research`, `marketing`,
`cybersecurity`. Community packs pick the closest `categories:` value or propose a
new one via PR. First-party packs live in `<daycrew>/team-packs/`; each is the
reference implementation for its category.

---

## 7. Submitting a community pack

1. Create the pack directory following §1.
2. `daycrew team validate ./path-to-pack` must pass (manifest + team schema +
   instruction files resolve + exactly one orchestrator).
3. Open a PR adding it under `team-packs/community/<id>/`, or publish it to npm as
   `daycrew-team-pack-<id>` and open a PR adding it to `docs/community-packs.md`.
4. PR checklist: no changes under `packages/`, `README.md` present, license stated.

The acceptance test for this whole extension point: **a contributor can ship a
working pack with zero changes to `packages/`.**
