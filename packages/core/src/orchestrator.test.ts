import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockProvider } from "@daycrew/providers";
import { afterEach, describe, expect, it } from "vitest";

import {
  ActivityService,
  ApprovalService,
  ManagerOrchestrator,
  TeamService,
  WorkSessionService,
  WorkspaceService,
} from "./index.js";

const directories: string[] = [];
const now = () => "2026-09-09T12:00:00.000Z";
let nextId = 0;
const createId = () => String(++nextId);

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-orchestration-"));
  directories.push(root);
  await new WorkspaceService(root, { now }).create("Acme");
  const team = await new TeamService(root, { now }).create({
    name: "Engineering",
    members: [
      {
        id: "manager",
        name: "Engineering Manager",
        role: "Manager",
        instructions: "Plan, delegate, and review.",
        isManager: true,
        engine: { mode: "auto" },
      },
      {
        id: "architect",
        name: "Architect",
        role: "Architecture",
        instructions: "Design the solution.",
        isManager: false,
        engine: { mode: "auto" },
      },
      {
        id: "developer",
        name: "Developer",
        role: "Implementation",
        instructions: "Build the solution.",
        isManager: false,
        engine: { mode: "auto" },
      },
    ],
  });
  return { root, team };
};

afterEach(async () => {
  nextId = 0;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Manager orchestration", () => {
  it("decomposes, delegates, respects dependencies, reviews, and completes work", async () => {
    const { root, team } = await setup();
    const provider = new MockProvider({
      scriptsByMember: {
        manager: [
          [
            {
              type: "task_update",
              task: { id: "task-design", title: "Design auth", ownerId: "architect" },
            },
            {
              type: "task_update",
              task: {
                id: "task-build",
                title: "Build auth",
                ownerId: "developer",
                dependsOn: ["task-design"],
              },
            },
            { type: "turn_end" },
          ],
          [
            { type: "task_update", task: { id: "task-design", status: "done" } },
            { type: "turn_end" },
          ],
          [
            { type: "task_update", task: { id: "task-build", status: "done" } },
            { type: "done", summary: "Authentication is implemented and reviewed." },
          ],
        ],
        architect: [[{ type: "text", text: "Architecture is ready." }, { type: "done" }]],
        developer: [[{ type: "text", text: "Implementation is ready." }, { type: "done" }]],
      },
    });
    const orchestrator = new ManagerOrchestrator(
      root,
      { providers: new Map([["mock", provider]]) },
      { now, createId },
    );

    const result = await orchestrator.runGoal(team.id, "Build authentication");

    expect(result.session).toMatchObject({
      status: "completed",
      summary: "Authentication is implemented and reviewed.",
      turnCount: 5,
    });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.every((task) => task.status === "done")).toBe(true);
    expect(result.messages.map((message) => message.fromMemberId)).toEqual([
      "architect",
      "developer",
    ]);
    const activity = await new ActivityService(root).list(result.session.id);
    expect(activity.some((event) => event.kind === "session.completed")).toBe(true);
  });

  it("pauses and creates Needs You when an agent requests approval", async () => {
    const { root, team } = await setup();
    const provider = new MockProvider({
      scriptsByMember: {
        manager: [
          [
            {
              type: "approval_request",
              request: {
                requestId: "publish-request",
                action: "git.push",
                risk: "high",
                summary: "Publish the branch",
                payload: { remote: "origin" },
              },
            },
          ],
          [{ type: "done", summary: "Push decision handled." }],
        ],
      },
    });
    const orchestrator = new ManagerOrchestrator(
      root,
      { providers: new Map([["mock", provider]]) },
      { now, createId },
    );

    const result = await orchestrator.runGoal(team.id, "Publish the change");
    const needsYou = await new WorkSessionService(root).listNeedsYou("pending");
    expect(result.session).toMatchObject({ status: "waiting-for-human" });
    expect(needsYou).toMatchObject([
      { kind: "approval", title: "Publish the branch", action: "git.push", risk: "high" },
    ]);
    await new ApprovalService(root).decideNeedsYou(needsYou[0]!.id, "denied");
    const sessions = new WorkSessionService(root);
    const deadline = Date.now() + 10_000;
    while ((await sessions.load(result.session.id)).status !== "completed") {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for resumed orchestration");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    while (
      !(await new ActivityService(root).list(result.session.id)).some(
        (event) => event.kind === "session.completed",
      )
    ) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for orchestration cleanup");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, 15_000);
});
