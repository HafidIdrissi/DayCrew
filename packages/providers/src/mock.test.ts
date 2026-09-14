import type { AgentEvent } from "@daycrew/shared";
import { describe, expect, it } from "vitest";

import { MockProvider } from "./index.js";

const spec = {
  sessionId: "session-1",
  memberId: "manager",
  role: "Manager",
  instructions: "Coordinate the work.",
  goal: "Prepare the brief.",
  workspacePath: "C:/workspace",
};

describe("MockProvider", () => {
  it("is always available without credentials", async () => {
    await expect(new MockProvider().detect()).resolves.toEqual({
      available: true,
      installed: true,
      authenticated: true,
      version: "0.0.0",
    });
  });

  it("replays an exact normalized event script", async () => {
    const expected: AgentEvent[] = [
      { type: "text", text: "Planning." },
      {
        type: "tool_call",
        callId: "call-1",
        name: "read",
        input: { path: "README.md" },
      },
      {
        type: "tool_result",
        callId: "call-1",
        output: "DayCrew",
      },
      {
        type: "task_update",
        task: {
          id: "task-1",
          status: "review",
          previousOwnerId: "developer",
          ownerId: "manager",
        },
      },
      {
        type: "message",
        message: {
          toMemberId: "manager",
          taskId: "task-1",
          subject: "Implementation ready",
          body: "Please review the completed work.",
        },
      },
      {
        type: "approval_request",
        request: {
          requestId: "approval-1",
          action: "git.push",
          risk: "high",
          summary: "Publish the reviewed branch",
          payload: { remote: "origin" },
        },
      },
      {
        type: "usage",
        usage: { inputTokens: 20, outputTokens: 10, costUsd: 0 },
      },
      { type: "done", summary: "Ready for review." },
    ];
    const handle = await new MockProvider([expected]).startAgent(spec);

    await handle.send({ type: "goal", text: spec.goal });
    const actual: AgentEvent[] = [];
    for await (const event of handle.events) actual.push(event);

    expect(actual).toEqual(expected);
  });
});
