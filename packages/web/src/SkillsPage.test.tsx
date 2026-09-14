// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NeedsYouPage } from "./NeedsYouPage";
import { SkillsPage } from "./SkillsPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const workspace = { id: "daycrew-demo", name: "DayCrew Demo", createdAt: "2026-09-12T22:00:00.000Z", updatedAt: "2026-09-12T22:00:00.000Z" };

const skill = (id: string, name: string, capabilities: string[] = []) => ({
  id, name, description: `${name} guidance.`, version: "1.0.0",
  source: { type: "bundled", reference: "daycrew" }, instructions: "…", tags: ["review"],
  requiredCapabilities: capabilities, recommendedTools: [], compatibleRoles: ["Implementation"],
});

const team = {
  id: "software-development", workspaceId: "daycrew-demo", name: "Software Development",
  description: "Plan, build, test, and review.", autonomy: "work-with-approval" as const,
  members: [
    { id: "manager", name: "Engineering Manager", role: "Manager", instructions: "", isManager: true, engine: { mode: "manual" as const, provider: "demo" } },
    { id: "developer", name: "Developer", role: "Implementation", instructions: "", isManager: false, engine: { mode: "manual" as const, provider: "demo" } },
  ],
  createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
};

const json = (data: unknown) => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => data }) as unknown as Response;

describe("Skills", () => {
  it("lists the Workspace library and attaches a Skill through the local API", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/skills") return json([skill("api-design", "API Design"), skill("a11y", "Accessibility Review")]);
      if (url.startsWith("/api/teams/dashboard")) return json({
        workspace, teams: [team], team, knowledge: [], sessions: [], tasks: [], needsYou: [], activity: [],
        skills: [skill("api-design", "API Design")],
        memberSkills: team.members.map((member) => ({
          memberId: member.id, assignments: [],
          availability: [{ skill: skill("api-design", "API Design"), compatibility: { compatible: true, missingCapabilities: [] } }],
        })),
      });
      if (init?.method === "POST") { posted.push(url); return json({}); }
      return json({});
    }));

    render(<SkillsPage selectionId="selection" onSwitchWorkspace={() => undefined} onWorkspaceIssue={() => undefined} />);

    await screen.findByRole("option", { name: /API Design/ });
    expect(screen.getByRole("option", { name: /Accessibility Review/ })).toBeTruthy();
    // A Skill teaches; the page has to say it grants no access.
    expect(document.body.textContent).toContain("Skills do not grant tool access.");

    fireEvent.click(screen.getAllByRole("button", { name: "Attach" })[1]!);
    await waitFor(() => expect(posted).toContain("/api/teams/software-development/members/developer/skills"));
  });
});

describe("Needs You", () => {
  it("approves a pending item and refreshes from the server", async () => {
    const resolved: string[] = [];
    let pending = [{
      id: "needs-1", kind: "approval" as const,
      who: { id: "developer", name: "Developer", role: "Implementation" },
      what: "Developer wants to add the hello endpoint",
      why: "Writing a file needs your decision.", risk: "medium" as const,
      action: "filesystem.write", target: "src/hello.ts",
      team: { id: "software-development", name: "Software Development" },
      task: { id: "task-developer", sessionId: "session-1", title: "Implementation" },
      provider: "demo", suggestedAction: "Approve to let the Developer continue.",
      createdAt: "2026-09-12T22:05:12.280Z",
    }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/resolve")) { resolved.push(url); pending = []; return json({ status: "approved" }); }
      return json({ workspace, teams: [{ id: team.id, name: team.name, members: team.members }], tasks: [], needsYou: pending });
    }));

    render(<NeedsYouPage selectionId="selection" onSwitchWorkspace={() => undefined} onWorkspaceIssue={() => undefined} />);

    await screen.findByText("Developer wants to add the hello endpoint");
    expect(screen.getByText("src/hello.ts")).toBeTruthy();
    expect(screen.getByText("medium")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolved).toContain("/api/needs-you/needs-1/resolve"));
    await screen.findByText("You are all caught up.");
  });
});
