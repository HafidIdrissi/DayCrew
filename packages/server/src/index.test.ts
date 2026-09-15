import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockProvider } from "@daycrew/providers";
import { TeamService, WorkSessionService } from "@daycrew/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "./index.js";

const servers = new Set<ReturnType<typeof buildServer>>();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("local server", () => {
  it("keeps a failed Mission synchronized across its response, dashboard, board, Office, and Needs You", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-api-failed-mission-"));
    directories.push(root);
    const provider = new MockProvider();
    vi.spyOn(provider, "detect").mockResolvedValue({
      available: false,
      installed: true,
      authenticated: false,
      reason: "AI Engine is not signed in. Run the login command.",
    });
    const server = buildServer({
      workspaceRoot: root,
      appConfigDir: path.join(root, "app-config"),
      orchestration: { providers: new Map([[provider.id, provider]]), defaultProvider: provider.id },
    });
    servers.add(server);
    await server.inject({ method: "POST", url: "/api/workspace", payload: { name: "Failure state" } });
    const created = await server.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "Release Crew", members: [{
        id: "manager", name: "Manager", role: "Manager", instructions: "Coordinate.", isManager: true, engine: { mode: "auto" },
      }] },
    });
    const teamId = created.json().id as string;
    const response = await server.inject({ method: "POST", url: `/api/teams/${teamId}/goals`, payload: { goal: "Prepare the release" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      session: { status: "failed", failure: { kind: "engine-configuration", retryable: true } },
      tasks: [],
    });
    const sessionId = response.json().session.id as string;
    const [home, board, office, dashboard, needs] = await Promise.all([
      server.inject({ method: "GET", url: "/api/home" }),
      server.inject({ method: "GET", url: "/api/tasks/dashboard" }),
      server.inject({ method: "GET", url: "/api/office" }),
      server.inject({ method: "GET", url: `/api/teams/dashboard?teamId=${teamId}` }),
      server.inject({ method: "GET", url: "/api/needs-you?status=pending" }),
    ]);
    for (const view of [home, board, office, dashboard]) {
      expect(view.json().missionIssues).toEqual([
        expect.objectContaining({ sessionId, teamId, goal: "Prepare the release", failure: expect.objectContaining({ kind: "engine-configuration" }) }),
      ]);
    }
    expect(board.json().tasks).toEqual([]);
    expect(office.json().teams[0]).toMatchObject({ sessionId, sessionStatus: "failed" });
    expect(needs.json()).toEqual([expect.objectContaining({ sessionId, kind: "failed-task" })]);
  });

  it("exposes persisted Member Skills, temporary Task Skills, and side-effect-free recommendations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-api-skills-"));
    directories.push(root);
    const server = buildServer({ workspaceRoot: root, appConfigDir: path.join(root, "app-config") });
    servers.add(server);
    await server.inject({ method: "POST", url: "/api/workspace", payload: { name: "Skills" } });
    const teamResponse = await server.inject({
      method: "POST",
      url: "/api/teams",
      payload: {
        name: "Skill Team",
        members: [
          { id: "manager", name: "Manager", role: "Manager", instructions: "Coordinate.", isManager: true, engine: { mode: "auto" } },
          { id: "sam", name: "Sam", role: "QA Engineer", instructions: "Test.", isManager: false, engine: { mode: "auto" } },
        ],
      },
    });
    const teamId = teamResponse.json().id as string;
    const library = await server.inject({ method: "GET", url: "/api/skills" });
    expect(library.json()).toHaveLength(12);

    const recommendation = await server.inject({
      method: "GET", url: `/api/teams/${teamId}/members/sam/skill-recommendations`,
    });
    expect(recommendation.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ skill: expect.objectContaining({ id: "accessibility-review" }) }),
    ]));
    const unchanged = await server.inject({ method: "GET", url: `/api/teams/${teamId}` });
    expect(unchanged.json().team.members.find((member: { id: string }) => member.id === "sam").skillIds).toBeUndefined();

    await server.inject({
      method: "POST", url: `/api/teams/${teamId}/members/sam/skills`, payload: { skillId: "documentation" },
    });
    const sessions = new WorkSessionService(root);
    const session = await sessions.create(teamId, "Review a fixture");
    const task = await sessions.createTask(session.id, { id: "task-42", title: "Accessibility review", ownerId: "sam" });
    const taskRecommendation = await server.inject({
      method: "GET",
      url: `/api/teams/${teamId}/members/sam/skill-recommendations?taskId=${task.id}&sessionId=${session.id}`,
    });
    expect(taskRecommendation.json()[0]).toMatchObject({
      skill: { id: "accessibility-review" },
      reason: expect.stringContaining("current Task"),
    });
    await server.inject({
      method: "POST", url: `/api/tasks/${task.id}/members/sam/skills`, payload: { skillId: "accessibility-review" },
    });

    const dashboard = await server.inject({ method: "GET", url: `/api/teams/dashboard?teamId=${teamId}` });
    const sam = dashboard.json().memberSkills.find((state: { memberId: string }) => state.memberId === "sam");
    expect(sam.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "permanent", skill: expect.objectContaining({ id: "documentation" }) }),
      expect.objectContaining({ scope: "temporary", taskId: "task-42", skill: expect.objectContaining({ id: "accessibility-review" }) }),
    ]));

    await server.inject({ method: "DELETE", url: `/api/teams/${teamId}/members/sam/skills/documentation` });
    await server.inject({ method: "DELETE", url: `/api/tasks/${task.id}/members/sam/skills/accessibility-review` });
    const removed = await server.inject({ method: "GET", url: `/api/teams/${teamId}/members/sam/skills` });
    expect(removed.json()).toEqual([]);
  });

  it("exercises Workspace, Team Pack, Manager goal, and task APIs end to end", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-api-"));
    directories.push(root);
    const server = buildServer({ workspaceRoot: root, appConfigDir: path.join(root, "app-config") });
    servers.add(server);

    expect(
      (await server.inject({ method: "POST", url: "/api/workspace", payload: { name: "Demo" } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/teams/install",
          payload: { packId: "software-development" },
        })
      ).statusCode,
    ).toBe(200);
    const installed = await new TeamService(root).load("software-development");
    await new TeamService(root).update(installed.id, {
      members: installed.members.map((member) => ({ ...member, engine: { mode: "manual", provider: "mock" } })),
    });
    const work = await server.inject({
      method: "POST",
      url: "/api/teams/software-development/goals",
      payload: { goal: "Build authentication" },
    });

    expect(work.statusCode).toBe(200);
    expect(work.json()).toMatchObject({
      session: { status: "completed" },
      tasks: [
        { ownerId: "architect", status: "done" },
        { ownerId: "developer", status: "done" },
        { ownerId: "qa", status: "done" },
      ],
    });
    const tasks = await server.inject({ method: "GET", url: "/api/tasks" });
    expect(tasks.json()).toHaveLength(3);
  });

  it("resolves a core approval through the normal API and resumes its live handle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-api-approval-"));
    directories.push(root);
    const provider = new MockProvider({
      scriptsByMember: {
        manager: [
          [
            {
              type: "approval_request",
              request: {
                requestId: "api-request",
                action: "filesystem.write",
                risk: "medium",
                summary: "API approval",
                payload: { path: "hello.txt" },
              },
            },
          ],
          [{ type: "done", summary: "API decision received." }],
        ],
      },
    });
    const server = buildServer({
      workspaceRoot: root,
      appConfigDir: path.join(root, "app-config"),
      orchestration: { providers: new Map([[provider.id, provider]]) },
    });
    servers.add(server);
    await server.inject({ method: "POST", url: "/api/workspace", payload: { name: "Demo" } });
    const team = await server.inject({
      method: "POST",
      url: "/api/teams",
      payload: {
        name: "Approval team",
        members: [
          {
            id: "manager",
            name: "Manager",
            role: "Manager",
            instructions: "Coordinate.",
            isManager: true,
            engine: { mode: "auto" },
          },
        ],
      },
    });
    const teamId = team.json().id as string;
    const work = await server.inject({
      method: "POST",
      url: `/api/teams/${teamId}/goals`,
      payload: { goal: "Request approval" },
    });
    expect(work.json().session.status).toBe("waiting-for-human");
    const sessionId = work.json().session.id as string;
    const needs = await server.inject({ method: "GET", url: "/api/needs-you?status=pending" });
    const itemId = needs.json()[0].id as string;

    const decision = await server.inject({
      method: "POST",
      url: `/api/needs-you/${itemId}/resolve`,
      payload: { resolution: "denied", feedback: "Use another approach", actorId: "api-user" },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({
      sessionId,
      status: "denied",
      decidedBy: { type: "human", id: "api-user" },
    });

    const deadline = Date.now() + 25_000;
    let status = "waiting-for-human";
    let cleanedUp = false;
    while (Date.now() < deadline && !cleanedUp) {
      const snapshot = (
        await server.inject({ method: "GET", url: `/api/work/${sessionId}` })
      ).json();
      status = snapshot.session.status as string;
      cleanedUp = snapshot.activity.some(
        (event: { kind: string }) => event.kind === "session.completed",
      ) as boolean;
      if (!cleanedUp) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status).toBe("completed");
    expect(cleanedUp).toBe(true);
    expect(provider.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({
            type: "approval-decision",
            requestId: "api-request",
            decision: "denied",
            feedback: "Use another approach",
          }),
        }),
      ]),
    );
  });

  it("proves the public-alpha demo journey through persisted backend state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-alpha-e2e-"));
    directories.push(root);
    const server = buildServer({ workspaceRoot: root, appConfigDir: path.join(root, "app-config") });
    servers.add(server);

    expect((await server.inject({ method: "POST", url: "/api/workspace", payload: { name: "Alpha E2E" } })).statusCode).toBe(200);
    const installed = (await server.inject({ method: "POST", url: "/api/teams/install", payload: { packId: "software-development" } })).json();
    const team = await new TeamService(root).update(installed.id, {
      members: installed.members.map((member: { engine: unknown }) => ({ ...member, engine: { mode: "manual", provider: "demo" } })),
    });
    await server.inject({ method: "POST", url: `/api/teams/${team.id}/members/developer/skills`, payload: { skillId: "api-design" } });

    const started = await server.inject({
      method: "POST",
      url: `/api/teams/${team.id}/goals`,
      payload: { goal: "Create a hello endpoint and review the implementation." },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().session.status).toBe("waiting-for-human");
    const sessionId = started.json().session.id as string;

    const during = (await server.inject({ method: "GET", url: "/api/tasks/dashboard" })).json();
    expect(during.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: expect.objectContaining({ id: "architect" }), status: "done" }),
      expect.objectContaining({ owner: expect.objectContaining({ id: "developer" }), status: "in-progress", needsYou: true }),
    ]));
    expect(during.needsYou).toEqual([expect.objectContaining({ kind: "approval", provider: "Demo Mode", action: "Modify Workspace files" })]);

    const itemId = during.needsYou[0].id as string;
    const approved = await server.inject({ method: "POST", url: `/api/needs-you/${itemId}/resolve`, payload: { resolution: "approved" } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ sessionId, status: "approved" });

    const deadline = Date.now() + 10_000;
    let snapshot: { session: { id: string; status: string }; tasks: Array<{ status: string }>; activity: Array<{ summary: string; kind: string }> } | undefined;
    do {
      snapshot = (await server.inject({ method: "GET", url: `/api/work/${sessionId}` })).json();
      if (snapshot.session.status !== "completed") await new Promise((resolve) => setTimeout(resolve, 20));
    } while (snapshot.session.status !== "completed" && Date.now() < deadline);

    expect(snapshot.session, JSON.stringify(snapshot, null, 2)).toMatchObject({ id: sessionId, status: "completed" });
    expect(snapshot.tasks).toHaveLength(3);
    expect(snapshot.tasks.every((task) => task.status === "done")).toBe(true);
    expect(snapshot.activity.some((event) => event.kind === "member.resumed")).toBe(true);
    expect(snapshot.activity.some((event) => event.kind === "task.updated" && event.summary.includes("review"))).toBe(true);

    const home = (await server.inject({ method: "GET", url: "/api/home" })).json();
    expect(home.dailyBrief.teams[0]).toMatchObject({ completedTasks: 3, activeTasks: 0 });
    const office = (await server.inject({ method: "GET", url: "/api/office" })).json();
    expect(office.teams[0]).toMatchObject({ demoMode: true, sessionStatus: "completed" });
    expect(office.teams[0].members.every((member: { status: string }) => member.status === "completed")).toBe(true);
  });
});
