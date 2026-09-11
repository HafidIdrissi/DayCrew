import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { ApiError, createTeam, createWorkspace, getApp, getWorkspacePicker, installStarterTeam, listTeams, openWorkspace } from "./api";
import { AppSidebar, ErrorTeamPage, Icon, LoadingTeamPage } from "./components";
import { TeamPage } from "./TeamPage";
import type { AppState, Team, WorkspacePickerData } from "./types";

const StateFrame = ({ children }: { children: ReactNode }) =>
  <div className="app-frame"><AppSidebar needsCount={0} /><main className="app-main state-main">{children}</main></div>;

const WorkspacePicker = ({ app, onSelected, onCancel }: {
  app: AppState; onSelected: (next: AppState) => void; onCancel: () => void;
}) => {
  const [mode, setMode] = useState<"create" | "open">();
  const [root, setRoot] = useState("");
  const [name, setName] = useState("My Workspace");
  const [picker, setPicker] = useState<WorkspacePickerData>({ recentWorkspaces: [] });
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void getWorkspacePicker().then((next) => {
      if (!active) return;
      setPicker(next);
      if (!app.workspace.initialized && next.selectedRoot) setRoot(next.selectedRoot);
    }).catch((caught: ApiError) => { if (active) setError(caught); });
    return () => { active = false; };
  }, [app.workspace.initialized]);
  const select = async (candidate: string, initialize = false) => {
    setBusy(true); setError(undefined);
    try {
      const next = initialize ? await createWorkspace(candidate, name) : await openWorkspace(candidate);
      window.location.hash = "teams";
      onSelected(next);
    } catch (caught) {
      setError(caught as ApiError);
    } finally { setBusy(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void select(root.trim(), mode === "create"); };
  const chooseMode = (next: "create" | "open") => { setMode(next); setError(undefined); };
  const issue = error ?? app.issue;
  return <StateFrame><section className="state-page onboarding-state workspace-picker">
    <span className="state-icon"><Icon name="logo" size={36} /></span>
    <h1>{app.workspace.initialized ? "Choose a Workspace" : "Welcome to DayCrew"}</h1>
    <p>Choose where your team will work.</p>
    {issue && issue.code !== "WORKSPACE_NOT_SELECTED" && <p role="alert" className="workspace-notice">{issue.message}</p>}
    <div className="state-action-row">
      <button className={mode === "create" ? "primary-button" : "secondary-button"} disabled={busy} onClick={() => chooseMode("create")}>Create a Workspace</button>
      <button className={mode === "open" ? "primary-button" : "secondary-button"} disabled={busy} onClick={() => chooseMode("open")}>Open an existing Workspace</button>
    </div>
    {(mode || issue?.code === "WORKSPACE_NOT_INITIALIZED") && <form className="workspace-create-form path-form" onSubmit={submit}>
      <label><span>Folder path</span><input autoFocus name="workspaceRoot" value={root} onChange={(event) => setRoot(event.target.value)} disabled={busy} required placeholder="Full path to an existing folder" autoComplete="off" spellCheck={false} /></label>
      <small>Your project stays here. DayCrew stores its local state in this folder's .daycrew directory.</small>
      {mode === "create" && <label><span>Workspace name</span><input name="workspaceName" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} required /></label>}
      {issue?.code === "WORKSPACE_NOT_INITIALIZED" && mode !== "create"
        ? <button className="primary-button" type="button" onClick={() => chooseMode("create")}>Initialize DayCrew here</button>
        : <button className="primary-button" type="submit" disabled={busy || !root.trim()}>{busy ? "Opening Workspace..." : mode === "create" ? "Create Workspace" : "Open Workspace"}</button>}
    </form>}
    {!mode && picker.recentWorkspaces.length > 0 && <div className="recent-workspaces"><h2>Recent Workspaces</h2>
      {picker.recentWorkspaces.map((item) => <button className="recent-workspace" key={item.root} disabled={busy} onClick={() => { setRoot(item.root); setMode("open"); void select(item.root); }}><strong>{item.name}</strong><small>{item.root}</small></button>)}
    </div>}
    {app.workspace.initialized && <button className="secondary-button picker-cancel" disabled={busy} onClick={onCancel}>Back to Workspace</button>}
  </section></StateFrame>;
};

