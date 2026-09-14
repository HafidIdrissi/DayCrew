# Changelog

All notable changes to DayCrew will be documented here.

## [0.1.0-alpha] — Unreleased

### Added

- Local-first Workspaces with safe selection and isolation.
- Manager-led Teams, Members, Tasks, dependencies, and handoffs.
- Permanent and Task-scoped Skills with capability checks.
- Needs You approvals, decisions, blockers, failures, and reviews.
- Home, Team, Tasks, and early Office product views.
- Claude Code actionable adapter, Codex read-only preview, and restricted Gemini/Antigravity research adapter.
- Bundled Software Development Team Pack and twelve curated Skills.
- First-run onboarding, production-usable Settings, and a backend-driven Office view.
- Clearly isolated deterministic Demo Mode with approval and same-session resume.
- Per-Member model selection in the agent form, validated on the server and passed to the CLI through its own --model option.
- An extensible AI Engine registry shared by every screen, with per-engine install and sign-in guidance in Settings.
- Cursor CLI as a read-only preview engine, reusing `cursor-agent login` rather than any DayCrew-held credential.
- Grok Build as a read-only preview with live signed-out detection, dynamic model discovery, headless streaming, session continuation and explicit preview consent.

### Security

- Risky actions remain subject to autonomy policy and hard safety boundaries.
- Skills never grant Tools, credentials, provider capabilities, or permissions.
- Workspace paths, raw provider protocols, and internal errors are hidden from normal UI responses.
- Engine authentication stays inside each CLI. DayCrew never asks for, stores, or transmits a provider API key.
- Stored model identifiers are format-validated so they cannot carry an argument into a CLI engine.
- Readiness reports installed, signed-in and ready separately; an inconclusive check reads as unknown, never as missing.

### Fixed

- Cursor CLI could not start on Windows: its `.cmd` shim cannot be spawned by Node (`EINVAL`). DayCrew now runs the bundled node entry point the shim targets.
- Antigravity chat replies leaked DayCrew's internal result envelope into the message text.
- A reply stopped cleanly kept no notice explaining why it ended.
- A chat reply now records the model the engine confirmed it ran, beside the model that was requested.
- Stopping a chat reply twice, or stopping one that had already settled, failed the request and rejected inside the local service's shutdown hook. Stop is now idempotent.
- A Stop that landed while Antigravity was still accepting a turn left the provider working on an abandoned run, because there was no conversation id to cancel yet.
- A signed-in engine that refuses every turn over its own usage limit now says so in the reply, instead of only "check Settings".

### Known limitations

See [docs/KNOWN_LIMITATIONS.md](./docs/KNOWN_LIMITATIONS.md), and
[docs/ENGINE-VALIDATION.md](./docs/ENGINE-VALIDATION.md) for what each engine was
actually observed to do, to only do in a mock, or to be blocked from doing.
