import {
  ActivityService,
  ApprovalService,
  SkillService,
  TeamService,
  WorkSessionService,
  WorkspaceService,
} from "@daycrew/core";
import type {
  ActivityEvent,
  ApprovalRecord,
  Message,
  NeedsYouItem,
  Skill,
  Task,
  Team,
  WorkSession,
} from "@daycrew/shared";
import { currentMissionIssues, type MissionIssue } from "./mission-issues.js";

export interface TaskBoardItem {
  readonly id: string;
  readonly sessionId: string;
  readonly team: { readonly id: string; readonly name: string };
  readonly title: string;
  readonly description: string;
  readonly status: Task["status"];
  readonly owner?: { readonly id: string; readonly name: string; readonly role: string };
  readonly dependencyCount: number;
  readonly incompleteDependencyCount: number;
  readonly needsYou: boolean;
  readonly skills: readonly { readonly id: string; readonly name: string }[];
  readonly currentState: string;
  readonly updatedAt: string;
}

export interface GlobalNeedsYouItem {
  readonly id: string;
  readonly kind: NeedsYouItem["kind"];
  readonly who: { readonly id: string; readonly name: string; readonly role: string };
  readonly what: string;
  readonly why: string;
  readonly risk?: NeedsYouItem["risk"];
  readonly action?: string;
  readonly target?: string;
  readonly team: { readonly id: string; readonly name: string };
  readonly task?: { readonly id: string; readonly sessionId: string; readonly title: string };
  readonly provider?: string;
  /** The live provider session backing this approval is gone; a decision can no longer reach it. */
  readonly recoveryRequired?: true;
  readonly suggestedAction: string;
  readonly createdAt: string;
}

export interface TasksData {
  readonly workspace: { readonly id: string; readonly name: string; readonly createdAt: string; readonly updatedAt: string };
  readonly teams: readonly {
    readonly id: string;
    readonly name: string;
    readonly members: readonly { readonly id: string; readonly name: string; readonly role: string }[];
  }[];
  readonly tasks: readonly TaskBoardItem[];
  readonly needsYou: readonly GlobalNeedsYouItem[];
  readonly missionIssues: readonly MissionIssue[];
}

type WorkspaceTask = Task & { readonly teamId: string };

interface TaskSources {
  workspace: Awaited<ReturnType<WorkspaceService["load"]>>;
  teams: Team[];
  sessions: WorkSession[];
  tasks: WorkspaceTask[];
  messages: Message[];
  needsYou: NeedsYouItem[];
  approvals: ApprovalRecord[];
  activity: ActivityEvent[];
  skills: Skill[];
}

