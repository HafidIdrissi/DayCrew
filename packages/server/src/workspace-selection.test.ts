import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KnowledgeService, MemoryService, TeamService, WorkspaceService } from "@daycrew/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer, type ServerOptions } from "./index.js";
import { appConfigDirectory } from "./app-config.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, accessSync: vi.fn(actual.accessSync) };
});
const servers: ReturnType<typeof buildServer>[] = [];
const directories: string[] = [];
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const temp = async () => {
  const root = fs.realpathSync(await mkdtemp(path.join(tmpdir(), "daycrew-selection-")));
  directories.push(root);
  return root;
};
const build = async (options: ServerOptions = {}) => {
  const server = buildServer({ appConfigDir: await temp(), ...options });
  servers.push(server);
  return server;
};
const get = (server: ReturnType<typeof buildServer>, url: string, selectionId?: string) =>
  server.inject({ method: "GET", url, ...(selectionId ? { headers: { "x-daycrew-workspace": selectionId } } : {}) });
const post = (server: ReturnType<typeof buildServer>, url: string, payload: object) =>
  server.inject({ method: "POST", url, payload });
const member = { id: "manager", name: "Manager", role: "Manager", instructions: "Coordinate.", isManager: true, engine: { mode: "auto" as const } };
const workspace = async (name: string, team?: string) => {
  const root = await temp();
  await new WorkspaceService(root).create(name);
  if (team) await new TeamService(root).create({ name: team, members: [member] });
  return root;
};
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  vi.mocked(fs.accessSync).mockImplementation(actual.accessSync);
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local-first application selection", () => {
  it.each([".", "packages/server", "packages/web"])("launching from %s never selects the installation", async (directory) => {
    const server = await build({ cwd: path.resolve(repository, directory) });
    expect((await get(server, "/health")).statusCode).toBe(200);
    expect((await get(server, "/api/app")).json()).toMatchObject({
      workspace: { selected: false, initialized: false }, issue: { code: "WORKSPACE_NOT_SELECTED" },
    });
    for (const route of ["/api/workspace", "/api/teams", "/api/teams/dashboard", "/api/tasks", "/api/activity", "/api/needs-you"]) {
      const response = await get(server, route);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("WORKSPACE_NOT_SELECTED");
      expect(response.body).not.toMatch(/ENOENT|packages|rootPath/);
    }
  });
  it.each([".", "packages/server", "packages/web"])("reopens the saved external workspace regardless of %s cwd", async (directory) => {
    const root = await workspace("External", "Alpha");
    const appConfigDir = await temp();
    const initial = await build({ appConfigDir });
    expect((await post(initial, "/api/app/workspace/open", { root })).statusCode).toBe(200);
    const restarted = await build({ appConfigDir, cwd: path.resolve(repository, directory) });
    expect((await get(restarted, "/api/teams")).json().map((team: { name: string }) => team.name)).toEqual(["Alpha"]);
    expect((await readFile(path.join(appConfigDir, "app.json"), "utf8"))).toContain(root.replaceAll("\\", "\\\\"));
  });
  it("prioritizes explicit selection over app config and opt-in discovery", async () => {
    const a = await workspace("A", "Alpha");
    const b = await workspace("B", "Beta");
    const appConfigDir = await temp();
    const first = await build({ appConfigDir });
    await post(first, "/api/app/workspace/open", { root: b });
    const server = await build({ appConfigDir, workspaceRoot: a, cwd: b, discoverWorkspace: true });
    const app = (await get(server, "/api/app")).json();
    expect(app.workspace.name).toBe("A");
    expect(JSON.stringify(app)).not.toContain(a);
    expect((await get(server, "/api/workspace")).body).not.toContain("rootPath");
  });
  it("supports deliberate upward discovery without using it as a fallback for a missing selection", async () => {
    const root = await workspace("Discovered");
    const nested = path.join(root, "src");
    await mkdir(nested);
    const server = await build({ cwd: nested, discoverWorkspace: true });
    expect((await get(server, "/api/app")).json().workspace.name).toBe("Discovered");
  });
  it("initializes an existing selected folder, creates all state folders and reopens it", async () => {
    const root = await temp();
    const server = await build();
    const uninitialized = await post(server, "/api/app/workspace/open", { root });
    expect(uninitialized.json().error.code).toBe("WORKSPACE_NOT_INITIALIZED");
    expect((await get(server, "/api/app")).json().workspace.selected).toBe(false);
    expect((await post(server, "/api/app/workspace/create", { root, name: "My Startup" })).json().workspace)
      .toMatchObject({ selected: true, initialized: true, name: "My Startup" });
    for (const directory of ["teams", "knowledge", "memory", "sessions", "state"]) {
      expect(fs.statSync(path.join(root, ".daycrew", directory)).isDirectory()).toBe(true);
    }
    expect((await get(server, "/api/teams")).json()).toEqual([]);
    expect((await get(server, "/api/teams/dashboard")).json()).toBeNull();
    const saved = await readFile(path.join(root, ".daycrew", "workspace.json"), "utf8");
    const conflict = await post(server, "/api/app/workspace/create", { root, name: "Overwrite" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toEqual({
      code: "WORKSPACE_ALREADY_INITIALIZED",
      message: "This folder is already a DayCrew Workspace. Open it instead.",
    });
    expect(conflict.body).not.toContain(root);
    expect(await readFile(path.join(root, ".daycrew", "workspace.json"), "utf8")).toBe(saved);
    expect((await post(server, "/api/app/workspace/open", { root })).statusCode).toBe(200);
  });
  it("reports a missing remembered workspace and allows recovery without recreating it", async () => {
    const root = await workspace("Vanished");
    const appConfigDir = await temp();
    const first = await build({ appConfigDir });
    await post(first, "/api/app/workspace/open", { root });
    await rm(root, { recursive: true });
    const server = await build({ appConfigDir, cwd: repository, discoverWorkspace: true });
    expect((await get(server, "/api/app")).json().issue.code).toBe("WORKSPACE_NOT_FOUND");
    const response = await get(server, "/api/teams");
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toMatch(/ENOENT|workspaceRoot/);
    expect(fs.existsSync(root)).toBe(false);
    const replacement = await workspace("Replacement");
    expect((await post(server, "/api/app/workspace/open", { root: replacement })).json().workspace.name).toBe("Replacement");
  });
  it.each(["{not-json", "{}", '{"id":"bad"}'])("sanitizes malformed workspace.json (%s)", async (source) => {
    const root = await temp();
    await mkdir(path.join(root, ".daycrew"));
    await writeFile(path.join(root, ".daycrew", "workspace.json"), source);
    const server = await build({ workspaceRoot: root });
    const response = await get(server, "/api/teams/dashboard");
    expect(response.json().error.code).toBe("WORKSPACE_STATE_INVALID");
    expect(response.body).not.toMatch(/ENOENT|Unexpected|rootPath|workspaceRoot/);
  });
  it.each(["EACCES", "EPERM"])("handles a real filesystem access operation failing with %s", async (code) => {
    const root = await workspace("Restricted");
    const actual = await vi.importActual<typeof fs>("node:fs");
    vi.mocked(fs.accessSync).mockImplementation((candidate, mode) => {
      if (candidate === root) throw Object.assign(new Error("OS path detail: " + root), { code });
      actual.accessSync(candidate, mode);
    });
    const server = await build({ workspaceRoot: root });
    expect((await get(server, "/api/app")).json().issue.code).toBe("WORKSPACE_PERMISSION_DENIED");
    const response = await get(server, "/api/teams");
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(root);
  });
  it("keeps A and B isolated even with identical Workspace/Team ids and stale browser requests", async () => {
    const a = await workspace("Same", "Shared Team");
    const b = await workspace("Same", "Shared Team");
    await new TeamService(a).update("shared-team", { name: "Team Alpha" });
    await new TeamService(b).update("shared-team", { name: "Team Beta" });
    await new KnowledgeService(a).add("shared-team", "Alpha knowledge", "Only A");
    await new MemoryService(a).remember("shared-team", "manager", "Alpha memory");
    const server = await build();
    const selectedA = (await post(server, "/api/app/workspace/open", { root: a })).json();
    await post(server, "/api/teams/shared-team/goals", { goal: "Alpha goal" });
    expect((await get(server, "/api/teams/dashboard")).body).toContain("Alpha");
    const selectedB = (await post(server, "/api/app/workspace/open", { root: b })).json();
    expect(selectedA.workspace.key).not.toBe(selectedB.workspace.key);
    const dashboard = (await get(server, "/api/teams/dashboard", selectedB.workspace.selectionId)).json();
    expect(dashboard.team.name).toBe("Team Beta");
    expect(dashboard.knowledge).toEqual([]);
    expect(dashboard.tasks).toEqual([]);
    expect(dashboard.sessions).toEqual([]);
    expect(dashboard.activity).toEqual([]);
    for (const route of ["/api/teams", "/api/teams/dashboard", "/api/tasks", "/api/work", "/api/needs-you", "/api/activity", "/api/approvals", "/api/teams/shared-team/members/manager/memory"]) {
      expect((await get(server, route)).body).not.toContain("Alpha");
      expect((await get(server, route, selectedA.workspace.selectionId)).json().error.code).toBe("WORKSPACE_CHANGED");
    }
    const staleWrite = await server.inject({ method: "POST", url: "/api/teams/shared-team/goals", headers: { "x-daycrew-workspace": selectedA.workspace.selectionId }, payload: { goal: "Wrong Workspace" } });
    expect(staleWrite.statusCode).toBe(409);
    expect((await get(server, "/api/work")).json()).toEqual([]);
    await post(server, "/api/app/workspace/open", { root: a });
    expect((await get(server, "/api/teams/dashboard")).body).toContain("Alpha");
  });
  it("discards an A response that completes after switching to B", async () => {
    const a = await workspace("A", "Alpha");
    const b = await workspace("B", "Beta");
    const server = await build({ workspaceRoot: a });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    server.addHook("preHandler", async (request) => {
      if (request.url === "/api/teams/dashboard") { entered(); await blocked; }
    });
    const inFlight = get(server, "/api/teams/dashboard").then((response) => response);
    await ready;
    await post(server, "/api/app/workspace/open", { root: b });
    release();
    const response = await inFlight;
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("Alpha");
  });
  it("rejects path traversal, arbitrary pack paths, state junctions, and remote browser access", async () => {
    const root = await workspace("Safe", "Team");
    const outside = await temp();
    const server = await build({ workspaceRoot: root });
    for (const id of ["..%2F..%2Foutside", "..%5C..%5Coutside", "C%3A%5Csecret"]) {
      const response = await get(server, "/api/teams/" + id);
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain("ENOENT");
    }
    expect((await post(server, "/api/teams/install", { packId: "../../outside" })).statusCode).toBe(400);
    expect((await post(server, "/api/app/workspace/open", { root: "packages/server" })).json().error.code).toBe("WORKSPACE_PATH_INVALID");
    await symlink(outside, path.join(root, ".daycrew", "knowledge", "escape"), process.platform === "win32" ? "junction" : "dir");
    expect((await get(server, "/api/teams/escape%2Fsecret")).statusCode).toBe(409);
    for (const headers of [{ origin: "https://untrusted.example" }, { host: "rebind.example" }, { "sec-fetch-site": "cross-site" }]) {
      expect((await server.inject({ method: "POST", url: "/api/app/workspace/open", payload: { root }, headers })).statusCode).toBe(403);
    }
  });
  it("chooses OS-local config directories and permits an absolute override", () => {
    const home = path.resolve("test-home");
    expect(appConfigDirectory("win32", {}, home)).toBe(path.join(home, "AppData", "Local", "DayCrew"));
    expect(appConfigDirectory("darwin", {}, home)).toBe(path.join(home, "Library", "Application Support", "DayCrew"));
    expect(appConfigDirectory("linux", {}, home)).toBe(path.join(home, ".config", "daycrew"));
    expect(appConfigDirectory("linux", { XDG_CONFIG_HOME: home }, home)).toBe(path.join(home, "daycrew"));
    expect(appConfigDirectory("win32", { DAYCREW_APP_CONFIG_DIR: home }, home)).toBe(home);
  });
});
