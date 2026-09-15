import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { ApiError, loadHome, providerErrorKind, startGoal } from "./api";
import { AppPage, Icon, LoadingTeamPage, MissionIssues, formatRelativeTime } from "./components";
import type { HomeData, MissionIssue } from "./types";

const statusLabel = (status: HomeData["teams"][number]["status"]): string => {
  if (status === "needs-you") return "Needs You";
  if (status === "working") return "Working";
  return "Ready";
};

const plural = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`;

/**
 * Home is where a day starts, so the Manager has to be reachable from here:
 * one goal, one Team, straight to the same endpoint the Team page uses.
 */
const ManagerBrief = ({ teams, selectionId, onStarted }: {
  teams: HomeData["teams"];
  selectionId: string;
  onStarted: () => Promise<void>;
}) => {
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const team = teams.find((item) => item.id === teamId) ?? teams[0];
  if (!team) return null;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = goal.trim();
    if (!value || busy) return;
    setBusy(true); setError(undefined);
    try {
      await startGoal(team.id, value, selectionId);
      setGoal("");
      await onStarted();
      window.location.hash = "tasks";
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The Manager could not start this Goal.";
      const kind = providerErrorKind(message);
      setError(kind === "restricted" ? `Provider restricted: ${message}` : kind === "unavailable" ? `Provider unavailable: ${message}` : message);
    } finally { setBusy(false); }
  };
  return <section className="home-card manager-brief card-surface">
    <div className="home-section-heading">
      <div><span className="home-heading-icon tone-blue"><Icon name="message" size={18} /></span><h2>Brief a Manager</h2></div>
      <a href={`#teams/${team.id}`}>Open conversation <Icon name="arrow" size={14} /></a>
    </div>
    <p className="manager-brief-lead">Describe the outcome you want. {team.manager.name} plans the Tasks, delegates them, and raises only what needs you.</p>
    {team.demoMode && <p className="demo-mode-banner"><strong>Demo Mode</strong> This Team runs the deterministic demo provider. Replies and actions are simulated.</p>}
    <form className="manager-brief-form" onSubmit={(event) => void submit(event)}>
      {teams.length > 1 && <label className="manager-brief-team"><span>Team</span><select value={team.id} onChange={(event) => setTeamId(event.target.value)} disabled={busy}>{teams.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
      <label className="sr-only" htmlFor="home-goal">Goal for {team.manager.name}</label>
      <textarea id="home-goal" value={goal} onChange={(event) => setGoal(event.target.value)} disabled={busy} maxLength={8_000} rows={2}
        placeholder={`Give ${team.manager.name} a goal, e.g. "Add a health endpoint and review the implementation."`}
        onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit(); }} />
      <div className="manager-brief-footer">
        <small>Ctrl / Cmd + Enter to send · Work appears on the Task board</small>
        <button className="primary-button" type="submit" disabled={busy || !goal.trim()}>{busy ? "Starting work…" : "Send goal"}</button>
      </div>
    </form>
    {error && <p className="inline-error" role="alert"><Icon name="warning" size={15} />{error}</p>}
  </section>;
};

