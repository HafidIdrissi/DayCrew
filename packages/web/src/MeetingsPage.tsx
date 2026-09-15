import { useEffect, useState } from "react";
import { listTeams, loadHome } from "./api";
import { AppPage, Icon } from "./components";
import type { Team, Workspace } from "./types";

/** P1 preview only. Meeting execution and persistence belong to P2. */
export const MeetingsPage = ({ selectionId, onSwitchWorkspace }: { selectionId: string; onSwitchWorkspace: () => void; onWorkspaceIssue: () => void }) => {
  const [teams, setTeams] = useState<Team[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [needsCount, setNeedsCount] = useState(0);
  useEffect(() => { let active = true; void Promise.all([listTeams(selectionId), loadHome(selectionId)])
    .then(([nextTeams, home]) => { if (active) { setTeams(nextTeams); setWorkspace(home.workspace); setNeedsCount(home.needsYou.count); } }).catch(() => undefined);
    return () => { active = false; }; }, [selectionId]);
  const managers = teams.flatMap((team) => team.members.filter((member) => member.isManager).map((member) => ({ team, member })));
  return <AppPage view="Meetings" needsCount={needsCount} {...(workspace ? { workspace, onSwitchWorkspace } : {})}><div className="meeting-preview-page">
    <header className="page-heading"><p>MANAGERS ROOM</p><h1>Bring your managers together.</h1><span>A shared room for cross-team planning is coming in phase 2. No meeting runs from this preview.</span></header>
    <section className="meeting-preview card-surface"><div className="meeting-preview-scene" aria-hidden="true"><span className="meeting-table" /><span className="meeting-seat seat-a" /><span className="meeting-seat seat-b" /><span className="meeting-seat seat-c" /></div><div><h2>Meeting room preview</h2><p>{managers.length > 1 ? `${managers.length} managers could meet here when orchestration is available.` : "Create another Team to prepare a cross-team meeting."}</p><p>Execution, shared context and durable decisions will be added in phase 2.</p><button type="button" className="primary-button" disabled title="Real meetings are planned for phase 2">Start meeting · coming later</button></div></section>
    <section className="meeting-managers"><h2>Your managers</h2>{managers.length ? <div>{managers.map(({ team, member }) => <a key={member.id} href={`#teams/${team.id}`}><Icon name="team" size={18} /><span><strong>{member.name}</strong><small>{team.name}</small></span></a>)}</div> : <p>No managers yet. <a href="#teams">Create a Team</a>.</p>}</section>
  </div></AppPage>;
};
