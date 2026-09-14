// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AppState } from "./types";

type Call = { url: string; method: string; body: unknown };

const missingWorkspace: AppState = {
  workspace: { selected: true, initialized: false, selectionId: "selection-missing" },
  issue: { code: "WORKSPACE_NOT_FOUND", message: "DayCrew can no longer find this Workspace." },
};
const firstRun: AppState = {
  workspace: { selected: false, initialized: false, selectionId: "selection-none" },
  issue: { code: "WORKSPACE_NOT_SELECTED", message: "No Workspace is open." },
};
const created: AppState = {
  workspace: { selected: true, initialized: true, selectionId: "selection-new", id: "my-workspace", name: "My Workspace", key: "key-new" },
};

const NEW_ROOT = "C:\\Users\\idris\\AppData\\Local\\Temp\\daycrew-first-run-test";
const OLD_ROOT = "C:\\Users\\idris\\AppData\\Local\\Temp\\daycrew-gone";

const reply = (status: number, payload: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  json: () => Promise.resolve(payload),
}) as unknown as Response;

/** Routes the picker's real fetch calls so the whole click -> API -> state path runs. */
const stubApi = (options: {
  app: () => AppState;
  create?: (body: { root: string; name: string }) => Promise<Response>;
  open?: () => Promise<Response>;
  selectedRoot?: string;
}) => {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ url, method, body });
    if (url === "/api/app") return reply(200, options.app());
    if (url === "/api/app/workspaces") {
      return reply(200, {
        ...(options.selectedRoot === undefined ? {} : { selectedRoot: options.selectedRoot }),
        recentWorkspaces: [],
      });
    }
    if (url === "/api/app/workspace/create") return options.create!(body as { root: string; name: string });
    if (url === "/api/app/workspace/open") return options.open!();
    if (url === "/api/teams") return reply(200, []);
    if (url === "/api/home") {
      return reply(200, {
        workspace: { id: "my-workspace", name: "My Workspace", createdAt: "", updatedAt: "" },
        teams: [], needsYou: { count: 0, highlights: [] }, dailyBrief: { teams: [], needsYou: 0 }, recentActivity: [],
      });
    }
    return reply(404, { error: { code: "NOT_FOUND", message: "no route" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
};

const createCalls = (calls: Call[]) => calls.filter((call) => call.url === "/api/app/workspace/create");

beforeEach(() => { window.location.hash = ""; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Create Workspace from first-run onboarding", () => {
  it("remembers a missing Workspace, creates a new one, and leaves onboarding without a refresh", async () => {
    let app = missingWorkspace;
    const calls = stubApi({
      app: () => app,
      selectedRoot: OLD_ROOT,
      create: async (body) => {
        expect(body).toEqual({ root: NEW_ROOT, name: "My Workspace" });
        app = created;
        return reply(200, created);
      },
    });
    render(<App />);

    // A. The recoverable notice explains the previous Workspace, not this one.
    expect((await screen.findByRole("alert")).textContent).toBe("DayCrew can no longer find your previous Workspace.");
    fireEvent.click(screen.getByRole("button", { name: "Create a Workspace" }));

    // B. The dead path is never pre-filled into the folder the user is about to create.
    const folder = await screen.findByRole("textbox", { name: /folder path/i });
    expect((folder as HTMLInputElement).value).toBe("");
    fireEvent.change(folder, { target: { value: NEW_ROOT } });
    fireEvent.click(screen.getByRole("button", { name: "Create Workspace" }));

    // C. Exactly one request, to the create endpoint.
    await waitFor(() => expect(createCalls(calls)).toHaveLength(1));
    expect(createCalls(calls)[0]).toMatchObject({ method: "POST", url: "/api/app/workspace/create" });

    // D. The UI transitions on its own to the first-Team step.
    expect(await screen.findByRole("heading", { name: "Your Workspace is ready." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Team" })).toBeTruthy();
    expect(window.location.hash).toBe("#teams");
    expect(screen.queryByText(/can no longer find/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Create Workspace" })).toBeNull();
    expect(screen.queryByText("Welcome to DayCrew")).toBeNull();
  });

  it("shows pending feedback and sends only one request when the button is clicked twice", async () => {
    let release!: (value: Response) => void;
    const blocked = new Promise<Response>((resolve) => { release = resolve; });
    let app = missingWorkspace;
    const calls = stubApi({ app: () => app, create: () => blocked });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Create a Workspace" }));
    fireEvent.change(await screen.findByRole("textbox", { name: /folder path/i }), { target: { value: NEW_ROOT } });

    const submit = screen.getByRole("button", { name: "Create Workspace" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    const pending = await screen.findByRole("button", { name: "Creating Workspace…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(createCalls(calls)).toHaveLength(1);

    app = created;
    release(reply(200, created));
    expect(await screen.findByRole("heading", { name: "Your Workspace is ready." })).toBeTruthy();
    expect(createCalls(calls)).toHaveLength(1);
  });

  it.each([
    ["WORKSPACE_ALREADY_INITIALIZED", 409, "This folder is already a DayCrew Workspace. Open it instead."],
    ["WORKSPACE_PERMISSION_DENIED", 403, "DayCrew does not have permission to use this folder."],
    ["WORKSPACE_PATH_INVALID", 400, "This is not a usable folder path. Enter a full path, for example C:\\Users\\your-name\\Documents\\MyProject on Windows or /home/your-name/MyProject on Linux."],
  ])("keeps the form open and explains a %s failure", async (code, status, message) => {
    stubApi({
      app: () => missingWorkspace,
      create: async () => reply(status, { error: { code, message: "server copy" } }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Create a Workspace" }));
    fireEvent.change(await screen.findByRole("textbox", { name: /folder path/i }), { target: { value: NEW_ROOT } });
    fireEvent.click(screen.getByRole("button", { name: "Create Workspace" }));

    expect(await screen.findByText(message)).toBeTruthy();
    // The failure never leaves the stale banner standing in for a response.
    expect(screen.queryByText(/can no longer find your previous Workspace/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Create Workspace" })).toBeTruthy();
    expect(window.location.hash).toBe("");
  });

  it("does not let an /api/app response issued before the create revert the new Workspace", async () => {
    let app = missingWorkspace;
    let releaseStaleApp!: () => void;
    const staleInFlight = new Promise<void>((resolve) => { releaseStaleApp = resolve; });
    let holdNextApp = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/app") {
        if (holdNextApp) { holdNextApp = false; await staleInFlight; return reply(200, missingWorkspace); }
        return reply(200, app);
      }
      if (url === "/api/app/workspaces") return reply(200, { recentWorkspaces: [] });
      if (url === "/api/app/workspace/create") { app = created; return reply(200, created); }
      if (url === "/api/teams") return reply(200, []);
      return reply(404, { error: { code: "NOT_FOUND", message: "no route" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Create a Workspace" }));
    fireEvent.change(await screen.findByRole("textbox", { name: /folder path/i }), { target: { value: NEW_ROOT } });

    holdNextApp = true;
    window.dispatchEvent(new Event("focus")); // starts an /api/app read that will finish late
    fireEvent.click(screen.getByRole("button", { name: "Create Workspace" }));
    expect(await screen.findByRole("heading", { name: "Your Workspace is ready." })).toBeTruthy();

    releaseStaleApp();
    await Promise.resolve();
    await waitFor(() => expect(screen.queryByText("Welcome to DayCrew")).toBeNull());
    expect(screen.getByRole("heading", { name: "Your Workspace is ready." })).toBeTruthy();
  });

  it("shows no error banner on a true first run", async () => {
    stubApi({ app: () => firstRun });
    render(<App />);
    expect(await screen.findByText("Welcome to DayCrew")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("pre-fills the remembered folder only when it can still be initialized", async () => {
    stubApi({
      app: () => ({
        workspace: { selected: true, initialized: false, selectionId: "selection-uninitialized" },
        issue: { code: "WORKSPACE_NOT_INITIALIZED", message: "This folder is not a DayCrew Workspace yet." },
      }),
      selectedRoot: OLD_ROOT,
    });
    render(<App />);
    const folder = await screen.findByRole("textbox", { name: /folder path/i });
    await waitFor(() => expect((folder as HTMLInputElement).value).toBe(OLD_ROOT));
    fireEvent.click(screen.getByRole("button", { name: "Initialize DayCrew here" }));
    expect(screen.getByRole("button", { name: "Create Workspace" })).toBeTruthy();
  });
});
