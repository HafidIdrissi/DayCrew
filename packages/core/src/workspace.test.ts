import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  KnowledgeService,
  MemoryService,
  TeamService,
  WorkspaceService,
  installTeamPack,
} from "./index.js";

const createdDirectories: string[] = [];
const now = () => "2026-09-09T12:00:00.000Z";

const createWorkspaceRoot = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "daycrew-m1-"));
  createdDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("M1 Workspace and Team behavior", () => {
  it("persists and updates a Workspace", async () => {
    const root = await createWorkspaceRoot();
    const service = new WorkspaceService(root, { now });

    const created = await service.create("Acme Studio");
    expect(created.id).toBe("acme-studio");
    await expect(service.load()).resolves.toEqual(created);
    await expect(service.updateName("Acme Product")).resolves.toMatchObject({
      id: "acme-studio",
      name: "Acme Product",
    });
  });

  it("creates a custom Team only when it has one Manager", async () => {
    const root = await createWorkspaceRoot();
    await new WorkspaceService(root, { now }).create("Acme");
    const teams = new TeamService(root, { now });

    await expect(
      teams.create({
        name: "Invalid Team",
        members: [
          {
            id: "developer",
            name: "Developer",
            role: "Implementation",
            instructions: "Build things.",
            isManager: false,
            engine: { mode: "auto" },
          },
        ],
      }),
    ).rejects.toThrow("exactly one Manager");
  });

  it("installs the bundled Team Pack and persists Knowledge and Member memory", async () => {
    const root = await createWorkspaceRoot();
    await new WorkspaceService(root, { now }).create("Acme");
    const packRoot = fileURLToPath(
      new URL("../../../team-packs/software-development/", import.meta.url),
    );

    const team = await installTeamPack(root, packRoot, { now });
    expect(team.members).toHaveLength(4);
    expect(team.members.filter((member) => member.isManager)).toHaveLength(1);
    expect(team.members.find((member) => member.id === "manager")?.instructions).toContain(
      "Understand the user's goal",
    );

    const knowledge = new KnowledgeService(root, { now, createId: () => "1" });
    await knowledge.add(team.id, "Coding standard", "Use strict TypeScript.");
    await expect(knowledge.list(team.id)).resolves.toMatchObject([
      { id: "knowledge-1", title: "Coding standard" },
    ]);

    const memory = new MemoryService(root, { now });
    await memory.remember(team.id, "developer", "The repository uses pnpm.");
    await expect(memory.load(team.id, "developer")).resolves.toMatchObject({
      notes: ["The repository uses pnpm."],
    });
  });
});
