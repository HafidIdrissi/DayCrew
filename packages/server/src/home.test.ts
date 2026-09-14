import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ActivityService, TeamService, WorkSessionService, WorkspaceService } from "@daycrew/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildHomeData } from "./home.js";
import { buildServer } from "./index.js";

const directories: string[] = [];
const servers = new Set<ReturnType<typeof buildServer>>();
let nextId = 0;
const now = () => "2026-09-11T09:00:00.000Z";
const createId = () => String(++nextId);

const createRoot = async (name: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-home-"));
  directories.push(root);
  await new WorkspaceService(root, { now }).create(name);
  return root;
};

const createTeam = (root: string, name: string, id: string) => new TeamService(root, { now }).create({
  id,
  name,
  members: [
    { id: "manager", name: "Emma", role: "Manager", instructions: "Coordinate.", isManager: true, engine: { mode: "auto" } },
    { id: "developer", name: "Dev", role: "Developer", instructions: "Build.", isManager: false, engine: { mode: "auto" } },
  ],
});

afterEach(async () => {
  nextId = 0;
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Home aggregation", () => {
  it("returns the loaded Workspace with a real no-Teams state and no fake metrics", async () => {
    const root = await createRoot("Quiet Workspace");
    const home = await buildHomeData(root);
    expect(home.workspace).toMatchObject({ name: "Quiet Workspace" });
    expect(home.teams).toEqual([]);
    expect(home.needsYou).toEqual({ count: 0, highlights: [] });
    expect(home.dailyBrief).toEqual({ teams: [], needsYou: 0 });
    expect(JSON.stringify(home)).not.toMatch(/percentage|percent|mock|demo/i);
  });

  it("summarizes Teams, Needs You, recent Activity, and the latest Work Session brief", async () => {
    const root = await createRoot("Active Workspace");
    const team = await createTeam(root, "Engineering", "engineering");
    const sessions = new WorkSessionService(root, { now, createId });
    const session = await sessions.create(team.id, "Authentication flow");
    await sessions.update(session.id, { status: "working" });
    await sessions.setMemberStatus(session.id, "developer", "working", "auth-api");
    const completed = await sessions.createTask(session.id, { id: "auth-api", title: "Authentication API", ownerId: "developer" });
    await sessions.updateTask(session.id, completed.id, { status: "in-progress" });
    await sessions.updateTask(session.id, completed.id, { status: "review" });
    await sessions.updateTask(session.id, completed.id, { status: "done" });
    const review = await sessions.createTask(session.id, { id: "login-tests", title: "Login tests", ownerId: "developer" });
    await sessions.updateTask(session.id, review.id, { status: "in-progress" });
    await sessions.updateTask(session.id, review.id, { status: "review" });
    await sessions.createNeedsYou(session.id, { memberId: "developer", kind: "approval", title: "Developer needs approval", detail: "Modify packages/server/src/auth.ts", taskId: completed.id });
    await sessions.createNeedsYou(session.id, { memberId: "manager", kind: "decision", title: "Choose the login policy", detail: "Select the supported login method." });
    await sessions.createNeedsYou(session.id, { memberId: "developer", kind: "blocker", title: "Login fixture is blocked", detail: "The expected fixture is missing." });

    const home = await buildHomeData(root);
    expect(home.teams).toEqual([expect.objectContaining({
      name: "Engineering",
      manager: { id: "manager", name: "Emma" },
      workingMembers: 1,
      currentObjective: "Authentication flow",
      status: "needs-you",
      progress: { completed: 1, total: 2 },
    })]);
    expect(home.needsYou.count).toBe(3);
    expect(home.needsYou.highlights.map((item) => item.kind).sort()).toEqual(["approval", "blocker", "decision"]);
    expect(home.recentActivity.map((item) => item.text)).toEqual(expect.arrayContaining([
      "Dev completed “Authentication API”",
      "Dev moved “Login tests” to Review",
    ]));
    expect(home.recentActivity[0]).not.toHaveProperty("kind");
    expect(home.dailyBrief).toEqual({
      teams: [{ teamId: "engineering", teamName: "Engineering", completedTasks: 1, reviewTasks: 1, activeTasks: 0 }],
      needsYou: 3,
    });
  });

  it("omits progress when real Task data does not support it", async () => {
    const root = await createRoot("Ready Workspace");
    const team = await createTeam(root, "Research", "research");
    const sessions = new WorkSessionService(root, { now, createId });
    const session = await sessions.create(team.id, "Review papers");
    await sessions.update(session.id, { status: "working" });
    expect((await buildHomeData(root)).teams[0]).not.toHaveProperty("progress");
  });

  it("never exposes a raw runtime failure in Home activity", async () => {
    const root = await createRoot("Safe Errors");
    const team = await createTeam(root, "Engineering", "engineering");
    const session = await new WorkSessionService(root, { now, createId }).create(team.id, "Run checks");
    await new ActivityService(root, { now, createId }).record({
      workspaceId: session.workspaceId,
      teamId: team.id,
      sessionId: session.id,
      kind: "session.failed",
      summary: "ENOENT: open C:\\private\\provider-protocol.json",
      data: {},
    });

    const home = await buildHomeData(root);
    expect(home.recentActivity[0]?.text).toContain("stopped after an error");
    expect(JSON.stringify(home)).not.toMatch(/ENOENT|private|provider-protocol/);
  });
});

describe("Home Workspace boundaries", () => {
  it("returns the no-Workspace state safely", async () => {
    const config = await mkdtemp(path.join(tmpdir(), "daycrew-home-config-"));
    directories.push(config);
    const server = buildServer({ appConfigDir: config });
    servers.add(server);
    const app = await server.inject({ method: "GET", url: "/api/app" });
    const home = await server.inject({ method: "GET", url: "/api/home" });
    expect(app.json().workspace).toMatchObject({ initialized: false });
    expect(home.statusCode).toBe(409);
    expect(home.json().error.code).toBe("WORKSPACE_NOT_SELECTED");
  });

  it("updates on Workspace switch and never carries data from Workspace A into B", async () => {
    const first = await createRoot("Workspace A");
    const second = await createRoot("Workspace B");
    await createTeam(first, "Alpha Team", "alpha");
    await createTeam(second, "Beta Team", "beta");
    const config = await mkdtemp(path.join(tmpdir(), "daycrew-home-config-"));
    directories.push(config);
    const server = buildServer({ appConfigDir: config });
    servers.add(server);

    const openedA = await server.inject({ method: "POST", url: "/api/app/workspace/open", payload: { root: first } });
    const selectionA = openedA.json().workspace.selectionId as string;
    const homeA = await server.inject({ method: "GET", url: "/api/home", headers: { "x-daycrew-workspace": selectionA } });
    expect(homeA.json().teams.map((team: { name: string }) => team.name)).toEqual(["Alpha Team"]);

    const openedB = await server.inject({ method: "POST", url: "/api/app/workspace/open", payload: { root: second } });
    const selectionB = openedB.json().workspace.selectionId as string;
    const stale = await server.inject({ method: "GET", url: "/api/home", headers: { "x-daycrew-workspace": selectionA } });
    const homeB = await server.inject({ method: "GET", url: "/api/home", headers: { "x-daycrew-workspace": selectionB } });
    expect(stale.statusCode).toBe(409);
    expect(homeB.json().workspace.name).toBe("Workspace B");
    expect(homeB.json().teams.map((team: { name: string }) => team.name)).toEqual(["Beta Team"]);
    expect(JSON.stringify(homeB.json())).not.toContain("Alpha Team");
  });
});
