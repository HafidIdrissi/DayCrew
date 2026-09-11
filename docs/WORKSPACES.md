# Local Workspaces

DayCrew is a local-first web application: React → local Fastify API → DayCrew
Core → a user-selected filesystem directory → optional AI providers. The DayCrew
installation contains application code and bundled Team Packs. It is never the
default user Workspace. A future public marketing/documentation site is separate.

## Open or create a Workspace

Run `pnpm build`, then `pnpm dev` and open the local Vite address. The welcome
screen offers **Create a Workspace** and **Open an existing Workspace**.
Enter the full absolute path to an existing folder on this computer. Create
initializes DayCrew in that folder; it does not create missing parent directories
or overwrite an existing `workspace.json`. Use the OS file manager to create a
new project folder first. The browser never accesses the filesystem directly.

The workspace switcher opens the picker, including recent locations. A ready
Workspace can create a Team with a Manager or install the bundled Software
Development Team Pack. The accepted Team page reads that Workspace's Manager,
Members, Tasks, Knowledge, Activity and Needs You, and can submit a goal to the
existing deterministic MVP engine.

## Selection and configuration

Server resolution order:

1. Explicit `buildServer({ workspaceRoot })` or `DAYCREW_WORKSPACE_ROOT` (absolute).
2. The previously selected directory from local app configuration.
3. Upward `.daycrew` discovery **only** when `discoverWorkspace: true` is passed,
   with an explicit `cwd`/discovery start.
4. Otherwise, no Workspace is selected.

An unavailable configured directory produces a recoverable product error; it
never falls back to the installation or another directory. Package manifests
and the server/web process's working directory are not Workspace markers.
Successful opens, creates and valid explicit startup selections are remembered.

The versioned app config contains only the selected directory and up to ten
recent Workspace names, roots and timestamps:

| OS | App configuration |
| --- | --- |
| Windows | `%LOCALAPPDATA%\DayCrew\app.json` |
| macOS | `~/Library/Application Support/DayCrew/app.json` |
| Linux | `$XDG_CONFIG_HOME/daycrew/app.json`, or `~/.config/daycrew/app.json` |

An absolute `DAYCREW_APP_CONFIG_DIR` overrides the directory for portable or
isolated development/test instances. Tests inject their own temporary config
directories and never read or change the user's app config. Config writes use
atomic replacement; invalid configuration is reported instead of overwritten.

CLI commands intentionally discover the nearest existing `.daycrew` from their
working directory. `--path <directory>` overrides discovery (relative CLI paths
are resolved at invocation). `workspace create` explicitly initializes its
`--path`, or the CLI's current folder if omitted. CLI commands do not change the
web app's remembered selection.

## Workspace state

All durable runtime state remains under the selected root:

```text
<WorkspaceRoot>/
  <the user's source files>
  .daycrew/
    workspace.json
    teams/<team-id>.json
    knowledge/<team-id>.json
    memory/<team-id>/<member-id>.json
    sessions/<session-id>/{session,tasks,messages}.json
    state/
    needs-you.json
    approvals.json
    activity.jsonl
```

The existing Skills preview still uses browser-local storage; its keys are now
namespaced by an opaque Workspace key plus Team id to avoid crossing Workspaces.
This task adds no Skills backend.

## HTTP contract

| API | Purpose |
| --- | --- |
| `GET /api/app` | Selection/initialization status, name, id, opaque Workspace key and selection token; safe issue when unavailable |
| `GET /api/app/workspaces` | Current path and recent paths, only for the dedicated picker |
| `POST /api/app/workspace/open` | Validate and select an existing Workspace; body `{ root }` |
| `POST /api/app/workspace/create` | Initialize and select an existing folder; body `{ root, name }` |
| `GET/PATCH /api/workspace` | Current Workspace metadata / rename; no filesystem path in the response |
| `POST /api/workspace` | Compatibility initialization using `{ name, root? }`; omitted root uses the explicit/current selection |
| `GET /api/teams/dashboard?teamId=...` | Aggregate dashboard from one immutable Workspace context |
| Existing Team/work/task/knowledge/memory/approval/activity routes | All resolve through the request's selected Workspace context |

Normal UI components receive no root paths or raw filesystem exceptions. Errors
use `{ error: { code, message } }`, including `WORKSPACE_NOT_SELECTED`,
`WORKSPACE_NOT_INITIALIZED`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_STATE_INVALID`,
`WORKSPACE_PERMISSION_DENIED`, `WORKSPACE_PATH_INVALID` and `WORKSPACE_CHANGED`.
Missing state files never expose raw ENOENT text. Technical causes remain local.

## Isolation and local security

Every state request captures a canonical root and selection token before any
service reads it. Browser state requests send `X-DayCrew-Workspace`. Stale tokens
are rejected, and responses completing after a switch are replaced with
`WORKSPACE_CHANGED`. The dashboard is aggregated on the backend to prevent
mixing several HTTP responses. React remounts on selection changes, drops old
loads, and checks selection on focus and every three seconds.

An already-running operation remains confined to its original root when the
selection changes; switching does not redirect, approve, cancel or escalate it.
Existing approval handles remain scoped to their root and retain their permission
controls. Reopening reconciles stranded approvals using the existing core service.

Paths are canonicalized with realpath; roots must exist, be directories and pass
read/write/search access checks. Each state filename component rejects traversal,
separators, Windows alternate streams/device names, and control characters.
Symlinks and Windows junctions anywhere inside `.daycrew` are rejected; a
user-selected root alias is canonicalized. A stored legacy `rootPath` is never
routing authority, so moved/copied Workspaces can be opened at their new path.

The API binds to loopback. Host/origin checks reject remote browser requests and
DNS rebinding; no generic file-read API is exposed. Vite port 5173 is allowed by
default. Programmatic server instances can specify exact `allowedOrigins` for a
different local UI port. No accounts, cloud backend, hosted database or mandatory
network access are used for Workspace state.

Unix file modes restrict new app config to the local user. Windows uses inherited
user-profile ACLs; Node access checks are supplemented by actual filesystem
operations and typed permission errors. Filesystem paths must use the host OS's
syntax. These checks do not defend against a privileged local process racing to
replace filesystem entries, and network/synced folders may have different atomic
rename/locking behavior. Windows is manually verified; native macOS/Linux UI and
ACL behavior require verification on those operating systems.
