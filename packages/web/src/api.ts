export const providerErrorKind = (message: string): "restricted" | "unavailable" | "error" => {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission") || normalized.includes("restricted") || normalized.includes("denied")) {
    return "restricted";
  }
  if (
    normalized.includes("provider") ||
    normalized.includes("service") ||
    normalized.includes("connect") ||
    normalized.includes("offline")
  ) {
    return "unavailable";
  }
  return "error";
};
import type { AppState, Engine, EngineDetection, EngineModelCatalog, GoalResult, HomeData, OfficeData, SettingsData, Skill, SkillRecommendation, TaskDetailData, TasksData, Team, TeamDashboardData, WorkspaceIssueState, WorkspacePickerData } from "./types";

const workspaceMessages: Record<string, string> = {
  WORKSPACE_NOT_SELECTED: "No Workspace is open.",
  WORKSPACE_NOT_INITIALIZED: "This folder is not a DayCrew Workspace yet.",
  WORKSPACE_ALREADY_INITIALIZED: "This folder is already a DayCrew Workspace. Open it instead.",
  WORKSPACE_NOT_FOUND: "DayCrew can no longer find this Workspace.",
  WORKSPACE_STATE_INVALID: "This Workspace contains invalid state and needs attention.",
  WORKSPACE_PERMISSION_DENIED: "DayCrew cannot access this Workspace. Check this folder's permissions.",
  WORKSPACE_PATH_INVALID: "Choose an existing folder using its full absolute path.",
  WORKSPACE_CHANGED: "The open Workspace changed. Reload to continue.",
  APP_CONFIG_UNAVAILABLE: "DayCrew could not read or save its local app configuration. Check the configuration file and its permissions.",
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export type ConnectionState = "connecting" | "online" | "offline";

let connectionState: ConnectionState = "connecting";
const connectionListeners = new Set<() => void>();

const publishConnection = (next: ConnectionState) => {
  if (connectionState === next) return;
  connectionState = next;
  connectionListeners.forEach((listener) => listener());
};

/**
 * Every view polls the same local API, so reachability is a property of the app,
 * not of one screen. A single store keeps the header honest without each page
 * inventing its own idea of "offline".
 */
export const connectionStore = {
  getSnapshot: (): ConnectionState => connectionState,
  subscribe: (listener: () => void): (() => void) => {
    connectionListeners.add(listener);
    return () => { connectionListeners.delete(listener); };
  },
};

export const requestJson = async <T>(path: string, init?: RequestInit, selectionId?: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init, cache: "no-store",
      headers: {
        // Fastify rejects an empty body advertised as JSON before reaching the route.
        // Detection and stop actions intentionally have no request body.
        ...(init?.body != null ? { "Content-Type": "application/json" } : {}),
        ...(selectionId ? { "X-DayCrew-Workspace": selectionId } : {}),
        ...init?.headers,
      },
    });
  } catch {
    publishConnection("offline");
    throw new ApiError("DayCrew could not reach the local service.", 0);
  }
  // The local service answered. A 4xx is a rejected request, not a lost connection.
  publishConnection("online");
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof payload?.error?.code === "string" ? payload.error.code as string : undefined;
    // Do not trust a legacy backend's raw exception text.
    throw new ApiError(
      workspaceMessages[code ?? ""] ?? (code === "CONVERSATION_UNAVAILABLE" && typeof payload?.error?.message === "string" ? payload.error.message : "DayCrew could not complete this request. Check the supplied values and try again."),
      response.status, code,
    );
  }
  if (payload === null) {
    if (response.headers.get("content-type")?.includes("application/json")) return payload as T;
    throw new ApiError("DayCrew returned an unreadable response. Check the local service.", response.status);
  }
  return payload as T;
};

export const getApp = (): Promise<AppState> => requestJson("/api/app");
export const getWorkspacePicker = (): Promise<WorkspacePickerData> => requestJson("/api/app/workspaces");
export const openWorkspace = (root: string): Promise<AppState> =>
  requestJson("/api/app/workspace/open", { method: "POST", body: JSON.stringify({ root }) });
export const createWorkspace = (root: string, name: string): Promise<AppState> =>
  requestJson("/api/app/workspace/create", { method: "POST", body: JSON.stringify({ root, name }) });

