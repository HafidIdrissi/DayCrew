import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ApiError, loadTaskDetail, loadTasksDashboard } from "./api";
import { AppPage, Avatar, Icon, LoadingTeamPage, formatRelativeTime } from "./components";
import { memberShape, taskColumns as columns, taskStatusLabel as statusLabel } from "./taskUtils";
import type { TaskBoardItem, TaskDetailData, TaskStatus, TasksData } from "./types";

export type TaskFilters = {
  teamId: string;
  memberKey: string;
  status: "all" | TaskStatus;
  needsYou: boolean;
  query: string;
};

export const filterTaskBoardItems = (tasks: readonly TaskBoardItem[], filters: TaskFilters): TaskBoardItem[] => {
  const query = filters.query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.teamId !== "all" && task.team.id !== filters.teamId) return false;
    if (filters.memberKey !== "all" && `${task.team.id}:${task.owner?.id ?? ""}` !== filters.memberKey) return false;
    if (filters.status !== "all" && task.status !== filters.status) return false;
    if (filters.needsYou && !task.needsYou) return false;
    return !query || `${task.title} ${task.description} ${task.currentState}`.toLowerCase().includes(query);
  });
};

export const TaskBoard = ({ tasks }: { tasks: readonly TaskBoardItem[] }) => (
  <div className="task-board" aria-label="Task board">
    {columns.map((column) => {
      const items = tasks.filter((task) => task.status === column.status);
      return <section className={`task-column task-column-${column.status}`} aria-labelledby={`column-${column.status}`} key={column.status}>
        <header><div><i /><h2 id={`column-${column.status}`}>{column.label}</h2></div><span>{items.length}</span></header>
        <div className="task-column-list">{items.map((task) => <a className="task-board-card" href={`#tasks/${encodeURIComponent(task.sessionId)}/${encodeURIComponent(task.id)}`} key={`${task.sessionId}:${task.id}`}>
          <div className="task-card-top"><span className="task-team-label">{task.team.name}</span>{task.needsYou && <span className="task-needs-pill"><Icon name="warning" size={12} />Needs You</span>}</div>
          <h3>{task.title}</h3>
          <p className="task-current-state">{task.currentState}</p>
          <div className="task-card-signals">
            <span className={`task-status-label status-${task.status}`}>{statusLabel(task.status)}</span>
            {task.dependencyCount > 0 && <span title={`${task.incompleteDependencyCount} incomplete`}><Icon name="paperclip" size={13} />{task.dependencyCount} {task.dependencyCount === 1 ? "dependency" : "dependencies"}</span>}
            {task.skills.slice(0, 2).map((skill) => <span className="task-skill-pill" key={skill.id}><Icon name="sparkle" size={12} />{skill.name}</span>)}
          </div>
          <footer>{task.owner ? <><Avatar member={memberShape(task.owner)} size="sm" /><div><strong>{task.owner.name}</strong><small>{task.owner.role}</small></div></> : <div><strong>Unassigned</strong><small>Needs an owner</small></div>}<Icon name="arrow" size={15} /></footer>
        </a>)}</div>
        {items.length === 0 && <div className="task-column-empty">{column.status === "review" ? "Nothing waiting for review." : "No Tasks here."}</div>}
      </section>;
    })}
  </div>
);

const DetailSection = ({ title, children }: { title: string; children: ReactNode }) => <section className="task-detail-section"><h3>{title}</h3>{children}</section>;

