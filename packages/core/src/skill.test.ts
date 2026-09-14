import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProviderCapabilities, Team } from "@daycrew/shared";
import { MockProvider } from "@daycrew/providers";
import { afterEach, describe, expect, it } from "vitest";

import {
  SkillService,
  TeamService,
  WorkSessionService,
  WorkspaceService,
  assessSkillCompatibility,
  loadSkillDirectory,
  ManagerOrchestrator,
} from "./index.js";

const directories: string[] = [];
const now = () => "2026-09-11T10:00:00.000Z";
let id = 0;
const createId = () => String(++id);
const allCapabilities: ProviderCapabilities = {
  streaming: true, toolUse: true, approvals: true, interruption: true, resume: true,
  skillCapabilities: ["filesystem.read", "filesystem.write", "command.run", "browser", "network"],
};
const noTools: ProviderCapabilities = {
  streaming: true, toolUse: false, approvals: false, interruption: true, resume: false,
  skillCapabilities: [],
};

const setup = async (): Promise<{ root: string; team: Team }> => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-skills-"));
  directories.push(root);
  await new WorkspaceService(root, { now }).create("Skills");
  const team = await new TeamService(root, { now }).create({
    id: "engineering",
    name: "Engineering",
    members: [
      { id: "manager", name: "Manager", role: "Manager", instructions: "Coordinate the Team.", isManager: true, engine: { mode: "auto" } },
      { id: "sam", name: "Sam", role: "QA Engineer", instructions: "Verify the work.", isManager: false, engine: { mode: "auto" } },
    ],
  });
  return { root, team };
};

const writeLocalSkill = async (root: string, manifest: Record<string, unknown>, instructions = "Follow the local review checklist."): Promise<string> => {
  const skillRoot = path.join(root, ".daycrew", "skills", String(manifest["id"]));
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "skill.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(skillRoot, "instructions.md"), instructions, "utf8");
  return skillRoot;
};

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: "local-review",
  name: "Local Review",
  description: "Apply the Workspace's focused review process.",
  version: "1.0.0",
  tags: ["review"],
  requiredCapabilities: [],
  recommendedTools: [],
  compatibleRoles: ["QA Engineer"],
  ...overrides,
});

afterEach(async () => {
  id = 0;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Skill loading and persistence", () => {
  it("loads a valid Workspace Skill and rejects an invalid schema", async () => {
    const { root } = await setup();
    const skillRoot = await writeLocalSkill(root, manifest());
    expect(await loadSkillDirectory(skillRoot)).toMatchObject({
      id: "local-review", source: { type: "workspace" }, instructions: "Follow the local review checklist.",
    });
    await writeFile(path.join(skillRoot, "skill.json"), JSON.stringify(manifest({ version: "latest" })), "utf8");
    await expect(new SkillService(root).list()).rejects.toThrow();
  });

  it("rejects a Skill manifest path traversal attempt", async () => {
    const { root } = await setup();
    const skillRoot = await writeLocalSkill(root, manifest({ instructionsFile: "../outside.md" }));
    await expect(loadSkillDirectory(skillRoot)).rejects.toThrow();
  });

  it("persists permanent Skills, prevents duplicates, removes them, and survives reload", async () => {
    const { root, team } = await setup();
    await new SkillService(root).addPermanent(team.id, "sam", "documentation");
    await new SkillService(root).addPermanent(team.id, "sam", "documentation");
    expect((await new TeamService(root).load(team.id)).members.find((member) => member.id === "sam")?.skillIds).toEqual(["documentation"]);
    expect(JSON.parse(await readFile(path.join(root, ".daycrew", "teams", `${team.id}.json`), "utf8"))).toMatchObject({
      members: expect.arrayContaining([expect.objectContaining({ id: "sam", skillIds: ["documentation"] })]),
    });
    await new SkillService(root).removePermanent(team.id, "sam", "documentation");
    expect((await new TeamService(root).load(team.id)).members.find((member) => member.id === "sam")?.skillIds).toEqual([]);
  });

  it("keeps temporary Task Skills separate from permanent Member Skills and removes them", async () => {
    const { root, team } = await setup();
    const sessions = new WorkSessionService(root, { now, createId });
    const session = await sessions.create(team.id, "Review the UI");
    const task = await sessions.createTask(session.id, { id: "task-42", title: "Review", ownerId: "sam" });
    const skills = new SkillService(root);
    await skills.addTemporary(task.id, "sam", "accessibility-review");
    await skills.addTemporary(task.id, "sam", "accessibility-review");
    expect((await sessions.listTasks(session.id))[0]?.skillAssignments).toEqual([{ memberId: "sam", skillIds: ["accessibility-review"] }]);
    expect((await new TeamService(root).load(team.id)).members.find((member) => member.id === "sam")?.skillIds).toBeUndefined();
    await skills.removeTemporary(task.id, "sam", "accessibility-review");
    expect((await sessions.listTasks(session.id))[0]?.skillAssignments).toEqual([]);
  });

  it("never leaks Workspace-local Skills or assignments across Workspaces", async () => {
    const first = await setup();
    const second = await setup();
    await writeLocalSkill(first.root, manifest());
    await new SkillService(first.root).addPermanent(first.team.id, "sam", "local-review");
    expect((await new SkillService(first.root).list()).some((skill) => skill.id === "local-review")).toBe(true);
    expect((await new SkillService(second.root).list()).some((skill) => skill.id === "local-review")).toBe(false);
    expect((await new TeamService(second.root).load(second.team.id)).members.find((member) => member.id === "sam")?.skillIds).toBeUndefined();
  });
});

