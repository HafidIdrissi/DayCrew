export type EngineSelection = {
  mode: "auto" | "manual";
  provider?: string;
  model?: string;
  reasoningEffort?: string;
};

export type Workspace = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type TeamMember = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  isManager: boolean;
  engine: EngineSelection;
  skillIds?: string[];
};

export type Team = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  autonomy: "assist" | "work-with-approval" | "autonomous";
  members: TeamMember[];
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeEntry = {
  id: string;
  teamId: string;
  title: string;
  content: string;
  source?: string;
  updatedAt: string;
};

export type MemberStatus =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "blocked-on-approval"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export type WorkSessionStatus =
  | "created"
  | "planning"
  | "working"
  | "waiting-for-you"
  | "waiting-for-human"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";

export type MemberRuntime = {
  memberId: string;
  status: MemberStatus;
  currentTaskId?: string;
  lastActiveAt?: string;
};

export type WorkSession = {
  id: string;
  workspaceId: string;
  teamId: string;
  goal: string;
  status: WorkSessionStatus;
  startedAt: string;
  completedAt?: string;
  summary?: string;
  failure?: WorkFailure;
  pausedReason?: string;
  members: MemberRuntime[];
};

export type WorkFailure = {
  kind: "engine-unavailable" | "engine-configuration" | "usage-limit" | "command-failed" | "permission-denied" | "invalid-response" | "unknown";
  message: string;
  resolution: string;
  retryable: boolean;
  engineId?: string;
};

export type MissionIssue = {
  sessionId: string;
  teamId: string;
  teamName: string;
  goal: string;
  failedAt: string;
  failure: WorkFailure;
};

export type TaskStatus = "todo" | "in-progress" | "review" | "done";

export type TaskHandoff = {
  fromMemberId?: string;
  toMemberId: string;
  note: string;
  createdAt: string;
};

export type Task = {
  id: string;
  sessionId: string;
  teamId: string;
  title: string;
  description: string;
  status: TaskStatus;
  ownerId?: string;
  previousOwnerId?: string;
  dependsOn: string[];
  handoffs: TaskHandoff[];
  needsYou: boolean;
  skillAssignments?: { memberId: string; skillIds: string[] }[];
  createdAt: string;
  updatedAt: string;
};

export type NeedsYouItem = {
  id: string;
  teamId: string;
  sessionId: string;
  memberId: string;
  kind: "approval" | "decision" | "blocker" | "failed-task" | "review";
  title: string;
  detail: string;
  taskId?: string;
  risk?: "low" | "medium" | "high" | "critical";
  action?: string;
  approvalId?: string;
  status: "pending" | "resolved" | "dismissed";
  createdAt: string;
  resolvedAt?: string;
  resolution?: "approved" | "denied" | "expired" | "resolved" | "dismissed";
  feedback?: string;
};

export type ActivityEvent = {
  id: string;
  sequence: number;
  timestamp: string;
  workspaceId: string;
  teamId: string;
  sessionId: string;
  kind: string;
  summary: string;
  data: Record<string, unknown>;
};

export type TeamDetail = { team: Team; knowledge: KnowledgeEntry[] };

export type GoalResult = {
  session: WorkSession;
  tasks: Task[];
};

export type Skill = {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  source: { type: string; reference?: string };
  instructions: string;
  tags: string[];
  requiredCapabilities: string[];
  recommendedTools: string[];
  compatibleRoles: string[];
  conflictsWith?: string[];
  createdAt?: string;
};

export type SkillCompatibility = {
  compatible: boolean;
  missingCapabilities: string[];
  reason?: string;
  resolution?: string;
};

export type MemberSkill = {
  skill: Skill;
  scope: "permanent" | "temporary";
  taskId?: string;
  compatibility: SkillCompatibility;
};

export type MemberSkillState = {
  memberId: string;
  assignments: MemberSkill[];
  availability: { skill: Skill; compatibility: SkillCompatibility }[];
};
export type SkillRecommendation = { skill: Skill; reason: string; compatibility: SkillCompatibility };

