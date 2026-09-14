import { createHash, randomUUID } from "node:crypto";

import {
  ApprovalService, canonicalizeWorkspaceRoot, prepareWorkspaceRoot, resolveWorkspaceRoot, WorkspaceService,
  workspaceError, WorkspaceStateError, type WorkspaceRoot,
} from "@daycrew/core";
import type { Workspace } from "@daycrew/shared";

import { AppConfigError, type AppConfigStore, type AppConfig } from "./app-config.js";

export const publicWorkspace = ({ rootPath: _rootPath, ...workspace }: Workspace) => workspace;

export interface WorkspaceContext {
  readonly root: WorkspaceRoot;
  readonly selectionId: string;
  readonly workspace: Workspace;
}

/** Selection changes are serialized. Requests retain an immutable snapshot. */
export class WorkspaceSelection {
  private root: string | undefined;
  private config: AppConfig = { version: 1, recentWorkspaces: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private configError: AppConfigError | undefined;
  selectionId = randomUUID();

  constructor(
    readonly store: AppConfigStore,
    private readonly options: { workspaceRoot?: string; discoveryStart?: string } = {},
  ) {}

  async start(): Promise<void> {
    try {
      this.config = await this.store.load();
    } catch (error) {
      this.configError = error as AppConfigError;
      return;
    }
    this.root = this.options.workspaceRoot ?? this.config.selectedWorkspace;
    if (this.root === undefined && this.options.discoveryStart !== undefined) {
      this.root = resolveWorkspaceRoot({ discoveryStart: this.options.discoveryStart })?.workspaceRoot;
    }
    if (this.root !== undefined) {
      try {
        const context = await this.context();
        await new ApprovalService(context.root).reconcileAfterRestart();
        if (this.options.workspaceRoot !== undefined) await this.select(context.root);
      } catch (error) {
        // Missing / inaccessible / uninitialized selection is recoverable in the UI.
        if (!(error instanceof WorkspaceStateError)) throw error;
      }
    }
  }

  async context(expected?: string): Promise<WorkspaceContext> {
    if (this.configError) throw this.configError;
    const selected = this.root;
    const selectionId = this.selectionId;
    if (expected !== undefined && expected !== selectionId) throw new WorkspaceStateError("WORKSPACE_CHANGED");
    if (selected === undefined) throw new WorkspaceStateError("WORKSPACE_NOT_SELECTED");
    const root = canonicalizeWorkspaceRoot(selected);
    const workspace = await new WorkspaceService(root).load();
    if (selectionId !== this.selectionId) throw new WorkspaceStateError("WORKSPACE_CHANGED");
    return { root, selectionId, workspace };
  }

  async app() {
    try {
      const context = await this.context();
      return { workspace: {
        selected: true, initialized: true, id: context.workspace.id, name: context.workspace.name,
        selectionId: context.selectionId,
        // Namespace UI-only preferences without exposing the filesystem path.
        key: createHash("sha256").update(context.root).digest("hex"),
      } };
    } catch (error) {
      if (error instanceof AppConfigError) throw error;
      const issue = workspaceError(error);
      return { workspace: { selected: this.root !== undefined, initialized: false, selectionId: this.selectionId },
        issue: { code: issue.code, message: issue.message } };
    }
  }

  recents() { return { selectedRoot: this.root, recentWorkspaces: this.config.recentWorkspaces }; }

  select(root: string | undefined, name?: string) {
    const operation = this.queue.then(async () => {
      // Re-read before any mutation; never overwrite an invalid/unreadable config.
      this.config = await this.store.load();
      this.configError = undefined;
      const candidate = root ?? this.root;
      if (candidate === undefined) throw new WorkspaceStateError("WORKSPACE_NOT_SELECTED");
      // Creating may bring the folder into existence; opening never does.
      const canonical = name === undefined ? canonicalizeWorkspaceRoot(candidate) : prepareWorkspaceRoot(candidate);
      const service = new WorkspaceService(canonical);
      if (name !== undefined) await service.create(name);
      const workspace = await service.load();
      await new ApprovalService(canonical).reconcileAfterRestart();
      const config: AppConfig = {
        version: 1, selectedWorkspace: canonical,
        ...(this.config.defaultAutonomy ? { defaultAutonomy: this.config.defaultAutonomy } : {}),
        recentWorkspaces: [
          { root: canonical, name: workspace.name, lastOpenedAt: new Date().toISOString() },
          ...this.config.recentWorkspaces.filter((item) => item.root !== canonical),
        ].slice(0, 10),
      };
      await this.store.save(config);
      this.config = config;
      this.root = canonical;
      this.selectionId = randomUUID();
      return this.app();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
