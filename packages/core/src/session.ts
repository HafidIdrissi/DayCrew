import { workspaceError } from "./workspace-errors.js";
import { access, readdir } from "node:fs/promises";

import {
  MessageSchema,
  NeedsYouItemSchema,
  TaskSchema,
  WorkSessionSchema,
  type Message,
  type NeedsYouItem,
  type Task,
  type TaskStatus,
  type WorkSession,
} from "@daycrew/shared";
import { z } from "zod";

import { ActivityService } from "./activity.js";
import { ensureDirectory, readJson, statePath, writeJson } from "./storage.js";
import { TeamService, WorkspaceService, type ServiceOptions } from "./workspace.js";

const TaskCollectionSchema = z.array(TaskSchema);
const MessageCollectionSchema = z.array(MessageSchema);
const NeedsYouCollectionSchema = z.array(NeedsYouItemSchema);

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw workspaceError(error);
  }
};

const allowedTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ["in-progress"],
  "in-progress": ["todo", "review"],
  review: ["in-progress", "done"],
  done: [],
};

export interface CreateTaskInput {
  readonly id?: string;
  readonly title: string;
  readonly description?: string;
  readonly ownerId?: string;
  readonly dependsOn?: readonly string[];
  readonly needsYou?: boolean;
}

export interface CreateNeedsYouInput {
  readonly memberId: string;
  readonly kind: NeedsYouItem["kind"];
  readonly title: string;
  readonly detail: string;
  readonly taskId?: string;
  readonly risk?: NeedsYouItem["risk"];
  readonly action?: NeedsYouItem["action"];
  readonly approvalId?: string;
}

export class WorkSessionService {
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly activity: ActivityService;

  constructor(
    private readonly workspaceRoot: string,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.activity = new ActivityService(workspaceRoot, options);
  }

  private sessionPath(sessionId: string, fileName = "session.json"): string {
    return statePath(this.workspaceRoot, "sessions", sessionId, fileName);
  }

  async create(teamId: string, goal: string): Promise<WorkSession> {
    const workspace = await new WorkspaceService(this.workspaceRoot).load();
    const team = await new TeamService(this.workspaceRoot).load(teamId);
    const supersededFailures = (await this.listNeedsYou("pending"))
      .filter((item) => item.teamId === teamId && item.kind === "failed-task");
    await Promise.all(supersededFailures.map((item) => this.resolveNeedsYou(item.id, "dismissed", "A newer Mission was started.")));
    const id = `session-${this.createId()}`;
    const session = await writeJson(
      this.sessionPath(id),
      {
        id,
        workspaceId: workspace.id,
        teamId,
        goal,
        status: "created",
        startedAt: this.now(),
        usage: {},
        members: team.members.map((member) => ({ memberId: member.id, status: "idle" })),
        limits: {},
        turnCount: 0,
      },
      WorkSessionSchema,
    );
    await this.activity.record({
      workspaceId: workspace.id,
      teamId,
      sessionId: id,
      kind: "session.started",
      summary: `Started work on: ${goal}`,
    });
    return session;
  }

  load(sessionId: string): Promise<WorkSession> {
    return readJson(this.sessionPath(sessionId), WorkSessionSchema);
  }

