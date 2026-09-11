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
import type { AppState, GoalResult, Team, TeamDashboardData, WorkspaceIssueState, WorkspacePickerData } from "./types";

const workspaceMessages: Record<string, string> = {
  WORKSPACE_NOT_SELECTED: "No Workspace is open.",
  WORKSPACE_NOT_INITIALIZED: "This folder is not a DayCrew Workspace yet.",
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

export const requestJson = async <T>(path: string, init?: RequestInit, selectionId?: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init, cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(selectionId ? { "X-DayCrew-Workspace": selectionId } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("DayCrew could not reach the local service.", 0);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof payload?.error?.code === "string" ? payload.error.code as string : undefined;
    // Do not trust a legacy backend's raw exception text.
    throw new ApiError(
      workspaceMessages[code ?? ""] ?? "DayCrew could not complete this request. Check the supplied values and try again.",
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
