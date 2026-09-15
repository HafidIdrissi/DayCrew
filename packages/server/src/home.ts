import {
  ActivityService,
  TeamService,
  WorkSessionService,
  WorkspaceService,
} from "@daycrew/core";
import type { ActivityEvent, NeedsYouItem, Task, Team, WorkSession } from "@daycrew/shared";
import { currentMissionIssues, type MissionIssue } from "./mission-issues.js";

const ACTIVE_SESSION_STATUSES = new Set<WorkSession["status"]>([
  "created", "planning", "working", "waiting-for-you", "waiting-for-human", "review",
]);
const WORKING_MEMBER_STATUSES = new Set<WorkSession["members"][number]["status"]>(["thinking", "working"]);

export interface HomeTeamSummary {
  readonly id: string;
  readonly name: string;
  readonly demoMode: boolean;
  readonly manager: { readonly id: string; readonly name: string };
  readonly members: readonly { readonly id: string; readonly name: string; readonly role: string; readonly isManager: boolean }[];
  readonly workingMembers: number;
  readonly currentObjective?: string;
  readonly status: "working" | "needs-you" | "ready";
  readonly progress?: { readonly completed: number; readonly total: number };
  readonly recentResult?: { readonly sessionId: string; readonly goal: string; readonly summary: string };
}

export interface HomeNeedsYouHighlight {
  readonly id: string;
  readonly kind: "approval" | "decision" | "blocker";
  readonly title: string;
  readonly detail: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly createdAt: string;
}

export interface HomeActivityItem {
  readonly id: string;
  readonly text: string;
  readonly timestamp: string;
  readonly tone: "success" | "attention" | "neutral";
  readonly teamId: string;
}

export interface HomeData {
  readonly workspace: { readonly id: string; readonly name: string; readonly createdAt: string; readonly updatedAt: string };
  readonly needsYou: { readonly count: number; readonly highlights: readonly HomeNeedsYouHighlight[] };
  readonly teams: readonly HomeTeamSummary[];
  readonly recentActivity: readonly HomeActivityItem[];
  readonly missionIssues: readonly MissionIssue[];
  readonly dailyBrief: {
    readonly teams: readonly { readonly teamId: string; readonly teamName: string; readonly completedTasks: number; readonly reviewTasks: number; readonly activeTasks: number }[];
    readonly needsYou: number;
  };
}

