import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, loadTeamDashboard, providerErrorKind, requestJson } from "./api";
import { memberStatusMap } from "./TeamPage";
import { activeTaskFor } from "./skillCatalog";
import type { Task, TeamDashboardData } from "./types";

const data = (): TeamDashboardData => ({
  workspace: {
    id: "workspace-1",
    name: "DayCrew",
    createdAt: "2026-09-10T08:00:00.000Z",
    updatedAt: "2026-09-10T08:00:00.000Z",
  },
  teams: [],
  team: {
    id: "team-1",
    workspaceId: "workspace-1",
    name: "Software Development",
    description: "Build and review software.",
    autonomy: "work-with-approval",
    members: [
      { id: "manager", name: "Engineering Manager", role: "Manager", instructions: "Coordinate the team.", isManager: true, engine: { mode: "auto" } },
      { id: "developer", name: "Developer", role: "Implementation", instructions: "Build the work.", isManager: false, engine: { mode: "auto" } },
    ],
    createdAt: "2026-09-10T08:00:00.000Z",
    updatedAt: "2026-09-10T08:00:00.000Z",
  },
  knowledge: [],
  sessions: [
    {
      id: "session-1",
      workspaceId: "workspace-1",
      teamId: "team-1",
      goal: "Ship the Team page",
      status: "working",
      startedAt: "2026-09-10T08:00:00.000Z",
      members: [
        { memberId: "manager", status: "working" },
        { memberId: "developer", status: "working" },
      ],
    },
  ],
  tasks: [],
  needsYou: [],
  activity: [],
});

describe("Team page state adapters", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns the typed uninitialized response into onboarding state without surfacing ENOENT", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "WORKSPACE_NOT_INITIALIZED",
        message: "This folder is not a DayCrew Workspace yet.",
        },
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    const result = await loadTeamDashboard();
    expect(result).toEqual({
      kind: "workspace-issue",
      code: "WORKSPACE_NOT_INITIALIZED",
      message: "This folder is not a DayCrew Workspace yet.",
    });
    expect(JSON.stringify(result)).not.toContain("ENOENT");
  });

  it("uses the latest real runtime status and lets approvals override it", () => {
    const dashboard = data();
    dashboard.needsYou.push({
      id: "need-1",
      teamId: "team-1",
      sessionId: "session-1",
      memberId: "developer",
      kind: "approval",
      title: "Approve command",
      detail: "The developer needs approval.",
      status: "pending",
      createdAt: "2026-09-10T08:01:00.000Z",
    });

    expect(memberStatusMap(dashboard).get("manager")).toBe("working");
    expect(memberStatusMap(dashboard).get("developer")).toBe("blocked-on-approval");
  });

  it.each(["WORKSPACE_NOT_SELECTED", "WORKSPACE_NOT_FOUND", "WORKSPACE_PERMISSION_DENIED", "WORKSPACE_CHANGED"])(
    "handles %s without displaying a backend's raw exception", async (code) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { code, message: "ENOENT: open C:\\private\\workspace.json" },
      }), { status: 409 })));
      const result = await loadTeamDashboard("shared-team", "workspace-b-selection");
      expect(result).toMatchObject({ kind: "workspace-issue", code });
      expect(JSON.stringify(result)).not.toMatch(/ENOENT|private/);
    },
  );

  it("loads the dashboard atomically with the selected workspace token", async () => {
    const dashboard = data();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(dashboard)));
    vi.stubGlobal("fetch", fetch);
    expect(await loadTeamDashboard("team-1", "workspace-b")).toEqual(dashboard);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/teams/dashboard?teamId=team-1", expect.objectContaining({
      headers: expect.objectContaining({ "X-DayCrew-Workspace": "workspace-b" }), cache: "no-store",
    }));
  });

  it("sanitizes legacy string errors, including raw ENOENT", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "ENOENT: no such file or directory, open C:\\private\\workspace.json",
    }), { status: 500 })));
    const error = await requestJson("/api/workspace").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).not.toMatch(/ENOENT|private/);
  });

  it("selects a member's active task before a general team task", () => {
    const tasks: Task[] = [
      { id: "task-1", sessionId: "session-1", teamId: "team-1", title: "Plan", description: "", status: "todo", handoffs: [], needsYou: false, createdAt: "2026-09-10T08:00:00.000Z", updatedAt: "2026-09-10T08:00:00.000Z" },
      { id: "task-2", sessionId: "session-1", teamId: "team-1", title: "Build", description: "", status: "in-progress", ownerId: "developer", handoffs: [], needsYou: false, createdAt: "2026-09-10T08:00:00.000Z", updatedAt: "2026-09-10T08:00:00.000Z" },
    ];

    expect(activeTaskFor(tasks, "developer")?.id).toBe("task-2");
  });

  it("classifies provider-facing errors for the composer state", () => {
    expect(providerErrorKind("Provider connection is offline")).toBe("unavailable");
    expect(providerErrorKind("Permission denied by provider policy")).toBe("restricted");
    expect(providerErrorKind("Goal is required")).toBe("error");
  });
});
