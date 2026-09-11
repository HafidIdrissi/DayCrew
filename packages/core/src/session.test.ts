import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ActivityService,
  TeamService,
  WorkSessionService,
  WorkspaceService,
  permissionPolicyFor,
  requiresHumanApproval,
} from "./index.js";

const directories: string[] = [];
const now = () => "2026-09-09T12:00:00.000Z";
let nextId = 0;
const createId = () => String(++nextId);

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-session-"));
  directories.push(root);
  await new WorkspaceService(root, { now }).create("Acme");
  const team = await new TeamService(root, { now }).create({
    name: "Engineering",
    members: [
      {
        id: "manager",
        name: "Manager",
        role: "Manager",
        instructions: "Coordinate the work.",
        isManager: true,
        engine: { mode: "auto" },
      },
      {
        id: "developer",
        name: "Developer",
        role: "Developer",
        instructions: "Implement the work.",
        isManager: false,
        engine: { mode: "auto" },
      },
      {
        id: "qa",
        name: "QA",
        role: "QA",
        instructions: "Verify the work.",
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

describe("work-session state", () => {
  it("enforces dependencies and records task handoffs and messages", async () => {
    const { root, team } = await setup();
    const sessions = new WorkSessionService(root, { now, createId });
    const session = await sessions.create(team.id, "Ship the feature");
    const design = await sessions.createTask(session.id, {
      title: "Design",
      ownerId: "developer",
    });
    const verification = await sessions.createTask(session.id, {
      title: "Verify",
      ownerId: "qa",
      dependsOn: [design.id],
    });
    await expect(
      sessions.updateTask(session.id, design.id, { dependsOn: [verification.id] }),
    ).rejects.toThrow("cycle");

    await expect(
      sessions.updateTask(session.id, verification.id, { status: "in-progress" }),
    ).rejects.toThrow("incomplete dependencies");
    await sessions.updateTask(session.id, design.id, { status: "in-progress" });
    await sessions.updateTask(session.id, design.id, { status: "review" });
    await sessions.updateTask(session.id, design.id, { ownerId: "qa", handoffNote: "Please verify" });
    const handedOff = await sessions.updateTask(session.id, design.id, { status: "done" });
    expect(handedOff.handoffs).toMatchObject([
      { fromMemberId: "developer", toMemberId: "qa", note: "Please verify" },
    ]);

    await sessions.sendMessage(session.id, {
      fromMemberId: "qa",
      toMemberId: "manager",
      taskId: design.id,
      subject: "Verified",
      body: "The change is ready.",
    });
    expect(await sessions.listMessages(session.id)).toHaveLength(1);
    expect((await new ActivityService(root).list(session.id)).some((event) => event.kind === "task.handed_off")).toBe(true);
  });

  it("supports the Needs You approval lifecycle and pause/resume", async () => {
    const { root, team } = await setup();
    const sessions = new WorkSessionService(root, { now, createId });
    const session = await sessions.create(team.id, "Publish the release");
    const request = await sessions.createNeedsYou(session.id, {
      memberId: "manager",
      kind: "approval",
      title: "Push the release",
      detail: "Approval required for git.push",
      action: "git.push",
      risk: "high",
    });
    await sessions.pause(session.id, "Waiting for approval");
    expect((await sessions.listNeedsYou("pending"))[0]?.id).toBe(request.id);

    const resolved = await sessions.resolveNeedsYou(request.id, "denied", "Use a feature branch");
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "denied",
      feedback: "Use a feature branch",
    });
    await expect(sessions.resume(session.id)).resolves.toMatchObject({ status: "working" });
  });

  it("maps the three autonomy levels while preserving hard safety boundaries", () => {
    expect(permissionPolicyFor("assist").mode).toBe("confirm-all");
    expect(permissionPolicyFor("work-with-approval").mode).toBe("ask-risky");
    expect(permissionPolicyFor("autonomous").mode).toBe("bounded-auto");
    expect(requiresHumanApproval("autonomous", "filesystem.delete", "low")).toBe(true);
    expect(requiresHumanApproval("autonomous", "network.sensitive", "low")).toBe(false);
  });
});
