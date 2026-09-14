# DayCrew Skills

## Five-minute Skill quickstart

1. Create `.daycrew/skills/my-skill/` in a disposable Workspace.
2. Add `skill.json` using the schema below and `instructions.md` with focused, non-executable guidance.
3. Run `pnpm skill:validate -- <path-to-my-skill>`.
4. Open the Team's Skills Library and verify compatibility before attaching it.
5. Add schema/behavior tests when the contribution changes loading, conflicts, or capability handling.

You only need the Skill format. You do not need to modify or understand the orchestrator.

A Skill is a reusable set of instructions and workflow guidance. It describes what a Team Member knows how to do. It is separate from the Member's Role, available Tools, and selected AI Engine.

Skills never grant filesystem, shell, network, browser, MCP, credential, publishing, spending, or provider access. A Skill may declare what it needs, but the provider and DayCrew policy remain responsible for access, approvals, autonomy, Needs You, and hard safety boundaries.

## Workspace-local format

Create one directory per Skill under the Workspace:

```text
.daycrew/
  skills/
    accessibility-review/
      skill.json
      instructions.md
```

The directory name and `id` must match. DayCrew reads only `skill.json` and `instructions.md` from that directory. `instructionsFile` can only be `instructions.md`; absolute paths, parent paths, symlinks, junctions, device names, and files outside the Skill directory are rejected.

Example `skill.json`:

```json
{
  "id": "accessibility-review",
  "name": "Accessibility Review",
  "description": "Review an interface for keyboard, semantic, focus, and contrast problems.",
  "version": "1.0.0",
  "author": "Your name",
  "instructionsFile": "instructions.md",
  "tags": ["software", "accessibility", "quality"],
  "requiredCapabilities": ["browser"],
  "recommendedTools": ["browser"],
  "compatibleRoles": ["Quality assurance", "Developer"]
}
```

Optional fields are `author`, `createdAt`, `conflictsWith`, and `source`. The loader sets `source` to the actual Workspace location, so a manifest cannot disguise its origin. Versions use semantic versioning. IDs, tags, capability names, and tool suggestions use stable lowercase identifiers. A Skill can contain at most 6,000 instruction characters and 12 items in each metadata list.

Write focused Markdown in `instructions.md`. State the workflow, quality bar, useful checks, and expected output. Do not include JavaScript, shell scripts, binaries, credentials, or instructions that claim to change permissions. Commands mentioned as guidance do not become executable permissions.

## Capabilities and compatibility

`requiredCapabilities` describes prerequisites such as `filesystem.read`, `command.run`, or `browser`. `recommendedTools` helps a human choose and configure Tools; it has no authorization effect.

DayCrew compares requirements with capabilities reported by the selected AI Engine. Missing requirements are shown in the Skills drawer with a resolution. An incompatible Skill is excluded from the effective instruction context. Changing a provider or policy does not change the Skill and adding a Skill does not change the provider or policy.

## Permanent and temporary Skills

Permanent Skill IDs are stored on the Team Member in `.daycrew/teams/<team-id>.json`. They apply to future Work Sessions for that Team.

Temporary Skill IDs are stored per Member on the Task in `.daycrew/sessions/<session-id>/tasks.json`. They apply only while building that Member's context for that Task. Completing the Task does not copy them to the Team. Promotion requires the human to choose **Keep for this Team**.

The effective context is deterministic: base Role instructions, permanent Skills in assignment order, then task-scoped Skills in assignment order. Duplicate IDs are removed, with the task-scoped assignment taking precedence. Incompatible Skills are omitted and logged. Declared cross-scope conflicts prefer the explicit task Skill and are logged. A material same-scope conflict omits both instruction sets and is logged for human resolution. The final context has a fixed 32,000-character limit and never rewrites the base Role instructions.

## Local API

The Team UI uses the local Fastify API. It never edits Skill files directly.

| Method and path | Behavior |
| --- | --- |
| `GET /api/skills` | List bundled and Workspace-local Skills |
| `GET /api/teams/:teamId/members/:memberId/skills` | List permanent and temporary assignments with compatibility |
| `POST /api/teams/:teamId/members/:memberId/skills` | Add the body `skillId` permanently |
| `DELETE /api/teams/:teamId/members/:memberId/skills/:skillId` | Remove a permanent Skill |
| `POST /api/tasks/:taskId/members/:memberId/skills` | Add the body `skillId` temporarily; `sessionId` disambiguates repeated Task IDs |
| `DELETE /api/tasks/:taskId/members/:memberId/skills/:skillId` | Remove a temporary Skill; `sessionId` is the query parameter |
| `GET /api/teams/:teamId/members/:memberId/skill-recommendations` | Return role- and Task-based suggestions without changing assignments; optional `taskId` and `sessionId` query parameters add Task context |

The Team dashboard also includes the library, every Member's assignments, and compatibility results so the Manager can see the current state. Recommendation reads have no write side effect; **Add for this task** and **Keep for this Team** are separate human actions.

## Validate and test

From the repository root, validate a Skill directory with:

```sh
pnpm skill:validate -- .daycrew/skills/accessibility-review
```

The command prints the resolved provider-neutral Skill when validation succeeds and exits nonzero for schema or path errors. To test behavior, create a temporary Workspace, add the directory, open its Skills Library, attach the Skill to a disposable Member or Task, and confirm its compatibility and scope labels. Use a mock provider for automated tests. A live provider proof is optional and must retain normal DayCrew approval boundaries.

## Future community submission

DayCrew currently discovers bundled and Workspace-local Skills. There is no marketplace. The `source` object and loader boundary allow future community or npm sources to produce the same validated Skill object without changing assignment, compatibility, injection, or security behavior.

Until a community review process is published, propose a Skill through a normal repository pull request. Include the two Skill files, a concise rationale, schema validation output, and behavioral tests when the Skill adds new conflict or capability behavior. Do not publish a package or add an installer as part of a Skill contribution.