const TaskDetail = ({ detail, onClose }: { detail: TaskDetailData; onClose: () => void }) => {
  const sequence = detail.handoffs.length > 0
    ? [detail.handoffs[0]?.from?.name ?? "Unassigned", ...detail.handoffs.map((handoff) => handoff.to.name)]
    : [];
  return <aside className="task-detail-drawer" aria-label="Task detail">
    <header className="task-detail-header"><div><span>{detail.team.name}</span><h2>{detail.title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close Task detail"><Icon name="close" size={19} /></button></header>
    <div className="task-detail-body">
      <div className="task-detail-summary"><span className={`task-status-label status-${detail.status}`}>{statusLabel(detail.status)}</span>{detail.owner && <span><Avatar member={memberShape(detail.owner)} size="sm" /><strong>{detail.owner.name}</strong><small>{detail.owner.role}</small></span>}</div>
      <p className="task-description">{detail.description || "No description was provided for this Task."}</p>
      {detail.needsYou.length > 0 && <a className="task-attention-link" href="#needs-you"><Icon name="warning" size={17} /><span><strong>This Task needs you</strong>Review {detail.needsYou.length} pending {detail.needsYou.length === 1 ? "item" : "items"}</span><Icon name="arrow" size={15} /></a>}

      <DetailSection title="Dependencies">{detail.dependencies.length ? <div className="detail-list">{detail.dependencies.map((dependency) => <div key={dependency.id}><span className={`task-status-dot status-${dependency.status}`} /><strong>{dependency.title}</strong><small>{statusLabel(dependency.status)}</small></div>)}</div> : <p className="detail-empty">No dependencies.</p>}</DetailSection>
      <DetailSection title="Members involved">{detail.members.length ? <div className="detail-member-list">{detail.members.map((member) => <span key={member.id}><Avatar member={memberShape(member)} size="sm" /><b>{member.name}</b><small>{member.role}</small></span>)}</div> : <p className="detail-empty">No Member activity yet.</p>}</DetailSection>
      <DetailSection title="Handoffs">{sequence.length > 0 ? <div className="handoff-path">{sequence.map((name, index) => <div key={`${name}-${index}`}><span>{name}</span>{index < sequence.length - 1 && <Icon name="arrow" size={16} />}</div>)}</div> : <p className="detail-empty">No handoffs recorded.</p>}{detail.handoffs.map((handoff, index) => handoff.note && <p className="handoff-note" key={index}>{handoff.from?.name ?? "Unassigned"} → {handoff.to.name}: {handoff.note}</p>)}</DetailSection>
      <DetailSection title="Skills used">{detail.skills.length ? <div className="detail-skills">{detail.skills.map((item) => <span key={`${item.member.id}:${item.skill.id}`}><Icon name="sparkle" size={13} /><b>{item.skill.name}</b><small>{item.member.name}</small></span>)}</div> : <p className="detail-empty">No task-scoped Skills.</p>}</DetailSection>
      <DetailSection title="Approvals">{detail.approvals.length ? <div className="detail-approvals">{detail.approvals.map((approval) => <article key={approval.id}><div><strong>{approval.summary}</strong><span className={`risk-pill risk-${approval.risk}`}>{approval.risk}</span></div><p>{approval.member?.name ?? "A Team Member"} · {approval.action}{approval.target ? ` · ${approval.target}` : ""}</p><small>{approval.status}{approval.feedback ? ` · ${approval.feedback}` : ""}</small>{approval.outcome && <small className={approval.recoveryRequired ? "approval-outcome recovery" : "approval-outcome"}>{approval.outcome}</small>}</article>)}</div> : <p className="detail-empty">No approvals for this Task.</p>}</DetailSection>
      <DetailSection title="Artifacts & results">{detail.results.length ? <div className="detail-results">{detail.results.map((result) => <article key={result.id}><Icon name="paperclip" size={15} /><div><strong>{result.title}</strong><p>{result.summary}</p><small>{result.producedBy?.name ?? "Team Member"} · {formatRelativeTime(result.createdAt)}</small></div></article>)}</div> : <p className="detail-empty">No results have been recorded yet.</p>}</DetailSection>
      <DetailSection title="Work history & activity">{detail.history.length ? <div className="task-history">{detail.history.map((item) => <article key={item.id}><i className={`tone-${item.tone}`} /><div><p>{item.text}</p><time dateTime={item.timestamp}>{formatRelativeTime(item.timestamp)}</time></div></article>)}</div> : <p className="detail-empty">No activity recorded yet.</p>}</DetailSection>
    </div>
  </aside>;
};

const taskRoute = (hash: string): { sessionId: string; taskId: string } | undefined => {
  const match = hash.match(/^#tasks\/([^/]+)\/([^/]+)$/);
  return match ? { sessionId: decodeURIComponent(match[1]!), taskId: decodeURIComponent(match[2]!) } : undefined;
};

export const TasksPage = ({ selectionId, routeHash, onSwitchWorkspace, onWorkspaceIssue }: {
  selectionId: string;
  routeHash: string;
  onSwitchWorkspace: () => void;
  onWorkspaceIssue: () => void;
}) => {
  const [data, setData] = useState<TasksData>();
  const [detail, setDetail] = useState<TaskDetailData>();
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [filters, setFilters] = useState<TaskFilters>({ teamId: "all", memberKey: "all", status: "all", needsYou: false, query: "" });
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const refresh = useCallback(async (quiet = false) => {
    const request = ++generation.current;
    if (!quiet) setError(undefined);
    try {
      const next = await loadTasksDashboard(selectionId);
      if (request === generation.current) setData(next);
    } catch (caught) {
      if (request !== generation.current) return;
      if (caught instanceof ApiError && caught.code?.startsWith("WORKSPACE_")) onWorkspaceIssue();
      else setError(caught instanceof Error ? caught.message : "DayCrew could not load Tasks.");
    }
  }, [selectionId, onWorkspaceIssue]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(true); }, 4_000);
    return () => { ++generation.current; window.clearInterval(timer); };
  }, [refresh]);

  const selectedRoute = taskRoute(routeHash);
  useEffect(() => {
    const request = ++detailGeneration.current;
    if (!selectedRoute) { setDetail(undefined); return; }
    void loadTaskDetail(selectedRoute.sessionId, selectedRoute.taskId, selectionId).then((next) => {
      if (request === detailGeneration.current) setDetail(next);
    }).catch((caught) => {
      if (request === detailGeneration.current) setActionError(caught instanceof Error ? caught.message : "DayCrew could not load this Task.");
    });
    return () => { ++detailGeneration.current; };
  }, [selectionId, selectedRoute?.sessionId, selectedRoute?.taskId]);

  const visibleTasks = useMemo(() => data ? filterTaskBoardItems(data.tasks, filters) : [], [data, filters]);
  if (!data && !error) return <AppPage view="Tasks" needsCount={0}><div className="state-main"><LoadingTeamPage /></div></AppPage>;
  if (!data) return <AppPage view="Tasks" needsCount={0}><div className="state-main"><section className="state-page error-state"><span className="state-icon"><Icon name="warning" size={30} /></span><h1>DayCrew needs a moment</h1><p>{error}</p><button className="primary-button" onClick={() => void refresh()}>Try again</button></section></div></AppPage>;
  const members = data.teams.flatMap((team) => team.members.map((member) => ({ ...member, teamId: team.id, teamName: team.name })));
  return <AppPage view="Tasks" needsCount={data.needsYou.length} workspace={data.workspace} onSwitchWorkspace={onSwitchWorkspace}>
    <div className="tasks-content">
      <header className="tasks-heading"><div><p>TASKS</p><h1>Task board</h1><span>See what exists, who owns it, and where work is moving.</span></div><nav aria-label="Tasks views"><a className="active" href="#tasks" aria-current="page">Board</a><a href="#needs-you">Needs You{data.needsYou.length > 0 && <b>{data.needsYou.length}</b>}</a></nav></header>
      {actionError && <p className="inline-error" role="alert">{actionError}</p>}
      {data.tasks.length === 0 ? <div className="tasks-empty card-surface"><span><Icon name="tasks" size={25} /></span><div><h2>No work yet.</h2><p>Give a Team Manager a goal to create the first Tasks.</p></div><a className="primary-button" href="#teams">Open Teams</a></div> : <>
        <section className="task-filters" aria-label="Task filters">
          <label><span>Team</span><select value={filters.teamId} onChange={(event) => setFilters({ ...filters, teamId: event.target.value, memberKey: "all" })}><option value="all">All Teams</option>{data.teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label>
          <label><span>Member</span><select value={filters.memberKey} onChange={(event) => setFilters({ ...filters, memberKey: event.target.value })}><option value="all">All Members</option>{members.filter((member) => filters.teamId === "all" || member.teamId === filters.teamId).map((member) => <option value={`${member.teamId}:${member.id}`} key={`${member.teamId}:${member.id}`}>{member.name} · {member.teamName}</option>)}</select></label>
          <label><span>Status</span><select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as TaskFilters["status"] })}><option value="all">All Statuses</option>{columns.map((column) => <option value={column.status} key={column.status}>{column.label}</option>)}</select></label>
          <label className="task-filter-search"><span>Search</span><div><Icon name="search" size={16} /><input value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} placeholder="Task title" /></div></label>
          <button className={`needs-filter ${filters.needsYou ? "active" : ""}`} aria-pressed={filters.needsYou} onClick={() => setFilters({ ...filters, needsYou: !filters.needsYou })}><Icon name="warning" size={15} />Needs You</button>
        </section>
        <div className="task-results-summary"><p className="task-filter-count" role="status">Showing {visibleTasks.length} of {data.tasks.length} Tasks</p>{(filters.query || filters.teamId !== "all" || filters.memberKey !== "all" || filters.status !== "all" || filters.needsYou) && <button type="button" className="text-button" onClick={() => setFilters({ teamId: "all", memberKey: "all", status: "all", needsYou: false, query: "" })}>Clear filters</button>}</div>
        <TaskBoard tasks={visibleTasks} />
      </>}
    </div>
    {selectedRoute && detail && <><button className="drawer-scrim" aria-label="Close Task detail" onClick={() => { window.location.hash = "tasks"; }} /><TaskDetail detail={detail} onClose={() => { window.location.hash = "tasks"; }} /></>}
  </AppPage>;
};