describe("Skill context and security", () => {
  it("logs a declared conflict and prefers an explicit task-scoped Skill", async () => {
    const { root, team } = await setup();
    await writeLocalSkill(root, manifest({ id: "local-permanent", name: "Local Permanent", conflictsWith: ["local-task"] }), "Permanent instructions.");
    await writeLocalSkill(root, manifest({ id: "local-task", name: "Local Task", conflictsWith: ["local-permanent"] }), "Task instructions.");
    const skills = new SkillService(root);
    await skills.addPermanent(team.id, "sam", "local-permanent");
    const sessions = new WorkSessionService(root, { now, createId });
    const session = await sessions.create(team.id, "Resolve the conflict");
    const task = await sessions.createTask(session.id, { id: "task-conflict", title: "Conflict", ownerId: "sam" });
    await skills.addTemporary(task.id, "sam", "local-task", session.id);
    const context = await skills.effectiveContext(team.id, "sam", task.id, allCapabilities, session.id);
    expect(context.skills.map((skill) => skill.id)).toEqual(["local-task"]);
    expect(context.issues).toEqual([expect.stringContaining("took precedence")]);
    expect(context.instructions).toContain("Task instructions.");
    expect(context.instructions).not.toContain("Permanent instructions.");
  });

  it("passes the effective Skill context to the provider without rewriting the Role", async () => {
    const { root, team } = await setup();
    await new SkillService(root).addPermanent(team.id, "manager", "documentation");
    const provider = new MockProvider();
    await new ManagerOrchestrator(root, { providers: new Map([[provider.id, provider]]) }, { now, createId }).runGoal(team.id, "Write a README section");
    expect(provider.specs[0]?.instructions).toContain("## Skill: Documentation (permanent)");
    expect(provider.specs[0]?.instructions).toContain("Write for a reader");
    expect((await new TeamService(root).load(team.id)).members.find((member) => member.id === "manager")?.instructions).toBe("Coordinate the Team.");
  });

  it("injects base, permanent, and task instructions once in deterministic scope order", async () => {
    const { root, team } = await setup();
    const skills = new SkillService(root);
    await skills.addPermanent(team.id, "sam", "documentation");
    const sessions = new WorkSessionService(root, { now, createId });
    const session = await sessions.create(team.id, "Document the review");
    const task = await sessions.createTask(session.id, { id: "task-context", title: "Document", ownerId: "sam" });
    await skills.addTemporary(task.id, "sam", "documentation");
    await skills.addTemporary(task.id, "sam", "api-design");
    const context = await skills.effectiveContext(team.id, "sam", task.id, allCapabilities);
    expect(context.instructions.indexOf("Verify the work.")).toBeLessThan(context.instructions.indexOf("## Skill: Documentation"));
    expect(context.instructions.indexOf("## Skill: Documentation")).toBeLessThan(context.instructions.indexOf("## Skill: API Design"));
    expect(context.instructions.match(/## Skill: Documentation/g)).toHaveLength(1);
    expect(context.instructions).toContain("task-scoped");
    expect((await new TeamService(root).load(team.id)).members.find((member) => member.id === "sam")?.instructions).toBe("Verify the work.");
  });

  it("does not grant Tools and reports missing provider capabilities", async () => {
    const { root, team } = await setup();
    const skills = new SkillService(root);
    await skills.addPermanent(team.id, "sam", "playwright-e2e");
    const before = structuredClone(noTools);
    const compatibility = assessSkillCompatibility(await skills.get("playwright-e2e"), noTools);
    const context = await skills.effectiveContext(team.id, "sam", undefined, noTools);
    expect(compatibility).toMatchObject({ compatible: false, missingCapabilities: ["browser", "command.run"] });
    expect(compatibility.reason).toContain("does not currently have");
    expect(context.skills).toEqual([]);
    expect(context.issues[0]).toContain("browser");
    expect(noTools).toEqual(before);
  });

  it("recognizes an incompatible provider capability set", async () => {
    const { root } = await setup();
    const result = assessSkillCompatibility(await new SkillService(root).get("security-review"), noTools);
    expect(result.compatible).toBe(false);
    expect(result.resolution).toContain("AI Engine");
  });
});
