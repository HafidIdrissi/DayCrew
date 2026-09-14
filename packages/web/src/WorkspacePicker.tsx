import { useEffect, useRef, useState, type FormEvent } from "react";

import { createWorkspace, getWorkspacePicker, openWorkspace, type ApiError } from "./api";
import { Icon, StateFrame } from "./components";
import type { AppState, WorkspacePickerData } from "./types";

export type PickerMode = "create" | "open";

/**
 * The remembered-Workspace problem is only worth a banner while it is still the
 * user's situation. Once they start creating or opening one, it is stale: leaving it
 * up next to fresh onboarding reads as if nothing happened.
 */
export const workspaceNotice = (app: AppState, engaged: boolean): string | undefined => {
  if (engaged || !app.issue) return undefined;
  // Nothing was ever selected: that is plain first-run onboarding, not a problem.
  if (app.issue.code === "WORKSPACE_NOT_SELECTED") return undefined;
  return app.issue.code === "WORKSPACE_NOT_FOUND"
    ? "DayCrew can no longer find your previous Workspace."
    : app.issue.message;
};

/** A failed attempt explains this folder, not the Workspace the user came from. */
export const attemptMessage = (error: ApiError, mode: PickerMode): string => {
  if (error.code === "WORKSPACE_PERMISSION_DENIED") return "DayCrew does not have permission to use this folder.";
  if (error.code === "WORKSPACE_PATH_INVALID" && mode === "create") {
    return "This is not a usable folder path. Enter a full path, for example C:\\Users\\your-name\\Documents\\MyProject on Windows or /home/your-name/MyProject on Linux.";
  }
  if (error.code === "WORKSPACE_NOT_FOUND" && mode === "open") return "DayCrew cannot find this folder.";
  return error.message;
};

export const WorkspacePicker = ({ app, onSelected, onCancel }: {
  app: AppState; onSelected: (next: AppState) => void; onCancel: () => void;
}) => {
  const [mode, setMode] = useState<PickerMode>();
  const [root, setRoot] = useState("");
  const [name, setName] = useState("My Workspace");
  const [picker, setPicker] = useState<WorkspacePickerData>({ recentWorkspaces: [] });
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const initialized = app.workspace.initialized;
  const issueCode = app.issue?.code;
  useEffect(() => {
    let active = true;
    void getWorkspacePicker().then((next) => {
      if (!active) return;
      setPicker(next);
      // Never pre-fill a path DayCrew has just reported as missing or unusable.
      if (next.selectedRoot && (initialized || issueCode === "WORKSPACE_NOT_INITIALIZED")) setRoot(next.selectedRoot);
    }).catch((caught: ApiError) => { if (active) setError(caught); });
    return () => { active = false; };
  }, [initialized, issueCode]);

  const select = async (candidate: string, initialize: boolean) => {
    // A second click must never reach the API: the first is still creating this folder.
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(undefined);
    try {
      const next = initialize ? await createWorkspace(candidate, name.trim()) : await openWorkspace(candidate);
      // The response is the source of truth; App discards /api/app polls issued before it.
      window.location.hash = "teams";
      onSelected(next);
    } catch (caught) {
      setError(caught as ApiError);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void select(root.trim(), mode === "create");
  };
  const chooseMode = (next: PickerMode) => { setMode(next); setError(undefined); };

  const creating = mode === "create";
  const engaged = mode !== undefined || busy || error !== undefined;
  const notice = workspaceNotice(app, engaged);
  const uninitialized = (error?.code ?? issueCode) === "WORKSPACE_NOT_INITIALIZED";
  const formOpen = mode !== undefined || issueCode === "WORKSPACE_NOT_INITIALIZED";
  return <StateFrame><section className="state-page onboarding-state workspace-picker">
    {!initialized && <ol className="workspace-steps" aria-label="Getting started"><li aria-current="step"><b>1</b>Workspace</li><li><b>2</b>Team</li><li><b>3</b>First goal</li></ol>}
    <span className="state-icon"><Icon name="logo" size={36} /></span>
    <h1>{initialized ? "Choose a Workspace" : "Welcome to DayCrew"}</h1>
    <p>{initialized ? "Choose where your team will work." : "Create or open a Workspace to get started."}</p>
    {notice && <p role="alert" className="workspace-notice">{notice}</p>}
    <div className="state-action-row">
      <button className={creating ? "primary-button" : "secondary-button"} disabled={busy} onClick={() => chooseMode("create")}>Create a Workspace</button>
      <button className={mode === "open" ? "primary-button" : "secondary-button"} disabled={busy} onClick={() => chooseMode("open")}>Open an existing Workspace</button>
    </div>
    {formOpen && <form className="workspace-create-form path-form" onSubmit={submit}>
      <label><span>Folder path</span><input autoFocus name="workspaceRoot" value={root} onChange={(event) => { setRoot(event.target.value); setError(undefined); }} aria-invalid={error?.code === "WORKSPACE_PATH_INVALID" || undefined} aria-describedby={error ? "workspace-path-help workspace-error" : "workspace-path-help"} disabled={busy} required placeholder={creating ? "Full path to the folder for this Workspace" : "Full path to an existing folder"} autoComplete="off" spellCheck={false} /></label>
      <small id="workspace-path-help">Use a full folder path, not just a name. Windows: <code>{"C:\\Users\\your-name\\Documents\\MyProject"}</code>. macOS: <code>/Users/your-name/MyProject</code>. Linux: <code>/home/your-name/MyProject</code>.</small>
      <small>{creating
        ? "DayCrew creates this folder if it does not exist yet, and stores its local state in this folder's .daycrew directory."
        : "Your project stays here. DayCrew stores its local state in this folder's .daycrew directory."}</small>
      {creating && <label><span>Workspace name</span><input name="workspaceName" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} required /></label>}
      {error && <p id="workspace-error" role="alert" className="inline-error">{attemptMessage(error, mode ?? "open")}</p>}
      {uninitialized && !creating
        ? <button className="primary-button" type="button" onClick={() => chooseMode("create")}>Initialize DayCrew here</button>
        : <button className="primary-button" type="submit" disabled={busy || !root.trim() || (creating && !name.trim())}>
          {busy ? (creating ? "Creating Workspace…" : "Opening Workspace…") : creating ? "Create Workspace" : "Open Workspace"}
        </button>}
    </form>}
    {!mode && picker.recentWorkspaces.length > 0 && <div className="recent-workspaces"><h2>Recent Workspaces</h2>
      {picker.recentWorkspaces.map((item) => <button className="recent-workspace" key={item.root} disabled={busy} onClick={() => { setRoot(item.root); setMode("open"); void select(item.root, false); }}><strong>{item.name}</strong><small>{item.root}</small></button>)}
    </div>}
    {initialized && <button className="secondary-button picker-cancel" disabled={busy} onClick={onCancel}>Back to Workspace</button>}
  </section></StateFrame>;
};