const shortText = (value: string, limit = 260): string => {
  const firstParagraph = value.split(/\r?\n\s*\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return firstParagraph.length > limit ? `${firstParagraph.slice(0, limit - 1)}…` : firstParagraph;
};

const actionLabel = (action: string): string => ({
  "filesystem.write": "Modify Workspace files",
  "filesystem.delete": "Delete Workspace files",
  "command.run": "Run a local command",
  "shell.destructive": "Run a destructive local command",
  "git.push": "Push Git changes",
  "git.destructive": "Run a destructive Git action",
  "external.publish": "Publish externally",
  "network.sensitive": "Use sensitive network access",
  "credential.access": "Access credentials",
  "money.spend": "Spend money",
}[action] ?? "Perform a protected action");

const providerLabel = (provider: string): string => ({
  demo: "Demo Mode",
  mock: "Test provider",
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini / Antigravity",
  grok: "Grok Build",
}[provider] ?? "AI Engine");

const targetFromApproval = (approval: ApprovalRecord | undefined): string | undefined => {
  if (!approval || typeof approval.payload !== "object" || approval.payload === null || Array.isArray(approval.payload)) return undefined;
  const payload = approval.payload as Record<string, unknown>;
  for (const key of ["path", "target", "url", "command"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return shortText(value, 180);
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return shortText(value.join(" "), 180);
  }
  return undefined;
};

/** Never states more than DayCrew can prove about a blocked action. */
const outcomeLabel = (approval: ApprovalRecord): string | undefined => {
  if (approval.outcome === "executed") return "This action ran and returned a result.";
  if (approval.outcome === "not-executed") return "This action did not run.";
  if (approval.outcome === "unknown") {
    return "This action was approved, but DayCrew could not confirm whether it completed.";
  }
  return undefined;
};

const suggestedAction = (item: NeedsYouItem, approval?: ApprovalRecord): string => {
  if (approval?.recovery === "required") {
    return "Recovery is required before this Task can continue. The action did not run; open the Team and start the work again.";
  }
  if (item.kind === "approval") return "Review the requested action and its risk before deciding.";
  if (item.kind === "decision") return "Reply with the choice or guidance the Manager needs.";
  if (item.kind === "review") return "Review the produced work and send clear feedback if changes are needed.";
  if (item.kind === "failed-task") return "Open the Task, review the last safe result, then decide whether the Team should try a new approach.";
  const detail = `${item.title} ${item.detail}`.toLowerCase();
  if (detail.includes("provider")) return "Reconnect the provider or choose an available AI Engine, then resume the Team.";
  if (detail.includes("skill")) return "Review the suggested Skill and add it only if it fits this Task.";
  if (detail.includes("capabilit")) return "Review the Member’s allowed Tools and policy. A Skill cannot grant this capability.";
  if (detail.includes("depend")) return "Complete the prerequisite Task before resuming this work.";
  if (detail.includes("restart") || detail.includes("recovery")) return "Open the Team and start a safe recovery after checking the last recorded action.";
  return "Open the related Task and give the Team the missing information.";
};

const loadSources = async (workspaceRoot: string): Promise<TaskSources> => {
  const sessionsService = new WorkSessionService(workspaceRoot);
  const [workspace, teams, sessions, needsYou, approvals, activity, skills] = await Promise.all([
    new WorkspaceService(workspaceRoot).load(),
    new TeamService(workspaceRoot).list(),
    sessionsService.list(),
    sessionsService.listNeedsYou("pending"),
    new ApprovalService(workspaceRoot).list(),
    new ActivityService(workspaceRoot).list(),
    new SkillService(workspaceRoot).list(),
  ]);
  const sessionData = await Promise.all(sessions.map(async (session) => ({
    tasks: (await sessionsService.listTasks(session.id)).map((task) => ({ ...task, teamId: session.teamId })),
    messages: await sessionsService.listMessages(session.id),
  })));
  return {
    workspace,
    teams,
    sessions,
    needsYou,
    approvals,
    activity,
    skills,
    tasks: sessionData.flatMap((item) => item.tasks),
    messages: sessionData.flatMap((item) => item.messages),
  };
};

const memberFor = (team: Team | undefined, memberId: string | undefined) => {
  const member = team?.members.find((candidate) => candidate.id === memberId);
  return member ? { id: member.id, name: member.name, role: member.role } : undefined;
};

const skillIndicators = (task: Task, skills: ReadonlyMap<string, Skill>) => {
  const ids = [...new Set((task.skillAssignments ?? []).flatMap((assignment) => assignment.skillIds))];
  return ids.map((id) => ({ id, name: skills.get(id)?.name ?? id }));
};

const taskState = (
  task: Task,
  owner: ReturnType<typeof memberFor>,
  pending: readonly NeedsYouItem[],
  incompleteDependencies: number,
): string => {
  const attention = pending.find((item) => item.taskId === task.id && item.sessionId === task.sessionId);
  if (attention) {
    if (attention.kind === "approval") return `${owner?.name ?? "A Team Member"} is waiting for approval`;
    if (attention.kind === "review") return "Ready for your review";
    if (attention.kind === "failed-task") return `${owner?.name ?? "This Task"} stopped and needs recovery`;
    return `${owner?.name ?? "This Task"} is waiting for your guidance`;
  }
  if (incompleteDependencies > 0) return `${incompleteDependencies} prerequisite${incompleteDependencies === 1 ? "" : "s"} must finish first`;
  if (task.status === "in-progress") return `${owner?.name ?? "A Team Member"} is working on this`;
  if (task.status === "review") return "Ready for Team review";
  if (task.status === "done") return "Completed";
  return owner ? `Ready for ${owner.name}` : "Ready to be assigned";
};

const globalNeedsYou = (sources: TaskSources): GlobalNeedsYouItem[] => {
  const teams = new Map(sources.teams.map((team) => [team.id, team]));
  const tasks = new Map(sources.tasks.map((task) => [`${task.sessionId}:${task.id}`, task]));
  const approvals = new Map(sources.approvals.map((approval) => [approval.needsYouId, approval]));
  return [...sources.needsYou].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).flatMap((item) => {
    const team = teams.get(item.teamId);
    if (!team) return [];
    const member = memberFor(team, item.memberId) ?? { id: item.memberId, name: "Team Member", role: "Member" };
    const task = item.taskId ? tasks.get(`${item.sessionId}:${item.taskId}`) : undefined;
    const approval = approvals.get(item.id);
    const provider = approval?.providerId ?? team.members.find((candidate) => candidate.id === item.memberId)?.engine.provider;
    const target = targetFromApproval(approval);
    return [{
      id: item.id,
      kind: item.kind,
      who: member,
      what: item.title,
      why: shortText(item.detail),
      ...(item.risk ? { risk: item.risk } : {}),
      ...(item.action ? { action: actionLabel(item.action) } : {}),
      ...(target ? { target } : {}),
      team: { id: team.id, name: team.name },
      ...(task ? { task: { id: task.id, sessionId: task.sessionId, title: task.title } } : {}),
      ...(provider ? { provider: providerLabel(provider) } : {}),
      ...(approval?.recovery === "required" ? { recoveryRequired: true as const } : {}),
      suggestedAction: suggestedAction(item, approval),
      createdAt: item.createdAt,
    }];
  });
};

export const buildTasksData = async (workspaceRoot: string): Promise<TasksData> => {
  const sources = await loadSources(workspaceRoot);
  const teams = new Map(sources.teams.map((team) => [team.id, team]));
  const skills = new Map(sources.skills.map((skill) => [skill.id, skill]));
  const allTasks = new Map(sources.tasks.map((task) => [`${task.sessionId}:${task.id}`, task]));
  const tasks = sources.tasks.map((task): TaskBoardItem => {
    const team = teams.get(task.teamId);
    const owner = memberFor(team, task.ownerId);
    const incompleteDependencyCount = task.dependsOn.filter((id) => allTasks.get(`${task.sessionId}:${id}`)?.status !== "done").length;
    const taskNeeds = sources.needsYou.filter((item) => item.sessionId === task.sessionId && item.taskId === task.id);
    return {
      id: task.id,
      sessionId: task.sessionId,
      team: { id: task.teamId, name: team?.name ?? "Team" },
      title: task.title,
      description: task.description,
      status: task.status,
      ...(owner ? { owner } : {}),
      dependencyCount: task.dependsOn.length,
      incompleteDependencyCount,
      needsYou: task.needsYou || taskNeeds.length > 0,
      skills: skillIndicators(task, skills),
      currentState: taskState(task, owner, sources.needsYou, incompleteDependencyCount),
      updatedAt: task.updatedAt,
    };
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return {
    workspace: {
      id: sources.workspace.id,
      name: sources.workspace.name,
      createdAt: sources.workspace.createdAt,
      updatedAt: sources.workspace.updatedAt,
    },
    teams: sources.teams.map((team) => ({
      id: team.id,
      name: team.name,
      members: team.members.map((member) => ({ id: member.id, name: member.name, role: member.role })),
    })),
    tasks,
    needsYou: globalNeedsYou(sources),
    missionIssues: currentMissionIssues(sources.teams, sources.sessions),
  };
};

const eventText = (event: ActivityEvent, task: Task, team: Team): string | undefined => {
  const eventTaskId = typeof event.data["taskId"] === "string" ? event.data["taskId"] : undefined;
  if (eventTaskId !== task.id) return undefined;
  const ownerId = typeof event.data["ownerId"] === "string" ? event.data["ownerId"] : task.ownerId;
  const owner = memberFor(team, ownerId)?.name ?? "A Team Member";
  if (event.kind === "task.created") return "Manager created this Task";
  if (event.kind === "task.updated") {
    const status = typeof event.data["status"] === "string" ? event.data["status"] : task.status;
    if (status === "in-progress") return `${owner} started work`;
    if (status === "review") return `${owner} finished the work and moved it to Review`;
    if (status === "done") return `${owner} completed the Task`;
    return `The Task moved to ${status.replaceAll("-", " ")}`;
  }
  if (event.kind === "needs_you.created") return `${owner} requested your attention`;
  if (event.kind === "needs_you.resolved") return "You resolved the request";
  return undefined;
};

export const buildTaskDetail = async (workspaceRoot: string, sessionId: string, taskId: string) => {
  const sources = await loadSources(workspaceRoot);
  const task = sources.tasks.find((candidate) => candidate.sessionId === sessionId && candidate.id === taskId);
  if (!task) throw new Error("Task was not found");
  const team = sources.teams.find((candidate) => candidate.id === task.teamId);
  if (!team) throw new Error("Task Team was not found");
  const skills = new Map(sources.skills.map((skill) => [skill.id, skill]));
  const sessionTasks = sources.tasks.filter((candidate) => candidate.sessionId === sessionId);
  const messages = sources.messages.filter((message) => message.sessionId === sessionId && message.taskId === task.id);
  const approvals = sources.approvals.filter((approval) => approval.sessionId === sessionId && approval.taskId === task.id);
  const needsYou = sources.needsYou.filter((item) => item.sessionId === sessionId && item.taskId === task.id);
  const involvedIds = new Set<string>([
    ...(task.ownerId ? [task.ownerId] : []),
    ...task.handoffs.flatMap((handoff) => [handoff.fromMemberId, handoff.toMemberId].filter((id): id is string => Boolean(id))),
    ...messages.flatMap((message) => [message.fromMemberId, message.toMemberId]),
  ]);
  const history = [
    ...sources.activity.flatMap((event) => {
      const text = eventText(event, task, team);
      return text ? [{ id: event.id, timestamp: event.timestamp, text, tone: "neutral" as const }] : [];
    }),
    ...task.handoffs.map((handoff, index) => ({
      id: `handoff-${index}`,
      timestamp: handoff.createdAt,
      text: `${memberFor(team, handoff.fromMemberId)?.name ?? "Unassigned"} handed off to ${memberFor(team, handoff.toMemberId)?.name ?? "a Team Member"}${handoff.note ? ` — ${shortText(handoff.note, 140)}` : ""}`,
      tone: "handoff" as const,
    })),
    ...messages.map((message) => ({
      id: message.id,
      timestamp: message.createdAt,
      text: `${memberFor(team, message.fromMemberId)?.name ?? "A Team Member"} sent “${message.subject}” to ${memberFor(team, message.toMemberId)?.name ?? "a Team Member"}`,
      tone: "message" as const,
    })),
    ...approvals.flatMap((approval) => [
      { id: `${approval.id}-requested`, timestamp: approval.requestedAt, text: `${memberFor(team, approval.memberId)?.name ?? "A Team Member"} requested approval to ${actionLabel(approval.action).toLowerCase()}`, tone: "attention" as const },
      ...(approval.decidedAt ? [{ id: `${approval.id}-decided`, timestamp: approval.decidedAt, text: `You ${approval.status} the request`, tone: approval.status === "approved" ? "success" as const : "attention" as const }] : []),
    ]),
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return {
    id: task.id,
    sessionId: task.sessionId,
    title: task.title,
    description: task.description,
    status: task.status,
    team: { id: team.id, name: team.name },
    owner: memberFor(team, task.ownerId),
    dependencies: task.dependsOn.map((id) => {
      const dependency = sessionTasks.find((candidate) => candidate.id === id);
      return { id, title: dependency?.title ?? id, status: dependency?.status ?? "todo" };
    }),
    members: team.members.filter((member) => involvedIds.has(member.id)).map((member) => ({ id: member.id, name: member.name, role: member.role })),
    skills: (task.skillAssignments ?? []).flatMap((assignment) => assignment.skillIds.map((skillId) => ({
      member: memberFor(team, assignment.memberId) ?? { id: assignment.memberId, name: "Team Member", role: "Member" },
      skill: { id: skillId, name: skills.get(skillId)?.name ?? skillId },
    }))),
    handoffs: task.handoffs.map((handoff) => ({
      from: memberFor(team, handoff.fromMemberId),
      to: memberFor(team, handoff.toMemberId) ?? { id: handoff.toMemberId, name: "Team Member", role: "Member" },
      note: handoff.note,
      createdAt: handoff.createdAt,
    })),
    approvals: approvals.map((approval) => ({
      id: approval.id,
      status: approval.status,
      member: memberFor(team, approval.memberId),
      action: actionLabel(approval.action),
      risk: approval.risk,
      target: targetFromApproval(approval),
      summary: approval.summary,
      provider: providerLabel(approval.providerId),
      requestedAt: approval.requestedAt,
      decidedAt: approval.decidedAt,
      feedback: approval.feedback,
      outcome: outcomeLabel(approval),
      ...(approval.recovery === "required" ? { recoveryRequired: true as const } : {}),
    })),
    results: messages.map((message) => ({
      id: message.id,
      title: message.subject,
      summary: shortText(message.body),
      producedBy: memberFor(team, message.fromMemberId),
      createdAt: message.createdAt,
    })),
    needsYou: globalNeedsYou({ ...sources, needsYou }).filter((item) => item.task?.id === task.id && item.task.sessionId === sessionId),
    history,
  };
};
