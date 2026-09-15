import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addPermanentSkill,
  addTemporarySkill,
  getSkillRecommendations,
  loadTeamDashboard,
  providerErrorKind,
  removePermanentSkill,
  removeTemporarySkill,
  startGoal,
} from "./api";
import {
  ActivityFeed,
  AppSidebar,
  EmptyTeamPage,
  ErrorTeamPage,
  HandoffTimeline,
  LoadingTeamPage,
  ManagerCard,
  ManagerComposer,
  MissionIssues,
  MemberCard,
  SkillDrawer,
  TeamHeader,
  TeamSummary,
  TeamTabs,
  TopBar,
} from "./components";
import { activeTaskFor } from "./skillCatalog";
import type { MemberSkill, MemberStatus, MissionIssue, SkillRecommendation, TeamDashboardData, WorkspaceIssueState } from "./types";

const latestFirst = <T extends { startedAt: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

export const memberStatusMap = (data: TeamDashboardData): Map<string, MemberStatus> => {
  const status = new Map(data.team.members.map((member) => [member.id, "idle" as MemberStatus]));
  const latest = latestFirst(data.sessions)[0];
  latest?.members.forEach((runtime) => status.set(runtime.memberId, runtime.status));
  data.needsYou.forEach((item) => {
    if (item.kind === "approval") status.set(item.memberId, "blocked-on-approval");
    else if (item.kind === "blocker" || item.kind === "failed-task") status.set(item.memberId, "failed");
  });
  return status;
};

const teamIdFromHash = (): string | undefined => {
  const match = window.location.hash.match(/^#teams\/([a-z0-9_-]+)(?:\/(?:overview|tasks|deliverables|members))?$/);
  return match?.[1];
};

const isWorkspaceIssue = (
  value: TeamDashboardData | WorkspaceIssueState | null | undefined,
): value is WorkspaceIssueState => value !== null && value !== undefined && "kind" in value;

export const TeamPage = ({ selectionId, onSwitchWorkspace, onWorkspaceIssue }: {
  selectionId: string; workspaceKey: string; onSwitchWorkspace: () => void; onWorkspaceIssue: () => void;
}) => {
  const [data, setData] = useState<TeamDashboardData | WorkspaceIssueState | null | undefined>();
  const [error, setError] = useState<string>();
  const [composerError, setComposerError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMemberId, setDrawerMemberId] = useState<string>();
  const [recommendations, setRecommendations] = useState<SkillRecommendation[]>([]);
  const generation = useRef(0);

  const refresh = useCallback(async (quiet = false) => {
    const request = ++generation.current;
    if (!quiet) setError(undefined);
    try {
      const next = await loadTeamDashboard(teamIdFromHash(), selectionId);
      if (request !== generation.current) return;
      if (isWorkspaceIssue(next)) { setData(undefined); onWorkspaceIssue(); return; }
      setData(next);
    } catch (caught) {
      if (request !== generation.current) return;
      setData(undefined);
      setError(caught instanceof Error ? caught.message : "DayCrew could not load this team.");
    }
  }, [selectionId, onWorkspaceIssue]);

  useEffect(() => { void refresh(); return () => { ++generation.current; }; }, [refresh]);

  useEffect(() => {
    const onHashChange = () => void refresh();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [refresh]);

  const dashboard = data && !isWorkspaceIssue(data) ? data : undefined;
  const hasLiveSession = dashboard?.sessions.some((session) => ["created", "planning", "working", "waiting-for-human", "waiting-for-you", "review"].includes(session.status));
  useEffect(() => {
    if (!hasLiveSession) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, 6_000);
    return () => window.clearInterval(timer);
  }, [hasLiveSession, refresh]);

  useEffect(() => {
    if (!dashboard) return;
    setDrawerMemberId((current) => current && dashboard.team.members.some((member) => member.id === current)
      ? current
      : dashboard.team.members.find((member) => member.isManager)?.id ?? dashboard.team.members[0]?.id);
  }, [dashboard?.team.id]);

  useEffect(() => {
    if (!dashboard || !drawerMemberId) return;
    let active = true;
    setRecommendations([]);
    const task = activeTaskFor(dashboard.tasks, drawerMemberId);
    void getSkillRecommendations(dashboard.team.id, drawerMemberId, selectionId, task?.id, task?.sessionId)
      .then((items) => { if (active) setRecommendations(items); })
      .catch(() => { if (active) setRecommendations([]); });
    return () => { active = false; };
  }, [dashboard?.team.id, dashboard?.tasks, drawerMemberId, selectionId]);

  const startManagerGoal = async (goal: string) => {
    if (!dashboard) return;
    setIsSubmitting(true);
    setComposerError(undefined);
    try {
      await startGoal(dashboard.team.id, goal, selectionId);
      await refresh(true);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The Manager could not start this goal.";
      const kind = providerErrorKind(message);
      setComposerError(kind === "restricted"
        ? `Provider restricted: ${message}`
        : kind === "unavailable"
          ? `Provider unavailable: ${message}`
          : message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const statusByMember = useMemo(() => dashboard ? memberStatusMap(dashboard) : new Map<string, MemberStatus>(), [dashboard]);

  if (data === undefined && !error) return <div className="app-frame"><AppSidebar needsCount={0} /><main className="app-main state-main"><LoadingTeamPage /></main></div>;
  if (error) return <div className="app-frame"><AppSidebar needsCount={0} /><main className="app-main state-main"><ErrorTeamPage message={error} onRetry={() => void refresh()} /></main></div>;
  if (data === null) return <div className="app-frame"><AppSidebar needsCount={0} /><main className="app-main state-main"><EmptyTeamPage /></main></div>;
  if (!dashboard) return null;

  const manager = dashboard.team.members.find((member) => member.isManager);
  const latestSession = latestFirst(dashboard.sessions)[0];
  const normalizedQuery = query.trim().toLowerCase();
  const memberMatches = (name: string, role: string) => !normalizedQuery || `${name} ${role}`.toLowerCase().includes(normalizedQuery);
  const visibleMembers = dashboard.team.members.filter((member) => !member.isManager && memberMatches(member.name, member.role));
  const visibleTasks = dashboard.tasks.filter((task) => !normalizedQuery || `${task.title} ${task.description}`.toLowerCase().includes(normalizedQuery));
  const visibleActivity = dashboard.activity.filter((event) => !normalizedQuery || `${event.summary} ${event.kind}`.toLowerCase().includes(normalizedQuery));
  const drawerMember = dashboard.team.members.find((member) => member.id === drawerMemberId) ?? manager ?? dashboard.team.members[0];
  const skillStateFor = (memberId: string) => dashboard.memberSkills.find((state) => state.memberId === memberId);
  const skillsFor = (memberId: string) => skillStateFor(memberId)?.assignments.filter((assignment) => assignment.scope === "permanent").map((assignment) => assignment.skill) ?? [];
  const attachSkill = async (scope: "task" | "member", skillId: string, taskId?: string) => {
    if (!drawerMember) return;
    if (scope === "task") {
      if (!taskId) throw new Error("Choose an active Task before adding a temporary Skill.");
      const task = dashboard.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("DayCrew could not find this Task.");
      await addTemporarySkill(taskId, task.sessionId, drawerMember.id, skillId, selectionId);
    } else {
      await addPermanentSkill(dashboard.team.id, drawerMember.id, skillId, selectionId);
    }
    await refresh(true);
  };
  const removeSkill = async (assignment: MemberSkill) => {
    if (!drawerMember) return;
    if (assignment.scope === "temporary") {
      if (!assignment.taskId) throw new Error("This temporary Skill is missing its Task.");
      const task = dashboard.tasks.find((candidate) => candidate.id === assignment.taskId);
      if (!task) throw new Error("DayCrew could not find this Task.");
      await removeTemporarySkill(assignment.taskId, task.sessionId, drawerMember.id, assignment.skill.id, selectionId);
    } else {
      await removePermanentSkill(dashboard.team.id, drawerMember.id, assignment.skill.id, selectionId);
    }
    await refresh(true);
  };
  const openSkillsFor = (memberId: string) => { setDrawerMemberId(memberId); setDrawerOpen(true); };
  const activeCount = [...statusByMember.values()].filter((status) => ["thinking", "working"].includes(status)).length;
  const retryMission = async (issue: MissionIssue) => {
    await startGoal(issue.teamId, issue.goal, selectionId);
    await refresh(true);
  };
  const tab = window.location.hash.endsWith("/tasks") ? "Tasks" : window.location.hash.endsWith("/deliverables") ? "Deliverables" : "Members";
  const legacyOverview = window.location.hash.endsWith("/overview");
  const completedSessions = latestFirst(dashboard.sessions).filter((session) => session.status === "completed");

  return (
    <div className="app-frame">
      <AppSidebar needsCount={dashboard.needsYou.length} />
      <main className="app-main">
        <TopBar workspace={dashboard.workspace} query={query} needsCount={dashboard.needsYou.length} onQueryChange={setQuery} onSwitchWorkspace={onSwitchWorkspace} />
        <div className={`team-layout ${drawerOpen ? "drawer-visible" : ""}`}>
          <div className="team-content">
            <a className="text-button" href={`#teams/${dashboard.team.id}`}>← Team conversations</a>
            <TeamHeader team={dashboard.team} activeCount={activeCount} needsCount={dashboard.needsYou.length} onOpenSkills={() => setDrawerOpen(true)} />
            <TeamTabs teamId={dashboard.team.id} active={tab} />
            <MissionIssues issues={dashboard.missionIssues} onRetry={retryMission} />
            {dashboard.team.members.some((member) => member.engine.mode === "manual" && member.engine.provider === "demo") && <p className="demo-mode-banner"><strong>Demo Mode</strong> Deterministic simulated provider output — not real AI execution.</p>}
            {(tab === "Members" || legacyOverview) && <><TeamSummary team={dashboard.team} sessions={dashboard.sessions} tasks={dashboard.tasks} knowledge={dashboard.knowledge} needsYou={dashboard.needsYou} />
            <ManagerComposer team={dashboard.team} {...(latestSession ? { session: latestSession } : {})} isSubmitting={isSubmitting} {...(composerError ? { error: composerError } : {})} onSubmit={startManagerGoal} />
            {manager && <ManagerCard member={manager} status={statusByMember.get(manager.id) ?? "idle"} skills={skillsFor(manager.id)} knowledgeCount={dashboard.knowledge.length} onAddSkill={() => openSkillsFor(manager.id)} />}
            <section className="members-section content-section">
              <div className="section-heading"><div><h2>Team Members</h2></div><span>{visibleMembers.length} specialists</span></div>
              {visibleMembers.length ? <div className="member-grid">{visibleMembers.map((member) => {
                const currentTask = dashboard.tasks.find((task) => task.ownerId === member.id && task.status !== "done");
                return <MemberCard key={member.id} member={member} status={statusByMember.get(member.id) ?? "idle"} skills={skillsFor(member.id)} {...(currentTask ? { currentTask } : {})} onAddSkill={() => openSkillsFor(member.id)} />;
              })}</div> : <div className="quiet-empty small"><p>{normalizedQuery ? "No team members match your search." : "This team has no specialist members yet."}</p></div>}
            </section></>}
            {(tab === "Tasks" || legacyOverview) && <><HandoffTimeline tasks={visibleTasks} members={dashboard.team.members} /><ActivityFeed activity={visibleActivity} members={dashboard.team.members} /></>}
            {tab === "Deliverables" && <section className="team-deliverables content-section"><div className="section-heading"><h2>Recorded deliverables</h2><span>{completedSessions.length} completed Mission{completedSessions.length === 1 ? "" : "s"}</span></div>
              {completedSessions.length ? completedSessions.map((session) => <article className="card-surface" key={session.id}><small>{new Date(session.completedAt ?? session.startedAt).toLocaleDateString()}</small><h3>{session.goal}</h3><p>{session.summary?.trim() || "Completed; no summary was recorded."}</p><div>{dashboard.tasks.filter((task) => task.sessionId === session.id && task.status === "done").map((task) => <a key={task.id} href={`#tasks/${session.id}/${task.id}`}>{task.title} ↗</a>)}</div></article>) : <div className="quiet-empty"><p>No completed Mission has a recorded result yet. Completed summaries and Tasks will appear here.</p></div>}
            </section>}
          </div>
          {drawerMember && <SkillDrawer open={drawerOpen} team={dashboard.team} member={drawerMember} tasks={dashboard.tasks} library={dashboard.skills} assignments={skillStateFor(drawerMember.id)?.assignments ?? []} availability={skillStateFor(drawerMember.id)?.availability ?? []} recommendations={recommendations} onClose={() => setDrawerOpen(false)} onMemberChange={setDrawerMemberId} onAttach={attachSkill} onRemove={removeSkill} />}
        </div>
      </main>
    </div>
  );
};
