import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ActivityService,
  ManagerOrchestrator,
  TeamService,
  WorkspaceService,
} from "@daycrew/core";
import { CodexProvider } from "@daycrew/providers";
import type { AgentEvent } from "@daycrew/shared";
import { afterAll, describe, expect, it } from "vitest";

const createdDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const nextEvent = async (
  iterator: AsyncIterator<AgentEvent>,
  timeoutMs = 15_000,
): Promise<IteratorResult<AgentEvent>> =>
  Promise.race([
    iterator.next(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for a Codex event")), timeoutMs),
    ),
  ]);

describe("real Codex provider", () => {
  it("detects, orchestrates a Manager and Member, audits, cancels, and surfaces errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-real-codex-"));
    createdDirectories.push(root);
    await writeFile(
      path.join(root, "README.md"),
      "# Safe integration fixture\n\nThis isolated project has no credentials and must not be modified.\n",
      "utf8",
    );
    await new WorkspaceService(root).create("Codex Integration");
    const team = await new TeamService(root).create({
      name: "Codex Planning",
      autonomy: "assist",
      members: [
        {
          id: "manager",
          name: "Planning Manager",
          role: "Manager",
          instructions:
            "For a new goal, create exactly one todo task with id hello-plan owned by planner and complete=false. For a returned result, mark hello-plan done and complete=true.",
          isManager: true,
          engine: { mode: "manual", provider: "codex" },
        },
        {
          id: "planner",
          name: "Implementation Planner",
          role: "Implementation planning",
          instructions:
            "Create a short implementation plan without modifying files. Update the supplied task id to review and complete=true.",
          isManager: false,
          engine: { mode: "manual", provider: "codex" },
        },
      ],
    });
    const provider = new CodexProvider({
      allowUnconfinedReads: true,
      allowedWorkspaceRoots: [root],
    });

    const detection = await provider.detect();
    expect(detection.available, detection.reason).toBe(true);
    expect(detection.version).toMatch(/^\d+\.\d+\.\d+/);

    const result = await new ManagerOrchestrator(root, {
      providers: new Map([[provider.id, provider]]),
      defaultProvider: provider.id,
    }).runGoal(
      team.id,
      "Create a short implementation plan for adding a /hello endpoint to this test project.",
    );

    expect(result.session.status).toBe("completed");
    expect(result.tasks).toMatchObject([
      { id: "hello-plan", ownerId: "planner", status: "done" },
    ]);
    expect(result.session.usage.inputTokens + result.session.usage.outputTokens).toBeGreaterThan(0);
    const activity = await new ActivityService(root).list(result.session.id);
    expect(activity.some((event) => event.kind === "member.text")).toBe(true);
    expect(activity.some((event) => event.kind === "usage.updated")).toBe(true);
    expect(activity.some((event) => event.kind === "session.completed")).toBe(true);

    const cancellation = await provider.startAgent({
      sessionId: "session-cancel",
      memberId: "manager",
      role: "Manager",
      instructions: "Wait and reason carefully before answering.",
      goal: "Cancellation test",
      workspacePath: root,
    });
    await cancellation.send({
      type: "goal",
      text: "Prepare an extremely detailed plan with at least 100 sections. Do not use tools.",
    });
    await cancellation.interrupt();
    const cancelled = await nextEvent(cancellation.events[Symbol.asyncIterator]());
    expect(cancelled.value).toMatchObject({ type: "error", recoverable: true });
    await cancellation.stop();

    const failing = await provider.startAgent({
      sessionId: "session-error",
      memberId: "manager",
      role: "Manager",
      instructions: "Return the requested structured result.",
      goal: "Error test",
      workspacePath: root,
      model: "daycrew-intentionally-invalid-model",
    });
    await failing.send({ type: "goal", text: "Return an empty plan." });
    const errorIterator = failing.events[Symbol.asyncIterator]();
    let surfacedError: AgentEvent | undefined;
    for (let index = 0; index < 20; index += 1) {
      const event = await nextEvent(errorIterator, 30_000);
      if (event.done) break;
      if (event.value.type === "error") {
        surfacedError = event.value;
        break;
      }
    }
    expect(surfacedError).toMatchObject({ type: "error", recoverable: false });
    await failing.stop();
  });
});
