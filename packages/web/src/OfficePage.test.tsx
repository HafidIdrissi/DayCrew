// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectionStore, requestJson } from "./api";
import { OfficePage } from "./OfficePage";
import type { OfficeData } from "./types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const office = (): OfficeData => ({
  workspace: { id: "workspace-1", name: "Demo Workspace", createdAt: "2026-09-12T08:00:00.000Z", updatedAt: "2026-09-12T08:00:00.000Z" },
  needsYouCount: 1,
  teams: [{
    id: "software-development",
    name: "Software Development",
    autonomy: "work-with-approval",
    demoMode: true,
    goal: "Create a hello endpoint",
    sessionId: "session-1",
    sessionStatus: "working",
    members: [
      { id: "manager", name: "Engineering Manager", role: "Manager", isManager: true, status: "working", engine: { mode: "auto" }, skillCount: 0, needsYouCount: 0 },
      { id: "developer", name: "Dana Developer", role: "Implementation", isManager: false, status: "blocked-on-approval", currentTask: "Add the endpoint", currentTaskId: "task-1", engine: { mode: "manual", provider: "demo" }, skillCount: 2, needsYouCount: 1 },
    ],
  }],
});

const stubOffice = () => vi.stubGlobal("fetch", vi.fn(async () => (
  { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => office() } as unknown as Response
)));

const sized = (count: number): OfficeData => {
  const base = office();
  return {
    ...base,
    teams: [{
      ...base.teams[0]!,
      members: [
        base.teams[0]!.members[0]!,
        ...Array.from({ length: count }, (_, index) => ({
          id: `member-${index}`,
          name: index === 0 ? "Aleksandra Wojciechowska-Nakamura" : `Member ${index}`,
          role: index === 0 ? "Principal Distributed Systems Engineer" : "Implementation",
          isManager: false, status: "idle" as const, engine: { mode: "auto" as const },
          skillCount: 0, needsYouCount: 0,
        })),
      ],
    }],
  };
};

describe("Office", () => {
  it("opens a detail panel for the selected agent using real Workspace state", async () => {
    stubOffice();
    render(<OfficePage selectionId="selection" onSwitchWorkspace={() => undefined} onWorkspaceIssue={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "List" }));
    const member = await screen.findByRole("option", { name: /Dana Developer/ });
    expect(member.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(member);
    const detail = await screen.findByLabelText("Dana Developer detail");
    expect(detail.textContent).toContain("Demo Mode (simulated)");
    expect(detail.textContent).toContain("Add the endpoint");
    // The engine is simulated, so the panel has to say so rather than imply real execution.
    expect(detail.textContent).toContain("simulated, not real AI execution");
    expect(screen.getByRole("link", { name: "Open current Task" }).getAttribute("href"))
      .toBe("#tasks/session-1/task-1");

    fireEvent.click(screen.getByRole("button", { name: "Close agent detail" }));
    await waitFor(() => expect(screen.queryByLabelText("Dana Developer detail")).toBeNull());
  });

  it("opens the same detail panel from a desk on the drawn floor", async () => {
    stubOffice();
    render(<OfficePage selectionId="selection" onSwitchWorkspace={() => undefined} onWorkspaceIssue={() => undefined} />);

    // The floor is the default view, and each desk is one keyboard-reachable control.
    const desk = await screen.findByRole("button", { name: /Dana Developer, Implementation, Waiting for approval/ });
    expect(desk.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(desk);

    const detail = await screen.findByLabelText("Dana Developer detail");
    expect(detail.textContent).toContain("Add the endpoint");
    expect(screen.getByRole("link", { name: "Review Needs You" }).getAttribute("href")).toBe("#needs-you");
  });

  it("lays out an empty crew, a single Member and a large team without losing the Manager", async () => {
    for (const count of [0, 1, 12]) {
      cleanup();
      vi.stubGlobal("fetch", vi.fn(async () => (
        { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => sized(count) } as unknown as Response
      )));
      render(<OfficePage selectionId="selection" onSwitchWorkspace={() => undefined} onWorkspaceIssue={() => undefined} />);
      await screen.findByLabelText("Manager's corner");
      const desks = await screen.findAllByRole("button", { name: /Engineering Manager|Member |Aleksandra/ });
      expect(desks.length).toBe(count + 1);
      if (count === 0) expect(screen.getByText(/No Members on this Team yet/)).toBeTruthy();
      else expect(screen.getByRole("button", { name: /Aleksandra Wojciechowska-Nakamura/ })).toBeTruthy();
    }
  });

  it("reports the local service as unreachable when a request cannot connect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(requestJson("/api/office")).rejects.toThrow("DayCrew could not reach the local service.");
    expect(connectionStore.getSnapshot()).toBe("offline");

    stubOffice();
    await requestJson("/api/office");
    expect(connectionStore.getSnapshot()).toBe("online");
  });
});