export const HomePage = ({ selectionId, onSwitchWorkspace, onWorkspaceIssue }: {
  selectionId: string; onSwitchWorkspace: () => void; onWorkspaceIssue: () => void;
}) => {
  const [data, setData] = useState<HomeData>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const refresh = useCallback(async (quiet = false) => {
    const request = ++generation.current;
    if (!quiet) setError(undefined);
    try {
      const next = await loadHome(selectionId);
      if (request === generation.current) setData(next);
    } catch (caught) {
      if (request !== generation.current) return;
      if (caught instanceof ApiError && caught.code?.startsWith("WORKSPACE_")) onWorkspaceIssue();
      else setError(caught instanceof Error ? caught.message : "DayCrew could not load Home.");
    }
  }, [selectionId, onWorkspaceIssue]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, 6_000);
    return () => { ++generation.current; window.clearInterval(timer); };
  }, [refresh]);

  if (!data && !error) return <AppPage view="Home" needsCount={0}><div className="state-main"><LoadingTeamPage /></div></AppPage>;
  if (!data) return <AppPage view="Home" needsCount={0}><div className="state-main"><section className="state-page error-state"><span className="state-icon"><Icon name="warning" size={30} /></span><h1>DayCrew needs a moment</h1><p>{error}</p><button className="primary-button" onClick={() => void refresh()}>Try again</button></section></div></AppPage>;

  const hasActiveWork = data.teams.some((team) => team.currentObjective !== undefined);
  const retryMission = async (issue: MissionIssue) => {
    await startGoal(issue.teamId, issue.goal, selectionId);
    await refresh(true);
  };
  return <AppPage view="Home" needsCount={data.needsYou.count} workspace={data.workspace} onSwitchWorkspace={onSwitchWorkspace}>
      <div className="home-content">
        <header className="home-welcome"><p>MISSION CONTROL</p><h1>Give a goal. Your crew takes it from here.</h1><span>Your agent team plans, executes, and asks only for decisions that need you.</span></header>

        <MissionIssues issues={data.missionIssues} onRetry={retryMission} />

        {data.teams.length === 0 ? <section className="home-empty card-surface"><span className="home-empty-icon"><Icon name="team" size={25} /></span><div><h2>Your Workspace is ready.</h2><p>Create your first AI Team.</p></div><a className="primary-button" href="#teams">Create Team</a></section> : <>
          <ManagerBrief teams={data.teams} selectionId={selectionId} onStarted={() => refresh(true)} />
          <div className="home-priority-grid">
            <section className="home-card needs-you-card card-surface" id="home-needs-you">
              <div className="home-section-heading"><div><span className="home-heading-icon tone-amber"><Icon name="warning" size={18} /></span><h2>Needs You</h2></div><b>{data.needsYou.count}</b></div>
              {data.needsYou.highlights.length === 0 ? <div className="home-card-empty"><Icon name="check" size={21} /><div><strong>You’re all caught up.</strong><p>Nothing needs your attention right now.</p></div></div> : <div className="needs-home-list">{data.needsYou.highlights.map((item) => <article key={item.id}><div><span>{item.teamName} · {item.kind}</span><h3>{item.title}</h3><p>{item.detail}</p></div><a href={`#teams/${item.teamId}`}>Review <Icon name="arrow" size={14} /></a></article>)}</div>}
              {data.needsYou.count > data.needsYou.highlights.length && <a className="home-text-link" href="#needs-you">View all Needs You items <Icon name="arrow" size={14} /></a>}
            </section>

            <section className="home-card daily-brief card-surface">
              <div className="home-section-heading"><div><span className="home-heading-icon tone-blue"><Icon name="book" size={18} /></span><h2>Today’s Brief</h2></div></div>
              <div className="brief-list">{data.dailyBrief.teams.map((team) => <article key={team.teamId}><strong>{team.teamName}</strong><p>{team.completedTasks > 0 ? plural(team.completedTasks, "task") + " completed" : "No tasks completed"}</p>{team.reviewTasks > 0 && <p>{plural(team.reviewTasks, "task")} in review</p>}{team.activeTasks > 0 && <p>{plural(team.activeTasks, "active task")}</p>}</article>)}<article className="brief-needs"><strong>Needs You</strong><p>{data.dailyBrief.needsYou === 0 ? "All caught up" : plural(data.dailyBrief.needsYou, "decision")}</p></article></div>
            </section>
          </div>


          <section className="home-section teams-home-section">
            <div className="home-section-heading"><div><span className="home-heading-icon tone-blue"><Icon name="team" size={18} /></span><h2>Your Teams</h2></div><a href="#teams">View Teams <Icon name="arrow" size={14} /></a></div>
            {!hasActiveWork && <div className="home-inline-empty"><strong>Your teams are ready.</strong><span>Give a Manager a goal to begin.</span></div>}
            <div className="home-team-grid">{data.teams.map((team) => <article className="home-team-card card-surface" key={team.id}><div className="home-team-card-head"><h3>{team.name} {team.demoMode && <span className="demo-inline">Demo Mode</span>}</h3><span className={`home-status status-${team.status}`}><i />{statusLabel(team.status)}</span></div><p className="home-working"><i />{plural(team.workingMembers, "working Member")}</p><div className="home-objective"><span>Current work</span><strong>{team.currentObjective ?? "No active work"}</strong></div>{team.progress && <div className="home-progress"><div><span>Task progress</span><b>{team.progress.completed} of {team.progress.total} complete</b></div><progress value={team.progress.completed} max={team.progress.total} /></div>}<footer><span>Manager: <b>{team.manager.name}</b></span><a href={`#teams/${team.id}`}>Open Team <Icon name="arrow" size={14} /></a></footer></article>)}</div>
          </section>

          <section className="home-section home-card recent-home-activity card-surface">
            <div className="home-section-heading"><div><span className="home-heading-icon tone-green"><Icon name="activity" size={18} /></span><h2>Recent Activity</h2></div></div>
            {data.recentActivity.length === 0 ? <div className="home-card-empty"><Icon name="activity" size={21} /><div><strong>No recent activity yet.</strong><p>Your teams’ updates will appear here.</p></div></div> : <div className="home-activity-list">{data.recentActivity.map((item) => <article key={item.id}><i className={`activity-dot tone-${item.tone}`} /><p>{item.text}</p><time dateTime={item.timestamp}>{formatRelativeTime(item.timestamp)}</time></article>)}</div>}
          </section>
        </>}
      </div>
  </AppPage>;
};
