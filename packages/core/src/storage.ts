import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { z } from "zod";

import { canonicalizeWorkspaceRoot } from "./workspace-root.js";
import { workspaceError, WorkspaceStateError } from "./workspace-errors.js";

export const DAYCREW_DIRECTORY = ".daycrew";

export const statePath = (workspaceRoot: string, ...segments: string[]): string => {
  const root = canonicalizeWorkspaceRoot(workspaceRoot);
  // Each argument is one filename component, including on Windows (ADS / devices).
  if (segments.some((part) => !part || part === "." || part === ".." ||
    [...part].some((char) => char.charCodeAt(0) < 32) || /[\\/:<>"|?*]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new WorkspaceStateError("WORKSPACE_STATE_INVALID", root);
  }
  let current: string = root;
  for (const segment of [DAYCREW_DIRECTORY, ...segments]) {
    current = path.join(current, segment);
    try {
      // Refuse symlinks/junctions anywhere in state, even when their target is local.
      if (lstatSync(current).isSymbolicLink()) throw new WorkspaceStateError("WORKSPACE_STATE_INVALID", root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw workspaceError(error, root);
    }
  }
  return current;
};

export const ensureDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
};

export const readJson = async <Schema extends z.ZodTypeAny>(
  filePath: string,
  schema: Schema,
): Promise<z.output<Schema>> => {
  try {
    const source = await readFile(filePath, "utf8");
    return schema.parse(JSON.parse(source));
  } catch (error) {
    throw workspaceError(error);
  }
};

export const writeJson = async <Schema extends z.ZodTypeAny>(
  filePath: string,
  value: unknown,
  schema: Schema,
): Promise<z.output<Schema>> => {
  const parsed = schema.parse(value);
  await ensureDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return parsed;
};

export const appendJsonLine = async <Schema extends z.ZodTypeAny>(
  filePath: string,
  value: unknown,
  schema: Schema,
): Promise<z.output<Schema>> => {
  const parsed = schema.parse(value);
  await ensureDirectory(path.dirname(filePath));
  const { appendFile } = await import("node:fs/promises");
  await appendFile(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
  return parsed;
};
