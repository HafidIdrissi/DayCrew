import { describe, expect, it } from "vitest";

import {
  AgentEventSchema,
  AgentInputSchema,
  AgentSpecSchema,
  DetectResultSchema,
  ProviderCapabilitiesSchema,
} from "./provider.js";

describe("provider contract schemas", () => {
  it("validates adapter metadata and agent specifications", () => {
    expect(DetectResultSchema.parse({ available: true, version: "1.0.0" }))
      .toEqual({ available: true, version: "1.0.0" });
    expect(
      ProviderCapabilitiesSchema.parse({
        streaming: true,
        nativeToolUse: true,
        nativePermissionPrompts: false,
        resume: false,
        mcp: false,
      }).streaming,
    ).toBe(true);
    expect(
      AgentSpecSchema.parse({
        agentId: "agent-1",
        memberId: "developer",
        title: "Developer",
        instructions: "Implement approved work.",
        objective: "Create contracts",
        cwd: "C:/work/daycrew",
        permissionPolicy: { mode: "ask" },
      }).memberId,
    ).toBe("developer");
  });

  it("validates every normalized event variant", () => {
    const events = [
      { type: "status", status: "thinking" },
      { type: "text", text: "hello" },
      { type: "tool_call", id: "tool-1", name: "read", input: {} },
      { type: "tool_result", id: "tool-1", output: "ok" },
      {
        type: "approval_request",
        actionClass: "shell.exec",
        summary: "Run a command",
        payload: { command: "pnpm test" },
      },
      { type: "task_update", task: { id: "task-1", status: "doing" } },
      {
        type: "message_out",
        to: "lead",
        act: "inform",
        subject: "Update",
        body: "Schemas ready.",
      },
      { type: "artifact", path: "report.json", kind: "report" },
      { type: "usage", usd: 0, tokens: 10, turns: 1 },
      { type: "turn_end" },
      { type: "done", summary: "Complete" },
      { type: "error", message: "Failed", fatal: true },
    ];

    expect(events.map((event) => AgentEventSchema.parse(event).type)).toEqual(
      events.map((event) => event.type),
    );
  });

  it("rejects native event leakage and invalid agent inputs", () => {
    expect(() =>
      AgentEventSchema.parse({
        type: "text",
        text: "hello",
        providerSequence: 1,
      }),
    ).toThrow();
    expect(() =>
      AgentInputSchema.parse({
        kind: "approval_result",
        requestId: "approval-1",
        decision: "allow",
      }),
    ).toThrow();
  });
});
