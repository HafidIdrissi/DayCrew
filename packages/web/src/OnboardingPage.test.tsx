// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OnboardingPage } from "./OnboardingPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const member = (id: string, isManager: boolean) => ({
  id, name: id, role: "Engineer", instructions: "Do the work.", isManager,
  engine: { mode: "auto" as const },
});

const team = {
  id: "software-development",
  name: "Software Development",
  autonomy: "work-with-approval",
  members: [member("manager", true), member("developer", false)],
};

/** Records every request so the demo launch can be checked for order and payload. */
const stubApi = () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const body = url.startsWith("/api/teams") && (init?.method ?? "GET") === "GET" ? [team]
      : url.endsWith("/goals") ? { session: { id: "session-1", status: "planning" }, tasks: [] }
      : url.startsWith("/api/settings") ? { workspace: { id: "w", name: "w" }, engines: [] }
      : team;
    return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
};

describe("Onboarding first Mission", () => {
  it("labels each Mission template with a short tile and loads its full brief", async () => {
    stubApi();
    render(<OnboardingPage selectionId="selection" />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue to first Goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Audit security risks" }));

    const brief = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(brief.value).toBe("Audit the project for its highest-impact security risks and propose concrete fixes.");
  });

  it("puts every Member on the demo engine before starting a guided demo Mission", async () => {
    const calls = stubApi();
    render(<OnboardingPage selectionId="selection" />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue to first Goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Run guided demo" }));

    await waitFor(() => expect(window.location.hash).toBe("#teams/software-development"));
    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.url)).toEqual([
      "/api/teams/software-development/members/manager",
      "/api/teams/software-development/members/developer",
      "/api/teams/software-development/goals",
    ]);
    for (const patch of writes.slice(0, 2)) {
      expect(JSON.parse(patch.body!).engine).toEqual({ mode: "manual", provider: "demo" });
    }
  });

  it("keeps the configured AI Engines when the Mission is started normally", async () => {
    const calls = stubApi();
    render(<OnboardingPage selectionId="selection" />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue to first Goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Start with my AI Engines" }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/goals"))).toBe(true));
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
  });
});
