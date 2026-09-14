import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { ApiError, createTeam, getApp, installStarterTeam, listTeams } from "./api";
import { ErrorTeamPage, Icon, LoadingTeamPage, StateFrame, TeamCard } from "./components";
import { TeamPage } from "./TeamPage";
import { ChatPage } from "./ChatPage";
import { HomePage } from "./HomePage";
import { TasksPage } from "./TasksPage";
import { OfficePage } from "./OfficePage";
import { NeedsYouPage } from "./NeedsYouPage";
import { SkillsPage } from "./SkillsPage";
import { OnboardingPage } from "./OnboardingPage";
import { SettingsPage } from "./SettingsPage";
import { WorkspacePicker } from "./WorkspacePicker";
import type { AppState, Team } from "./types";

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
    if (name && !busy) void create(name);
  };
  return <StateFrame activeView="Team"><section className="state-page teams-page">
    <button className="secondary-button" onClick={onSwitch}>{app.workspace.name} <Icon name="chevron" size={16} /></button>
    <span className="state-icon"><Icon name="team" size={30} /></span>
    <h1>{teams?.length === 0 ? "Your Workspace is ready." : "Your Teams"}</h1>
    <p>{teams?.length === 0 ? "Create your first AI Team." : "Choose a team to coordinate its work."}</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {teams === undefined && !error && <p>Loading Teams...</p>}
    {teams && teams.length > 0 && <div className="team-list">{teams.map((team) => <TeamCard team={team} key={team.id} />)}</div>}
    {teams && !creating && <div className="team-start-options">
      <article><Icon name="sparkle" size={24} /><h2>Start with a ready-made crew</h2><p>A Software Development team with a Manager and specialists. A quick way to try your first goal.</p><button className="primary-button" disabled={busy} onClick={() => void create()}>{busy ? "Creating..." : "Use developer team"}</button></article>
      <article><Icon name="team" size={24} /><h2>Build your own team</h2><p>Start with a Manager, then add agents with the roles and instructions your project needs.</p><button className="secondary-button" disabled={busy} onClick={() => setCreating(true)}>Create Team</button></article>
    </div>}
    {creating && <form className="workspace-create-form path-form" onSubmit={submit}>
      <label><span>Team name</span><input autoFocus name="teamName" disabled={busy} required placeholder="e.g. Product Team" /></label>
      <small>Your team starts with a Manager ready to receive a goal.</small>
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Creating..." : "Create Team"}</button>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => setCreating(false)}>Back to team options</button>
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
  if (hash === "#onboarding") return <OnboardingPage key={app.workspace.selectionId} selectionId={app.workspace.selectionId} />;
  if (hash === "" || hash === "#home") return <HomePage key={app.workspace.selectionId} selectionId={app.workspace.selectionId} onSwitchWorkspace={() => setChoosing(true)} onWorkspaceIssue={recover} />;
  // Needs You used to live under the Tasks route; the old link stays valid.
  if (hash === "#needs-you" || hash === "#tasks/needs-you") return <NeedsYouPage key={app.workspace.selectionId} selectionId={app.workspace.selectionId} onSwitchWorkspace={() => setChoosing(true)} onWorkspaceIssue={recover} />;
  if (hash === "#tasks" || hash.startsWith("#tasks/")) return <TasksPage key={app.workspace.selectionId} selectionId={app.workspace.selectionId} routeHash={hash} onSwitchWorkspace={() => setChoosing(true)} onWorkspaceIssue={recover} />;
  if (hash === "#office") return <OfficePage key={app.workspace.selectionId} selectionId={app.workspace.selectionId} onSwitchWorkspace={() => setChoosing(true)} onWorkspaceIssue={recover} />;
  if (hash === "#skills") return <SkillsPage key={app.workspace.selectionId} selectionId={app.workspace.selectionId} onSwitchWorkspace={() => setChoosing(true)} onWorkspaceIssue={recover} />;
  if (hash === "#settings") return <SettingsPage key={app.workspace.selectionId} selectionId={app.workspace.selectionId} onSwitchWorkspace={() => setChoosing(true)} onWorkspaceIssue={recover} />;
  if (!hash.startsWith("#teams/")) return <TeamsPage key={app.workspace.selectionId} app={app} onSwitch={() => setChoosing(true)} onWorkspaceIssue={recover} />;
  const chatTeam = hash.match(/^#teams\/([a-z0-9_-]+)$/)?.[1];
  if (chatTeam) return <ChatPage key={app.workspace.selectionId + chatTeam} teamId={chatTeam} selectionId={app.workspace.selectionId} onSwitchWorkspace={() => setChoosing(true)} onWorkspaceIssue={recover} />;
  return <TeamPage key={app.workspace.selectionId + hash} selectionId={app.workspace.selectionId} workspaceKey={app.workspace.key!} onSwitchWorkspace={() => setChoosing(true)} onWorkspaceIssue={recover} />;
};