const latestFirst = <T extends { readonly startedAt: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

const needsKind = (item: NeedsYouItem): HomeNeedsYouHighlight["kind"] | undefined => {
  if (item.kind === "approval") return "approval";
  if (item.kind === "decision" || item.kind === "review") return "decision";
  if (item.kind === "blocker" || item.kind === "failed-task") return "blocker";
  return undefined;
};

export const selectNeedsYouHighlights = (
  items: readonly NeedsYouItem[],
  teams: ReadonlyMap<string, Team>,
): HomeNeedsYouHighlight[] => {
  const selected = new Map<HomeNeedsYouHighlight["kind"], NeedsYouItem>();
  for (const item of [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    const kind = needsKind(item);
    if (kind && !selected.has(kind)) selected.set(kind, item);
  }
  return [...selected.entries()].map(([kind, item]) => ({
    id: item.id,
    kind,
    title: item.title,
    detail: item.detail,
    teamId: item.teamId,
    teamName: teams.get(item.teamId)?.name ?? "Team",
    createdAt: item.createdAt,
  })).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
};

const activityText = (
  event: ActivityEvent,
  teams: ReadonlyMap<string, Team>,
  sessions: ReadonlyMap<string, WorkSession>,
  tasks: ReadonlyMap<string, Task>,
): Omit<HomeActivityItem, "id" | "timestamp" | "teamId"> | undefined => {
  const team = teams.get(event.teamId);
  const taskId = typeof event.data["taskId"] === "string" ? event.data["taskId"] : undefined;
  const task = taskId ? tasks.get(`${event.sessionId}:${taskId}`) : undefined;
  const ownerId = typeof event.data["ownerId"] === "string" ? event.data["ownerId"] : task?.ownerId;
  const owner = ownerId ? team?.members.find((member) => member.id === ownerId) : undefined;
  if (event.kind === "task.created" && task) {
    return { text: `Manager created “${task.title}”`, tone: "neutral" };
  }
  if (event.kind === "task.handed_off" && task) {
    return { text: `Manager assigned “${task.title}” to ${owner?.name ?? "a Team Member"}`, tone: "neutral" };
  }
  if (event.kind === "task.updated" && task) {
    const status = typeof event.data["status"] === "string" ? event.data["status"] : task.status;
    if (status === "done") return { text: `${owner?.name ?? "A Team Member"} completed “${task.title}”`, tone: "success" };
    if (status === "review") return { text: `${owner?.name ?? "A Team Member"} moved “${task.title}” to Review`, tone: "attention" };
    return { text: `“${task.title}” moved to ${status.replaceAll("-", " ")}`, tone: "neutral" };
  }
  if (event.kind === "approval.decided") {
    const status = typeof event.data["status"] === "string" ? event.data["status"] : "resolved";
    const action = event.summary.replace(/:\s*(approved|denied|expired)$/i, "");
    return { text: `You ${status} ${action}`, tone: status === "approved" ? "success" : "attention" };
  }
  if (event.kind === "session.completed") {
    const session = sessions.get(event.sessionId);
    return { text: `${team?.name ?? "Team"} completed “${session?.goal ?? event.summary}”`, tone: "success" };
  }
  if (event.kind === "session.failed") {
    return { text: `${team?.name ?? "Team"} stopped after an error. Open the Team for recovery options.`, tone: "attention" };
  }
  return undefined;
};

export const buildHomeData = async (workspaceRoot: string): Promise<HomeData> => {
  const [workspace, teams, sessions, pendingNeeds, activity] = await Promise.all([
    new WorkspaceService(workspaceRoot).load(),
    new TeamService(workspaceRoot).list(),
    new WorkSessionService(workspaceRoot).list(),
    new WorkSessionService(workspaceRoot).listNeedsYou("pending"),
    new ActivityService(workspaceRoot).list(),
  ]);
  const sessionService = new WorkSessionService(workspaceRoot);
  const tasksBySession = new Map<string, Task[]>();
  await Promise.all(sessions.map(async (session) => {
    tasksBySession.set(session.id, await sessionService.listTasks(session.id));
  }));
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const tasksByKey = new Map([...tasksBySession].flatMap(([sessionId, tasks]) =>
    tasks.map((task) => [`${sessionId}:${task.id}`, task] as const),
  ));

  const teamSummaries = teams.map((team): HomeTeamSummary => {
    const teamSessions = latestFirst(sessions.filter((session) => session.teamId === team.id));
    const activeSession = teamSessions.find((session) => ACTIVE_SESSION_STATUSES.has(session.status));
    const activeTasks = activeSession ? tasksBySession.get(activeSession.id) ?? [] : [];
    const teamNeeds = pendingNeeds.filter((item) => item.teamId === team.id).length;
    const completed = activeTasks.filter((task) => task.status === "done").length;
    const manager = team.members.find((member) => member.isManager)!;
    const completedSession = teamSessions.find((session) => session.status === "completed" && session.summary?.trim());
    return {
      id: team.id,
      name: team.name,
      demoMode: team.members.some((member) => member.engine.mode === "manual" && member.engine.provider === "demo"),
      manager: { id: manager.id, name: manager.name },
      members: team.members.map((member) => ({ id: member.id, name: member.name, role: member.role, isManager: member.isManager })),
      workingMembers: activeSession?.members.filter((member) => WORKING_MEMBER_STATUSES.has(member.status)).length ?? 0,
      ...(activeSession ? { currentObjective: activeSession.goal } : {}),
      status: teamNeeds > 0 || activeSession?.status === "waiting-for-human" || activeSession?.status === "waiting-for-you"
        ? "needs-you"
        : activeSession ? "working" : "ready",
      ...(activeTasks.length > 0 ? { progress: { completed, total: activeTasks.length } } : {}),
      ...(completedSession ? { recentResult: { sessionId: completedSession.id, goal: completedSession.goal, summary: completedSession.summary!.trim() } } : {}),
    };
  });

  const recentActivity = [...activity].sort((a, b) => b.sequence - a.sequence).flatMap((event) => {
    const presentation = activityText(event, teamsById, sessionsById, tasksByKey);
    return presentation ? [{ id: event.id, timestamp: event.timestamp, teamId: event.teamId, ...presentation }] : [];
  }).slice(0, 6);

  return {
    workspace: {
      id: workspace.id, name: workspace.name, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
    },
    needsYou: { count: pendingNeeds.length, highlights: selectNeedsYouHighlights(pendingNeeds, teamsById) },
    teams: teamSummaries,
    recentActivity,
    missionIssues: currentMissionIssues(teams, sessions),
    dailyBrief: {
      teams: teams.map((team) => {
        const latestSession = latestFirst(sessions.filter((session) => session.teamId === team.id))[0];
        const tasks = latestSession ? tasksBySession.get(latestSession.id) ?? [] : [];
        return {
          teamId: team.id,
          teamName: team.name,
          completedTasks: tasks.filter((task) => task.status === "done").length,
          reviewTasks: tasks.filter((task) => task.status === "review").length,
          activeTasks: tasks.filter((task) => task.status === "todo" || task.status === "in-progress").length,
        };
      }),
      needsYou: pendingNeeds.length,
    },
  };
};
