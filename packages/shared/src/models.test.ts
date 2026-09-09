import { describe, expect, it } from "vitest";

import {
  AgentSchema,
  ApprovalRequestSchema,
  ArtifactSchema,
  EventSchema,
  MessageSchema,
  PermissionPolicySchema,
  RunSchema,
  TaskSchema,
} from "./models.js";

const timestamp = "2026-09-09T13:46:12.036Z";

describe("runtime entity schemas", () => {
  it("accepts the documented run shape", () => {
    expect(
      RunSchema.parse({
        id: "run-1",
        crewName: "Software Development",
        objective: "Ship the contract",
        workspace: "C:/work/daycrew",
        status: "running",
        mode: "crew",
        createdAt: timestamp,
        limits: {
          maxTurns: 60,
          maxUsd: 5,
          maxWallclockMs: 3_600_000,
          idleTimeoutMs: 30_000,
        },
        usage: { turns: 1, usd: 0, tokens: 50 },
      }).id,
    ).toBe("run-1");
  });

  it("accepts every other documented entity", () => {
    const permissionPolicy = { mode: "ask" as const };

    expect(
      AgentSchema.parse({
        runId: "run-1",
        agentId: "agent-1",
        role: "developer",
        provider: "mock",
        status: "idle",
        permissionPolicy,
      }).agentId,
    ).toBe("agent-1");

    expect(
      TaskSchema.parse({
        id: "task-1",
        runId: "run-1",
        title: "Define schemas",
        description: "Create runtime-validated contracts.",
        assignee: "agent-1",
        status: "doing",
        priority: "P0",
        deps: [],
        artifacts: [],
        createdBy: "architect",
        updatedAt: timestamp,
      }).status,
    ).toBe("doing");

    expect(
      MessageSchema.parse({
        id: "message-1",
        runId: "run-1",
        from: "architect",
        to: "agent-1",
        act: "request",
        subject: "Implement contracts",
        body: "Start with shared.",
        createdAt: timestamp,
      }).act,
    ).toBe("request");

    expect(
      ApprovalRequestSchema.parse({
        id: "approval-1",
        runId: "run-1",
        agentId: "agent-1",
        actionClass: "shell.exec",
        summary: "Run the tests",
        payload: { command: "pnpm test" },
        risk: "low",
        status: "pending",
        createdAt: timestamp,
      }).status,
    ).toBe("pending");

    expect(
      ArtifactSchema.parse({
        id: "artifact-1",
        runId: "run-1",
        path: "dist/report.json",
        kind: "report",
        producedBy: "agent-1",
        createdAt: timestamp,
        description: "Contract test report",
      }).kind,
    ).toBe("report");

    expect(
      EventSchema.parse({
        ts: timestamp,
        runId: "run-1",
        kind: "agent.text",
        agentId: "agent-1",
        text: "Working",
      }).kind,
    ).toBe("agent.text");
  });

  it("defaults permission mode to ask and rejects unknown policy keys", () => {
    expect(PermissionPolicySchema.parse({}).mode).toBe("ask");
    expect(() =>
      PermissionPolicySchema.parse({ mode: "ask", unsafe: true }),
    ).toThrow();
  });

  it("rejects invalid state and negative usage", () => {
    expect(() =>
      RunSchema.parse({
        id: "run-1",
        crewName: "Crew",
        objective: "Work",
        workspace: ".",
        status: "unknown",
        mode: "single",
        createdAt: timestamp,
        limits: {
          maxTurns: 1,
          maxUsd: 0,
          maxWallclockMs: 1,
          idleTimeoutMs: 1,
        },
        usage: { turns: -1, usd: 0, tokens: 0 },
      }),
    ).toThrow();
  });
});
