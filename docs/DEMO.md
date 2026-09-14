# Demo and screenshot guide

The demo is optional and isolated. Never add demo records to a real Workspace.

## Reproducible demo Workspace

1. Create a new temporary folder outside the DayCrew checkout.
2. Build DayCrew with `pnpm build`.
3. Create the isolated Demo Workspace and install its bundled Team Pack:

   ```bash
   node packages/cli/dist/bin.js demo create --path <temporary-folder>
   ```

4. Start DayCrew with this Workspace selected:

   ```bash
   # macOS / Linux
   DAYCREW_WORKSPACE_ROOT=<temporary-folder> pnpm dev

   # Windows PowerShell
   $env:DAYCREW_WORKSPACE_ROOT='<temporary-folder>'; pnpm dev
   ```

5. Open `http://127.0.0.1:5173/#home`, brief the Manager with the Goal `Create a hello endpoint and review the implementation.` from the Home composer (or from `#teams/software-development`), then use the real `#needs-you` screen to approve the simulated write. The same Work Session resumes, reaches Review, and completes. Every relevant product view displays the Demo Mode label.

Demo Mode stays isolated by construction: it is a Workspace of its own, in its own folder, with its own `.daycrew/` state. DayCrew never writes demo records into a Workspace you opened for real work, and the demo engine is only ever selected when a Member explicitly names it.

Capture real rendered routes at 1440px or 1920px:

- Home: `#home`
- Team conversations: `#teams/software-development`
- Team configuration and Skills Library: `#teams/software-development/overview`
- Tasks: `#tasks`
- Needs You: `#needs-you`
- Office (floor and list views): `#office`
- Skills: `#skills`
- Settings: `#settings`

Do not retouch state, replace labels, or present a mock run as a real provider result.

## 30–45 second demo outline

| Time | Action |
|---|---|
| 0–5s | Create or open the isolated Workspace |
| 5–10s | Install the Engineering Team |
| 10–15s | Add one clearly relevant Skill |
| 15–22s | Give the Manager the hello-endpoint goal |
| 22–30s | Show Tasks, ownership, and a handoff |
| 30–36s | Open the real Needs You approval and decide it |
| 36–45s | Show Review, completion, Home, and Office state |

The deterministic Demo provider exercises planning, delegation, handoffs, Needs You, approval, same-session resume, Review, and completion through persisted DayCrew backend state. Its provider action is simulated; use Claude Code in a disposable Workspace when demonstrating real file changes.