export const listTeams = (selectionId: string): Promise<Team[]> => requestJson("/api/teams", undefined, selectionId);
export const listSkills = (selectionId: string): Promise<Skill[]> => requestJson("/api/skills", undefined, selectionId);
export const loadHome = (selectionId: string): Promise<HomeData> => requestJson("/api/home", undefined, selectionId);
export const loadOffice = (selectionId: string): Promise<OfficeData> => requestJson("/api/office", undefined, selectionId);
export const loadSettings = (selectionId: string): Promise<SettingsData> => requestJson("/api/settings", undefined, selectionId);
export const detectEngines = (selectionId: string): Promise<EngineDetection[]> => requestJson("/api/settings/engines/detect", { method: "POST" }, selectionId);
export const listEngines = (selectionId: string): Promise<Engine[]> => requestJson("/api/engines", undefined, selectionId);
export const listEngineModels = (engineId: string, selectionId: string): Promise<EngineModelCatalog> =>
  requestJson(`/api/engines/${encodeURIComponent(engineId)}/models`, undefined, selectionId);
export const updateDefaultAutonomy = (defaultAutonomy: Team["autonomy"], selectionId: string): Promise<{ defaultAutonomy: Team["autonomy"] }> =>
  requestJson("/api/settings/autonomy", { method: "PATCH", body: JSON.stringify({ defaultAutonomy }) }, selectionId);
export const loadTasksDashboard = (selectionId: string): Promise<TasksData> => requestJson("/api/tasks/dashboard", undefined, selectionId);
export const loadTaskDetail = (sessionId: string, taskId: string, selectionId: string): Promise<TaskDetailData> =>
  requestJson(`/api/tasks/${encodeURIComponent(sessionId)}/${encodeURIComponent(taskId)}`, undefined, selectionId);
export const resolveNeedsYou = (
  itemId: string,
  resolution: "approved" | "denied" | "resolved" | "dismissed",
  selectionId: string,
  feedback?: string,
): Promise<unknown> => requestJson(`/api/needs-you/${encodeURIComponent(itemId)}/resolve`, {
  method: "POST",
  body: JSON.stringify({ resolution, ...(feedback?.trim() ? { feedback: feedback.trim() } : {}) }),
}, selectionId);
export const createTeam = (name: string, selectionId: string): Promise<Team> =>
  requestJson("/api/teams", {
    method: "POST",
    body: JSON.stringify({ name, members: [{
      id: "manager", name: "Manager", role: "Manager", instructions: "Coordinate the team and work toward the user's goal.",
      isManager: true, engine: { mode: "auto" },
    }] }),
  }, selectionId);
export const installStarterTeam = (selectionId: string): Promise<Team> =>
  requestJson("/api/teams/install", { method: "POST", body: JSON.stringify({ packId: "software-development" }) }, selectionId);

export const loadTeamDashboard = async (
  requestedTeamId?: string, selectionId?: string,
): Promise<TeamDashboardData | WorkspaceIssueState | null> => {
  try {
    return await requestJson("/api/teams/dashboard" + (requestedTeamId ? "?teamId=" + encodeURIComponent(requestedTeamId) : ""), undefined, selectionId);
  } catch (error) {
    if (error instanceof ApiError && error.code?.startsWith("WORKSPACE_")) {
      return { kind: "workspace-issue", code: error.code as WorkspaceIssueState["code"], message: error.message };
    }
    throw error;
  }
};

export const startGoal = (teamId: string, goal: string, selectionId: string): Promise<GoalResult> =>
  requestJson("/api/teams/" + encodeURIComponent(teamId) + "/goals", {
    method: "POST", body: JSON.stringify({ goal }),
  }, selectionId);

export const getSkillRecommendations = (teamId: string, memberId: string, selectionId: string, taskId?: string, sessionId?: string): Promise<SkillRecommendation[]> => {
  const query = taskId ? `?taskId=${encodeURIComponent(taskId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}` : "";
  return requestJson(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/skill-recommendations${query}`, undefined, selectionId);
};

export const addPermanentSkill = (teamId: string, memberId: string, skillId: string, selectionId: string): Promise<unknown> =>
  requestJson(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/skills`, {
    method: "POST", body: JSON.stringify({ skillId }),
  }, selectionId);

export const removePermanentSkill = (teamId: string, memberId: string, skillId: string, selectionId: string): Promise<unknown> =>
  requestJson(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" }, selectionId);

export const addTemporarySkill = (taskId: string, sessionId: string, memberId: string, skillId: string, selectionId: string): Promise<unknown> =>
  requestJson(`/api/tasks/${encodeURIComponent(taskId)}/members/${encodeURIComponent(memberId)}/skills`, {
    method: "POST", body: JSON.stringify({ skillId, sessionId }),
  }, selectionId);

export const removeTemporarySkill = (taskId: string, sessionId: string, memberId: string, skillId: string, selectionId: string): Promise<unknown> =>
  requestJson(`/api/tasks/${encodeURIComponent(taskId)}/members/${encodeURIComponent(memberId)}/skills/${encodeURIComponent(skillId)}?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" }, selectionId);