const TeamsPage = ({ app, onSwitch, onWorkspaceIssue }: {
  app: AppState; onSwitch: () => void; onWorkspaceIssue: () => void;
}) => {
  const [teams, setTeams] = useState<Team[]>();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selectionId = app.workspace.selectionId;
  useEffect(() => {
    let active = true;
    void listTeams(selectionId).then((next) => { if (active) setTeams(next); }).catch((caught: ApiError) => {
      if (!active) return;
      if (caught.code?.startsWith("WORKSPACE_")) onWorkspaceIssue();
      else setError(caught.message);
    });
    return () => { active = false; };
  }, [selectionId, onWorkspaceIssue]);
  const create = async (name?: string) => {
    setBusy(true); setError(undefined);
    try {
      const team = name ? await createTeam(name, selectionId) : await installStarterTeam(selectionId);
      window.location.hash = "teams/" + team.id;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code?.startsWith("WORKSPACE_")) onWorkspaceIssue();
      else setError((caught as Error).message);
    } finally { setBusy(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("teamName") ?? "").trim();
    if (name) void create(name);
  };
  return <StateFrame><section className="state-page teams-page">
    <button className="secondary-button" onClick={onSwitch}>{app.workspace.name} <Icon name="chevron" size={16} /></button>
    <span className="state-icon"><Icon name="team" size={30} /></span>
    <h1>{teams?.length === 0 ? "Your Workspace is ready." : "Your Teams"}</h1>
    <p>{teams?.length === 0 ? "Create your first AI Team." : "Choose a team to coordinate its work."}</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {teams === undefined && !error && <p>Loading Teams...</p>}
    {teams && teams.length > 0 && <div className="team-list">{teams.map((team) => <a className="recent-workspace" key={team.id} href={"#teams/" + team.id}><strong>{team.name}</strong><small>{team.members.length} {team.members.length === 1 ? "member" : "members"} · {team.description || "Ready for your next goal"}</small><Icon name="arrow" size={16} /></a>)}</div>}
    {teams && !creating && <button className="primary-button" onClick={() => setCreating(true)}>Create Team</button>}
    {creating && <form className="workspace-create-form path-form" onSubmit={submit}>
      <label><span>Team name</span><input autoFocus name="teamName" disabled={busy} required placeholder="e.g. Product Team" /></label>
      <small>Your team starts with a Manager ready to receive a goal.</small>
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Creating..." : "Create Team"}</button>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void create()}>Use Software Development Team Pack</button>
    </form>}
  </section></StateFrame>;
};

export const App = () => {
  const [app, setApp] = useState<AppState>();
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [hash, setHash] = useState(window.location.hash);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await getApp();
      if (request !== generation.current) return;
      setApp(next); setError(undefined);
    } catch (caught) {
      if (request !== generation.current) return;
      setApp(undefined); setError((caught as Error).message);
    }
  }, []);
  const recover = useCallback(() => { setApp(undefined); void refresh(); }, [refresh]);
  useEffect(() => {
    void refresh();
    const onHash = () => setHash(window.location.hash);
    const onFocus = () => { void refresh(); };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3_000);
    return () => { ++generation.current; clearInterval(timer); window.removeEventListener("hashchange", onHash); window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  const selected = (next: AppState) => { ++generation.current; setApp(next); setChoosing(false); setError(undefined); };
  if (error) return <StateFrame><ErrorTeamPage message={error} onRetry={() => void refresh()} /></StateFrame>;
  if (!app) return <StateFrame><LoadingTeamPage /></StateFrame>;
  if (choosing || !app.workspace.initialized) return <WorkspacePicker app={app} onSelected={selected} onCancel={() => setChoosing(false)} />;
  if (!hash.startsWith("#teams/")) return <TeamsPage key={app.workspace.selectionId} app={app} onSwitch={() => setChoosing(true)} onWorkspaceIssue={recover} />;
  return <TeamPage key={app.workspace.selectionId + hash} selectionId={app.workspace.selectionId} workspaceKey={app.workspace.key!} onSwitchWorkspace={() => setChoosing(true)} onWorkspaceIssue={recover} />;
};
