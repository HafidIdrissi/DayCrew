import { access, readdir } from "node:fs/promises";
import path from "node:path";

import {
  KnowledgeEntrySchema,
  MemberMemorySchema,
  TeamSchema,
  WorkspaceSchema,
  type KnowledgeEntry,
  type MemberMemory,
  type Team,
  type TeamMember,
  type Workspace,
} from "@daycrew/shared";
import { z } from "zod";

import { canonicalizeWorkspaceRoot } from "./workspace-root.js";

import { ensureDirectory, readJson, statePath, writeJson } from "./storage.js";
import { workspaceError, WorkspaceStateError } from "./workspace-errors.js";

export interface ServiceOptions {
  readonly now?: () => string;
  readonly createId?: () => string;
}

const defaults = {
  now: (): string => new Date().toISOString(),
  createId: (): string => crypto.randomUUID(),
};

const slugify = (value: string): string => {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error("Name must contain at least one letter or number");
  return slug;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw workspaceError(error);
  }
};

export class WorkspaceService {
  private readonly now: () => string;

  constructor(
    private readonly workspaceRoot: string,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? defaults.now;
  }

  async create(name: string): Promise<Workspace> {
    const configPath = statePath(this.workspaceRoot, "workspace.json");
    if (await fileExists(configPath)) {
      throw new Error(`A DayCrew Workspace already exists at ${path.resolve(this.workspaceRoot)}`);
    }
    const timestamp = this.now();
    const workspace = WorkspaceSchema.parse({
      id: slugify(name),
      name,
      rootPath: canonicalizeWorkspaceRoot(this.workspaceRoot),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await Promise.all([
      ensureDirectory(statePath(this.workspaceRoot, "teams")),
      ensureDirectory(statePath(this.workspaceRoot, "knowledge")),
      ensureDirectory(statePath(this.workspaceRoot, "memory")),
      ensureDirectory(statePath(this.workspaceRoot, "sessions")),
      ensureDirectory(statePath(this.workspaceRoot, "state")),
    ]);
    return writeJson(configPath, workspace, WorkspaceSchema);
  }

  async load(): Promise<Workspace> {
    const resolvedRoot = canonicalizeWorkspaceRoot(this.workspaceRoot);
    const configPath = statePath(resolvedRoot, "workspace.json");
    if (!(await fileExists(configPath))) {
      throw new WorkspaceStateError("WORKSPACE_NOT_INITIALIZED", resolvedRoot);
    }
    const workspace = await readJson(configPath, WorkspaceSchema);
    // A copied/moved workspace's old rootPath is metadata, never routing authority.
    return { ...workspace, rootPath: resolvedRoot };
  }

  async updateName(name: string): Promise<Workspace> {
    const current = await this.load();
    return writeJson(
      statePath(this.workspaceRoot, "workspace.json"),
      { ...current, name, updatedAt: this.now() },
      WorkspaceSchema,
    );
  }
}

export interface CreateTeamInput {
  readonly name: string;
  readonly description?: string;
  readonly autonomy?: Team["autonomy"];
  readonly members: TeamMember[];
  readonly id?: string;
}

export class TeamService {
  private readonly now: () => string;

  constructor(
    private readonly workspaceRoot: string,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? defaults.now;
  }

  async create(input: CreateTeamInput): Promise<Team> {
    const workspace = await new WorkspaceService(this.workspaceRoot).load();
    const id = input.id ?? slugify(input.name);
    const filePath = statePath(this.workspaceRoot, "teams", `${id}.json`);
    if (await fileExists(filePath)) throw new Error(`Team "${id}" already exists`);
    const timestamp = this.now();
    const team = TeamSchema.parse({
      id,
      workspaceId: workspace.id,
      name: input.name,
      description: input.description ?? "",
      autonomy: input.autonomy ?? "work-with-approval",
      members: input.members,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return writeJson(filePath, team, TeamSchema);
  }

  load(teamId: string): Promise<Team> {
    return readJson(statePath(this.workspaceRoot, "teams", `${teamId}.json`), TeamSchema);
  }

  async list(): Promise<Team[]> {
    await new WorkspaceService(this.workspaceRoot).load();
    const directory = statePath(this.workspaceRoot, "teams");
    await ensureDirectory(directory);
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map((name) => readJson(statePath(this.workspaceRoot, "teams", name), TeamSchema)));
  }

  async update(teamId: string, update: Partial<Pick<Team, "name" | "description" | "autonomy" | "members">>): Promise<Team> {
    const current = await this.load(teamId);
    const team = TeamSchema.parse({ ...current, ...update, id: current.id, updatedAt: this.now() });
    return writeJson(statePath(this.workspaceRoot, "teams", `${teamId}.json`), team, TeamSchema);
  }
}

const KnowledgeCollectionSchema = z.array(KnowledgeEntrySchema);

export class KnowledgeService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(
    private readonly workspaceRoot: string,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? defaults.now;
    this.createId = options.createId ?? defaults.createId;
  }

  async list(teamId: string): Promise<KnowledgeEntry[]> {
    const filePath = statePath(this.workspaceRoot, "knowledge", `${teamId}.json`);
    if (!(await fileExists(filePath))) return [];
    return readJson(filePath, KnowledgeCollectionSchema);
  }

  async add(teamId: string, title: string, content: string, source?: string): Promise<KnowledgeEntry> {
    await new TeamService(this.workspaceRoot).load(teamId);
    const entries = await this.list(teamId);
    const entry = KnowledgeEntrySchema.parse({
      id: `knowledge-${this.createId()}`,
      teamId,
      title,
      content,
      ...(source === undefined ? {} : { source }),
      updatedAt: this.now(),
    });
    await writeJson(
      statePath(this.workspaceRoot, "knowledge", `${teamId}.json`),
      [...entries, entry],
      KnowledgeCollectionSchema,
    );
    return entry;
  }
}

export class MemoryService {
  private readonly now: () => string;

  constructor(
    private readonly workspaceRoot: string,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? defaults.now;
  }

  async load(teamId: string, memberId: string): Promise<MemberMemory> {
    const filePath = statePath(this.workspaceRoot, "memory", teamId, `${memberId}.json`);
    if (!(await fileExists(filePath))) {
      return MemberMemorySchema.parse({ memberId, notes: [], updatedAt: this.now() });
    }
    return readJson(filePath, MemberMemorySchema);
  }

  async remember(teamId: string, memberId: string, note: string): Promise<MemberMemory> {
    const team = await new TeamService(this.workspaceRoot).load(teamId);
    if (!team.members.some((member) => member.id === memberId)) {
      throw new Error(`Member "${memberId}" does not belong to Team "${teamId}"`);
    }
    const current = await this.load(teamId, memberId);
    return writeJson(
      statePath(this.workspaceRoot, "memory", teamId, `${memberId}.json`),
      { ...current, notes: [...current.notes, note], updatedAt: this.now() },
      MemberMemorySchema,
    );
  }
}