  async list(): Promise<WorkSession[]> {
    const directory = statePath(this.workspaceRoot, "sessions");
    await ensureDirectory(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    return Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readJson(this.sessionPath(entry.name), WorkSessionSchema)),
    );
  }

  async update(
    sessionId: string,
    update: Partial<Pick<WorkSession, "status" | "summary" | "failure" | "pausedReason" | "completedAt" | "usage" | "members" | "turnCount">>,
  ): Promise<WorkSession> {
    const current = await this.load(sessionId);
    const next = await writeJson(
      this.sessionPath(sessionId),
      { ...current, ...update, id: current.id },
      WorkSessionSchema,
    );
    if (update.status !== undefined && update.status !== current.status) {
      await this.activity.record({
        workspaceId: current.workspaceId,
        teamId: current.teamId,
        sessionId,
        kind: "session.status_changed",
        summary: `Work status changed to ${update.status}`,
        data: { from: current.status, to: update.status },
      });
    }
    return next;
  }

  async setMemberStatus(
    sessionId: string,
    memberId: string,
    status: WorkSession["members"][number]["status"],
    currentTaskId?: string,
  ): Promise<WorkSession> {
    const session = await this.load(sessionId);
    if (!session.members.some((member) => member.memberId === memberId)) {
      throw new Error(`Member "${memberId}" does not belong to this work session`);
    }
    const members = session.members.map((member) =>
      member.memberId === memberId
        ? {
            memberId,
            status,
            ...(currentTaskId === undefined ? {} : { currentTaskId }),
            lastActiveAt: this.now(),
          }
        : member,
    );
    const updated = await this.update(sessionId, { members });
    await this.activity.record({
      workspaceId: session.workspaceId,
      teamId: session.teamId,
      sessionId,
      kind: "member.status_changed",
      summary: `${memberId} is ${status}`,
      data: { memberId, status, ...(currentTaskId === undefined ? {} : { currentTaskId }) },
    });
    return updated;
  }

  async pause(sessionId: string, reason = "Paused by the user"): Promise<WorkSession> {
    const session = await this.load(sessionId);
    if (["completed", "failed", "cancelled"].includes(session.status)) {
      throw new Error(`Cannot pause a ${session.status} work session`);
    }
    return this.update(sessionId, { status: "waiting-for-you", pausedReason: reason });
  }

  async resume(sessionId: string): Promise<WorkSession> {
    const session = await this.load(sessionId);
    if (session.status !== "waiting-for-you") throw new Error("Work session is not paused");
    return this.update(sessionId, { status: "working", pausedReason: undefined });
  }

  async listTasks(sessionId: string): Promise<Task[]> {
    await this.load(sessionId);
    const filePath = this.sessionPath(sessionId, "tasks.json");
    if (!(await exists(filePath))) return [];
    return readJson(filePath, TaskCollectionSchema);
  }

  async createTask(sessionId: string, input: CreateTaskInput): Promise<Task> {
    const session = await this.load(sessionId);
    const team = await new TeamService(this.workspaceRoot).load(session.teamId);
    if (input.ownerId && !team.members.some((member) => member.id === input.ownerId)) {
      throw new Error(`Unknown task owner "${input.ownerId}"`);
    }
    const tasks = await this.listTasks(sessionId);
    const dependsOn = [...(input.dependsOn ?? [])];
    for (const dependency of dependsOn) {
      if (!tasks.some((task) => task.id === dependency)) {
        throw new Error(`Unknown task dependency "${dependency}"`);
      }
    }
    const timestamp = this.now();
    const id = input.id ?? `task-${this.createId()}`;
    if (tasks.some((task) => task.id === id)) throw new Error(`Task "${id}" already exists`);
    const task = TaskSchema.parse({
      id,
      sessionId,
      title: input.title,
      description: input.description ?? "",
      ownerId: input.ownerId,
      dependsOn,
      needsYou: input.needsYou ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await writeJson(this.sessionPath(sessionId, "tasks.json"), [...tasks, task], TaskCollectionSchema);
    await this.activity.record({
      workspaceId: session.workspaceId,
      teamId: session.teamId,
      sessionId,
      kind: "task.created",
      summary: `Created task: ${task.title}`,
      data: { taskId: task.id, ownerId: task.ownerId, dependsOn: task.dependsOn },
    });
    return task;
  }

  async updateTask(
    sessionId: string,
    taskId: string,
    update: Partial<Pick<Task, "title" | "description" | "status" | "ownerId" | "dependsOn" | "needsYou" | "skillAssignments">> & { handoffNote?: string },
  ): Promise<Task> {
    const session = await this.load(sessionId);
    const team = await new TeamService(this.workspaceRoot).load(session.teamId);
    const tasks = await this.listTasks(sessionId);
    const current = tasks.find((task) => task.id === taskId);
    if (!current) throw new Error(`Task "${taskId}" was not found`);
    if (update.ownerId && !team.members.some((member) => member.id === update.ownerId)) {
      throw new Error(`Unknown task owner "${update.ownerId}"`);
    }
    if (update.status && update.status !== current.status) {
      if (!allowedTransitions[current.status].includes(update.status)) {
        throw new Error(`Invalid task transition from ${current.status} to ${update.status}`);
      }
      if (["in-progress", "review", "done"].includes(update.status)) {
        const dependencies = tasks.filter((task) => current.dependsOn.includes(task.id));
        if (dependencies.some((task) => task.status !== "done")) {
          throw new Error(`Task "${taskId}" has incomplete dependencies`);
        }
      }
    }
    const dependsOn = update.dependsOn ?? current.dependsOn;
    if (dependsOn.includes(taskId)) throw new Error("A task cannot depend on itself");
    for (const dependency of dependsOn) {
      if (!tasks.some((task) => task.id === dependency)) {
        throw new Error(`Unknown task dependency "${dependency}"`);
      }
    }
    const dependencyGraph = new Map(
      tasks.map((task) => [task.id, task.id === taskId ? dependsOn : task.dependsOn] as const),
    );
    const reachesTask = (candidateId: string, visited = new Set<string>()): boolean => {
      if (candidateId === taskId) return true;
      if (visited.has(candidateId)) return false;
      visited.add(candidateId);
      return (dependencyGraph.get(candidateId) ?? []).some((dependency) =>
        reachesTask(dependency, visited),
      );
    };
    if (dependsOn.some((dependency) => reachesTask(dependency))) {
      throw new Error("Task dependencies cannot contain a cycle");
    }
    const ownerChanged = update.ownerId !== undefined && update.ownerId !== current.ownerId;
    const handoffs = ownerChanged
      ? [
          ...current.handoffs,
          {
            ...(current.ownerId === undefined ? {} : { fromMemberId: current.ownerId }),
            toMemberId: update.ownerId!,
            note: update.handoffNote ?? "",
            createdAt: this.now(),
          },
        ]
      : current.handoffs;
    const { handoffNote: _handoffNote, ...persistedUpdate } = update;
    const next = TaskSchema.parse({
      ...current,
      ...persistedUpdate,
      id: current.id,
      previousOwnerId: ownerChanged ? current.ownerId : current.previousOwnerId,
      handoffs,
      updatedAt: this.now(),
    });
    await writeJson(
      this.sessionPath(sessionId, "tasks.json"),
      tasks.map((task) => (task.id === taskId ? next : task)),
      TaskCollectionSchema,
    );
    await this.activity.record({
      workspaceId: session.workspaceId,
      teamId: session.teamId,
      sessionId,
      kind: ownerChanged ? "task.handed_off" : "task.updated",
      summary: ownerChanged
        ? `Handed ${next.title} to ${next.ownerId}`
        : `Updated ${next.title} to ${next.status}`,
      data: { taskId, status: next.status, ownerId: next.ownerId },
    });
    return next;
  }

  async sendMessage(
    sessionId: string,
    input: Omit<Message, "id" | "sessionId" | "createdAt">,
  ): Promise<Message> {
    const session = await this.load(sessionId);
    const team = await new TeamService(this.workspaceRoot).load(session.teamId);
    for (const memberId of [input.fromMemberId, input.toMemberId]) {
      if (!team.members.some((member) => member.id === memberId)) {
        throw new Error(`Unknown message participant "${memberId}"`);
      }
    }
    const messages = await this.listMessages(sessionId);
    const message = MessageSchema.parse({
      id: `message-${this.createId()}`,
      sessionId,
      ...input,
      createdAt: this.now(),
    });
    await writeJson(
      this.sessionPath(sessionId, "messages.json"),
      [...messages, message],
      MessageCollectionSchema,
    );
    await this.activity.record({
      workspaceId: session.workspaceId,
      teamId: session.teamId,
      sessionId,
      kind: "message.sent",
      summary: `${input.fromMemberId} sent ${input.subject} to ${input.toMemberId}`,
      data: { messageId: message.id, fromMemberId: input.fromMemberId, toMemberId: input.toMemberId },
    });
    return message;
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    await this.load(sessionId);
    const filePath = this.sessionPath(sessionId, "messages.json");
    if (!(await exists(filePath))) return [];
    return readJson(filePath, MessageCollectionSchema);
  }

  async createNeedsYou(sessionId: string, input: CreateNeedsYouInput): Promise<NeedsYouItem> {
    const session = await this.load(sessionId);
    const items = await this.listNeedsYou();
    const item = NeedsYouItemSchema.parse({
      id: `needs-${this.createId()}`,
      workspaceId: session.workspaceId,
      teamId: session.teamId,
      sessionId,
      ...input,
      createdAt: this.now(),
    });
    await writeJson(statePath(this.workspaceRoot, "needs-you.json"), [...items, item], NeedsYouCollectionSchema);
    await this.activity.record({
      workspaceId: session.workspaceId,
      teamId: session.teamId,
      sessionId,
      kind: "needs_you.created",
      summary: item.title,
      data: { needsYouId: item.id, kind: item.kind, taskId: item.taskId },
    });
    return item;
  }

  async listNeedsYou(status?: NeedsYouItem["status"]): Promise<NeedsYouItem[]> {
    const filePath = statePath(this.workspaceRoot, "needs-you.json");
    if (!(await exists(filePath))) return [];
    const items = await readJson(filePath, NeedsYouCollectionSchema);
    return status === undefined ? items : items.filter((item) => item.status === status);
  }

  async resolveNeedsYou(
    itemId: string,
    resolution: NonNullable<NeedsYouItem["resolution"]>,
    feedback?: string,
  ): Promise<NeedsYouItem> {
    const items = await this.listNeedsYou();
    const current = items.find((item) => item.id === itemId);
    if (!current) throw new Error(`Needs You item "${itemId}" was not found`);
    if (current.status !== "pending") throw new Error("Needs You item is already resolved");
    const updated = NeedsYouItemSchema.parse({
      ...current,
      status: resolution === "dismissed" ? "dismissed" : "resolved",
      resolution,
      ...(feedback === undefined ? {} : { feedback }),
      resolvedAt: this.now(),
    });
    await writeJson(
      statePath(this.workspaceRoot, "needs-you.json"),
      items.map((item) => (item.id === itemId ? updated : item)),
      NeedsYouCollectionSchema,
    );
    await this.activity.record({
      workspaceId: current.workspaceId,
      teamId: current.teamId,
      sessionId: current.sessionId,
      kind: "needs_you.resolved",
      summary: `${current.title}: ${resolution}`,
      data: { needsYouId: itemId, resolution, feedback },
    });
    return updated;
  }
}
