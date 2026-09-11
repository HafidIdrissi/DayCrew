export const WORKSPACE_MESSAGES = {
  WORKSPACE_NOT_SELECTED: "No Workspace is open.",
  WORKSPACE_NOT_INITIALIZED: "This folder is not a DayCrew Workspace yet.",
  WORKSPACE_NOT_FOUND: "DayCrew can no longer find this Workspace.",
  WORKSPACE_STATE_INVALID: "This Workspace contains invalid state and needs attention.",
  WORKSPACE_PERMISSION_DENIED: "DayCrew cannot access this Workspace. Check this folder's permissions.",
  WORKSPACE_PATH_INVALID: "Choose an existing folder using its full absolute path.",
  WORKSPACE_CHANGED: "The open Workspace changed. Reload to continue.",
} as const;
export type WorkspaceErrorCode = keyof typeof WORKSPACE_MESSAGES;
export const WORKSPACE_ERROR_CODES = Object.keys(WORKSPACE_MESSAGES) as WorkspaceErrorCode[];

export class WorkspaceStateError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    readonly workspaceRoot = "",
    options?: ErrorOptions,
  ) {
    super(WORKSPACE_MESSAGES[code], options);
    this.name = "WorkspaceStateError";
  }
}

export const isWorkspaceStateError = (error: unknown): error is WorkspaceStateError =>
  error instanceof WorkspaceStateError;

/** Keep technical causes server-side. The message is always safe for normal UI. */
export const workspaceError = (
  error: unknown,
  root = "",
  missing: WorkspaceErrorCode = "WORKSPACE_STATE_INVALID",
): WorkspaceStateError => {
  if (isWorkspaceStateError(error)) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return new WorkspaceStateError(
    code === "EACCES" || code === "EPERM" ? "WORKSPACE_PERMISSION_DENIED"
      : code === "ENOENT" || code === "ENOTDIR" ? missing : "WORKSPACE_STATE_INVALID",
    root,
    { cause: error },
  );
};