import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockProvider } from "@daycrew/providers";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "./index.js";

const servers = new Set<ReturnType<typeof buildServer>>();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => server.close()));
  servers.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("local server", () => {
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
});
