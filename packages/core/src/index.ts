import type { ProviderAdapter } from "@daycrew/shared";

/** Dependencies supplied by a CLI/server composition root. */
export interface CoreDependencies {
  readonly providers: ReadonlyMap<string, ProviderAdapter>;
}

/** Dependencies remain provider-neutral; composition happens in the CLI/server. */
export const createCore = (dependencies: CoreDependencies): CoreDependencies =>
  dependencies;

export * from "./storage.js";
export * from "./workspace-errors.js";
export * from "./workspace-root.js";
export * from "./activity.js";
export * from "./approval.js";
export * from "./orchestrator.js";
export * from "./policy.js";
export * from "./session.js";
export * from "./team-pack.js";
export * from "./workspace.js";
