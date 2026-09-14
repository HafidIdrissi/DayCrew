import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";

import { workspaceError, WorkspaceStateError } from "./workspace-errors.js";

/** An existing, canonical user directory. Never the application installation by default. */
export type WorkspaceRoot = string & { readonly __workspaceRoot: unique symbol };
export type WorkspaceRootSource = "explicit" | "app-config" | "discovery";
export interface WorkspaceRootResolution {
  readonly workspaceRoot: WorkspaceRoot;
  readonly source: WorkspaceRootSource;
}

export const canonicalizeWorkspaceRoot = (candidate: string): WorkspaceRoot => {
  if (!candidate || !path.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new WorkspaceStateError("WORKSPACE_PATH_INVALID", candidate);
  }
  try {
    const root = realpathSync.native(candidate);
    if (!statSync(root).isDirectory()) throw new WorkspaceStateError("WORKSPACE_NOT_FOUND", root);
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
    return root as WorkspaceRoot;
  } catch (error) {
    throw workspaceError(error, candidate, "WORKSPACE_NOT_FOUND");
  }
};

/**
 * Resolves the folder chosen for a *new* Workspace. Unlike opening, the folder may
 * not exist yet: creating it is the point of Create Workspace, so it is created when
 * the path is usable. An existing folder is left untouched.
 */
export const prepareWorkspaceRoot = (candidate: string): WorkspaceRoot => {
  if (!candidate || !path.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new WorkspaceStateError("WORKSPACE_PATH_INVALID", candidate);
  }
  let existing: Stats | undefined;
  try {
    existing = statSync(candidate);
  } catch (error) {
    // Only "nothing is there yet" is ours to fix; ENOTDIR/EACCES keep their meaning.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw workspaceError(error, candidate, "WORKSPACE_PATH_INVALID");
    }
  }
  if (existing && !existing.isDirectory()) throw new WorkspaceStateError("WORKSPACE_PATH_INVALID", candidate);
  if (!existing) {
    try {
      mkdirSync(candidate, { recursive: true });
    } catch (error) {
      throw workspaceError(error, candidate, "WORKSPACE_PATH_INVALID");
    }
  }
  return canonicalizeWorkspaceRoot(candidate);
};

/** Discovery is opt-in, for CLI / explicitly requested developer workflows only. */
export const resolveWorkspaceRoot = (options: {
  readonly explicitRoot?: string;
  readonly selectedRoot?: string;
  readonly discoveryStart?: string;
} = {}): WorkspaceRootResolution | null => {
  if (options.explicitRoot !== undefined) {
    return { workspaceRoot: canonicalizeWorkspaceRoot(options.explicitRoot), source: "explicit" };
  }
  if (options.selectedRoot !== undefined) {
    return { workspaceRoot: canonicalizeWorkspaceRoot(options.selectedRoot), source: "app-config" };
  }
  if (options.discoveryStart === undefined) return null;
  let current: string = canonicalizeWorkspaceRoot(options.discoveryStart);
  while (true) {
    try {
      const marker = lstatSync(path.join(current, ".daycrew"));
      if (marker.isSymbolicLink() || !marker.isDirectory()) {
        throw new WorkspaceStateError("WORKSPACE_STATE_INVALID", current);
      }
      return { workspaceRoot: canonicalizeWorkspaceRoot(current), source: "discovery" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw workspaceError(error, current);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};