export type TeamDashboardData = {
  workspace: Workspace;
  teams: Team[];
  team: Team;
  knowledge: KnowledgeEntry[];
  sessions: WorkSession[];
  tasks: Task[];
  needsYou: NeedsYouItem[];
  activity: ActivityEvent[];
  skills: Skill[];
  memberSkills: MemberSkillState[];
  missionIssues: MissionIssue[];
};

export type HomeData = {
  workspace: Workspace;
  needsYou: {
    count: number;
    highlights: Array<{
      id: string;
      kind: "approval" | "decision" | "blocker";
      title: string;
      detail: string;
      teamId: string;
      teamName: string;
      createdAt: string;
    }>;
  };
  teams: Array<{
    id: string;
    name: string;
    demoMode: boolean;
    manager: { id: string; name: string };
    members: Array<{ id: string; name: string; role: string; isManager: boolean }>;
    workingMembers: number;
    currentObjective?: string;
    status: "working" | "needs-you" | "ready";
    progress?: { completed: number; total: number };
    recentResult?: { sessionId: string; goal: string; summary: string };
  }>;
  recentActivity: Array<{
    id: string;
    text: string;
    timestamp: string;
    tone: "success" | "attention" | "neutral";
    teamId: string;
  }>;
  missionIssues: MissionIssue[];
  dailyBrief: {
    teams: Array<{
      teamId: string;
      teamName: string;
      completedTasks: number;
      reviewTasks: number;
      activeTasks: number;
    }>;
    needsYou: number;
  };
};

export type TaskBoardItem = {
  id: string;
  sessionId: string;
  team: { id: string; name: string };
  title: string;
  description: string;
  status: TaskStatus;
  owner?: { id: string; name: string; role: string };
  dependencyCount: number;
  incompleteDependencyCount: number;
  needsYou: boolean;
  skills: { id: string; name: string }[];
  currentState: string;
  updatedAt: string;
};

export type GlobalNeedsYouItem = {
  id: string;
  kind: NeedsYouItem["kind"];
  who: { id: string; name: string; role: string };
  what: string;
  why: string;
  risk?: "low" | "medium" | "high" | "critical";
  action?: string;
  target?: string;
  team: { id: string; name: string };
  task?: { id: string; sessionId: string; title: string };
  provider?: string;
  recoveryRequired?: true;
  suggestedAction: string;
  createdAt: string;
};

export type TasksData = {
  workspace: Workspace;
  teams: Array<{
    id: string;
    name: string;
    members: { id: string; name: string; role: string }[];
  }>;
  tasks: TaskBoardItem[];
  needsYou: GlobalNeedsYouItem[];
  missionIssues: MissionIssue[];
};

export type TaskDetailData = {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: TaskStatus;
  team: { id: string; name: string };
  owner?: { id: string; name: string; role: string };
  dependencies: { id: string; title: string; status: TaskStatus }[];
  members: { id: string; name: string; role: string }[];
  skills: Array<{
    member: { id: string; name: string; role: string };
    skill: { id: string; name: string };
  }>;
  handoffs: Array<{
    from?: { id: string; name: string; role: string };
    to: { id: string; name: string; role: string };
    note: string;
    createdAt: string;
  }>;
  approvals: Array<{
    id: string;
    status: "pending" | "approved" | "denied" | "expired";
    member?: { id: string; name: string; role: string };
    action: string;
    risk: "low" | "medium" | "high" | "critical";
    target?: string;
    summary: string;
    provider: string;
    requestedAt: string;
    decidedAt?: string;
    feedback?: string;
    outcome?: string;
    recoveryRequired?: true;
  }>;
  results: Array<{
    id: string;
    title: string;
    summary: string;
    producedBy?: { id: string; name: string; role: string };
    createdAt: string;
  }>;
  needsYou: GlobalNeedsYouItem[];
  history: Array<{
    id: string;
    timestamp: string;
    text: string;
    tone: "neutral" | "handoff" | "message" | "attention" | "success";
  }>;
};

