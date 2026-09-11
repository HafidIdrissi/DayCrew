import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadTeamDashboard, providerErrorKind, startGoal } from "./api";
import {
  ActivityFeed,
  AppSidebar,
  EmptyTeamPage,
  ErrorTeamPage,
  HandoffTimeline,
  LoadingTeamPage,
  ManagerCard,
  ManagerComposer,
  MemberCard,
  SkillDrawer,
  TeamHeader,
  TeamSummary,
  TopBar,
} from "./components";
import {
  PREVIEW_SKILL_CATALOG,
  loadSkillAttachments,
  saveSkillAttachments,
  type SkillAttachment,
} from "./skillCatalog";
import type { MemberStatus, TeamDashboardData, WorkspaceIssueState } from "./types";

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
  const match = window.location.hash.match(/^#teams\/([a-z0-9_-]+)$/);
  return match?.[1];
};

const isWorkspaceIssue = (
  value: TeamDashboardData | WorkspaceIssueState | null | undefined,
): value is WorkspaceIssueState => value !== null && value !== undefined && "kind" in value;

export const TeamPage = ({ selectionId, workspaceKey, onSwitchWorkspace, onWorkspaceIssue }: {
  selectionId: string; workspaceKey: string; onSwitchWorkspace: () => void; onWorkspaceIssue: () => void;
}) => {
  const [data, setData] = useState<TeamDashboardData | WorkspaceIssueState | null | undefined>();
  const [error, setError] = useState<string>();
  const [composerError, setComposerError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerMemberId, setDrawerMemberId] = useState<string>();
  const [attachments, setAttachments] = useState<SkillAttachment[]>([]);
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
    setAttachments(loadSkillAttachments(`${workspaceKey}.${dashboard.team.id}`));
    setDrawerMemberId((current) => current && dashboard.team.members.some((member) => member.id === current)
      ? current
      : dashboard.team.members.find((member) => member.isManager)?.id ?? dashboard.team.members[0]?.id);
  }, [workspaceKey, dashboard?.team.id]);

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

  const attachSkill = (attachment: SkillAttachment) => {
    if (!dashboard) return;
    const next = [...attachments.filter((item) => !(item.memberId === attachment.memberId && item.skillId === attachment.skillId && item.scope === attachment.scope && item.taskId === attachment.taskId)), attachment];
    setAttachments(next);
    saveSkillAttachments(`${workspaceKey}.${dashboard.team.id}`, next);
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
  const skillsFor = (memberId: string) => PREVIEW_SKILL_CATALOG.filter((skill) => attachments.some((attachment) => attachment.memberId === memberId && attachment.skillId === skill.id && attachment.scope === "member"));
  const openSkillsFor = (memberId: string) => { setDrawerMemberId(memberId); setDrawerOpen(true); };
  const activeCount = [...statusByMember.values()].filter((status) => ["thinking", "working"].includes(status)).length;

  return (
    <div className="app-frame">
      <AppSidebar needsCount={dashboard.needsYou.length} />
      <main className="app-main">
        <TopBar workspace={dashboard.workspace} query={query} onQueryChange={setQuery} onSwitchWorkspace={onSwitchWorkspace} />
        <div className={`team-layout ${drawerOpen ? "drawer-visible" : ""}`}>
          <div className="team-content">
            <TeamHeader team={dashboard.team} activeCount={activeCount} needsCount={dashboard.needsYou.length} onOpenSkills={() => setDrawerOpen(true)} />
            <TeamSummary team={dashboard.team} sessions={dashboard.sessions} tasks={dashboard.tasks} knowledge={dashboard.knowledge} needsYou={dashboard.needsYou} />
            <ManagerComposer team={dashboard.team} {...(latestSession ? { session: latestSession } : {})} isSubmitting={isSubmitting} {...(composerError ? { error: composerError } : {})} onSubmit={startManagerGoal} />
            {manager && <ManagerCard member={manager} status={statusByMember.get(manager.id) ?? "idle"} skills={skillsFor(manager.id)} knowledgeCount={dashboard.knowledge.length} onAddSkill={() => openSkillsFor(manager.id)} />}
            <section className="members-section content-section">
              <div className="section-heading"><div><h2>Team Members</h2></div><span>{visibleMembers.length} specialists</span></div>
              {visibleMembers.length ? <div className="member-grid">{visibleMembers.map((member) => {
                const currentTask = dashboard.tasks.find((task) => task.ownerId === member.id && task.status !== "done");
                return <MemberCard key={member.id} member={member} status={statusByMember.get(member.id) ?? "idle"} skills={skillsFor(member.id)} {...(currentTask ? { currentTask } : {})} onAddSkill={() => openSkillsFor(member.id)} />;
              })}</div> : <div className="quiet-empty small"><p>{normalizedQuery ? "No team members match your search." : "This team has no specialist members yet."}</p></div>}
            </section>
            <HandoffTimeline tasks={visibleTasks} members={dashboard.team.members} />
            <ActivityFeed activity={visibleActivity} members={dashboard.team.members} />
          </div>
          {drawerMember && <SkillDrawer open={drawerOpen} team={dashboard.team} member={drawerMember} tasks={dashboard.tasks} attachments={attachments} onClose={() => setDrawerOpen(false)} onMemberChange={setDrawerMemberId} onAttach={attachSkill} />}
        </div>
      </main>
    </div>
  );
};
