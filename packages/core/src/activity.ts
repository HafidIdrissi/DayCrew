import { workspaceError } from "./workspace-errors.js";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { ActivityEventSchema, type ActivityEvent, type ActivityKind } from "@daycrew/shared";

import { appendJsonLine, statePath } from "./storage.js";
import type { ServiceOptions } from "./workspace.js";

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw workspaceError(error);
  }
};

const writes = new Map<string, Promise<void>>();

export class ActivityService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(
    private readonly workspaceRoot: string,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async list(sessionId?: string): Promise<ActivityEvent[]> {
    const filePath = statePath(this.workspaceRoot, "activity.jsonl");
    if (!(await exists(filePath))) return [];
    const source = await readFile(filePath, "utf8");
    return source
      .split("\n")
      .filter(Boolean)
      .map((line) => ActivityEventSchema.parse(JSON.parse(line)))
      .filter((event) => sessionId === undefined || event.sessionId === sessionId);
  }

  async record(input: {
    workspaceId: string;
    teamId: string;
    sessionId: string;
    kind: ActivityKind;
    summary: string;
    data?: Record<string, unknown>;
  }): Promise<ActivityEvent> {
    const filePath = path.resolve(statePath(this.workspaceRoot, "activity.jsonl"));
    const previous = writes.get(filePath) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => pending);
    writes.set(filePath, queued);
    await previous;
    try {
      const events = await this.list();
      return await appendJsonLine(
        filePath,
        {
          id: `event-${this.createId()}`,
          sequence: (events.at(-1)?.sequence ?? 0) + 1,
          timestamp: this.now(),
          ...input,
          data: input.data ?? {},
        },
        ActivityEventSchema,
      );
    } finally {
      release();
      if (writes.get(filePath) === queued) writes.delete(filePath);
    }
  }
}