export type WorkspaceIssueCode =
  | "WORKSPACE_NOT_SELECTED"
  | "WORKSPACE_PERMISSION_DENIED"
  | "WORKSPACE_PATH_INVALID"
  | "WORKSPACE_CHANGED"
  | "WORKSPACE_NOT_INITIALIZED"
  | "WORKSPACE_ALREADY_INITIALIZED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_STATE_INVALID";

export type WorkspaceIssueState = {
  kind: "workspace-issue";
  code: WorkspaceIssueCode;
  message: string;
};

export type AppState = {
  workspace: { selected: boolean; initialized: boolean; selectionId: string; id?: string; name?: string; key?: string };
  issue?: { code: WorkspaceIssueCode; message: string };
};

export type WorkspacePickerData = {
  selectedRoot?: string;
  recentWorkspaces: { root: string; name: string; lastOpenedAt: string }[];
};

/**
 * Readiness has three independent parts, each of which can be unknown. `undefined`
 * means DayCrew could not determine it — never render that as "missing".
 */
export type EngineDetection = {
  id: string;
  installed?: boolean;
  authenticated?: boolean;
  ready: boolean;
  version?: string;
  message: string;
};

export type EngineModel = { id: string; label: string; description?: string; reasoningEfforts?: string[] };

export type EngineSetup = {
  install: { platform: string; command: string }[];
  signInCommand?: string;
  authCheck: string;
  authDetectable: boolean;
  notes: string[];
};

/** Mirror of the shared AI Engine registry entry, as served by the local API. */
export type Engine = {
  id: string;
  name: string;
  binary?: string;
  kind: "cli" | "simulated";
  classification: "production-ready" | "read-only-preview" | "restricted-experimental" | "simulated";
  autoEligible: boolean;
  modelDiscovery: "dynamic" | "static" | "unsupported";
  allowsCustomModelId: boolean;
  models: EngineModel[];
  modelsVerifiedAt: string;
  docsUrl: string;
  capabilities: string[];
  limitations: string[];
  setup?: EngineSetup;
};

export type EngineModelCatalog = {
  engineId: string;
  models: EngineModel[];
  source: "live" | "catalog";
  allowsCustomModelId: boolean;
  warning?: string;
};

export type ReadinessState = "ready" | "signed-out" | "not-installed" | "unknown";

export const readinessState = (detection?: EngineDetection): ReadinessState => {
  if (!detection) return "unknown";
  if (detection.ready) return "ready";
  if (detection.installed === false) return "not-installed";
  if (detection.installed === true && detection.authenticated === false) return "signed-out";
  return "unknown";
};

export type SettingsData = {
  workspace: Workspace;
  needsYouCount: number;
  recentWorkspaces: { root: string; name: string; lastOpenedAt: string }[];
  preferences: { defaultAutonomy: Team["autonomy"] };
  engines: Engine[];
  extensions: { skills: number; teamPacks: { id: string; name: string }[] };
  diagnostics: { version: string; stateDirectory: string; persistence: string; api: string };
};

export type OfficeMember = {
  id: string;
  name: string;
  role: string;
  isManager: boolean;
  status: MemberStatus;
  currentTask?: string;
  currentTaskId?: string;
  engine: EngineSelection;
  skillCount: number;
  needsYouCount: number;
  lastActiveAt?: string;
};

export type OfficeTeam = {
  id: string;
  name: string;
  autonomy: Team["autonomy"];
  demoMode: boolean;
  goal?: string;
  sessionId?: string;
  sessionStatus?: WorkSessionStatus;
  members: OfficeMember[];
};

export type OfficeData = {
  workspace: Workspace;
  needsYouCount: number;
  teams: OfficeTeam[];
  missionIssues: MissionIssue[];
};
