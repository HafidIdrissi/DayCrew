export type EngineSelection = {
  mode: "auto" | "manual";
  provider?: string;
  model?: string;
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
  pausedReason?: string;
  members: MemberRuntime[];
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
  handoffs: TaskHandoff[];
  needsYou: boolean;
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
  status: "pending" | "resolved" | "dismissed";
  createdAt: string;
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

export type TeamDashboardData = {
  workspace: Workspace;
  teams: Team[];
  team: Team;
  knowledge: KnowledgeEntry[];
  sessions: WorkSession[];
  tasks: Task[];
  needsYou: NeedsYouItem[];
  activity: ActivityEvent[];
};

export type WorkspaceIssueCode =
  | "WORKSPACE_NOT_SELECTED"
  | "WORKSPACE_PERMISSION_DENIED"
  | "WORKSPACE_PATH_INVALID"
  | "WORKSPACE_CHANGED"
  | "WORKSPACE_NOT_INITIALIZED"
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
