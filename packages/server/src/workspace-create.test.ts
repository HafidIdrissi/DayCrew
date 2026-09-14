import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceService } from "@daycrew/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer, type ServerOptions } from "./index.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});

const servers: ReturnType<typeof buildServer>[] = [];
const directories: string[] = [];
const temp = async () => {
  const root = fs.realpathSync(await mkdtemp(path.join(tmpdir(), "daycrew-create-")));
  directories.push(root);
  return root;
};
const build = async (options: ServerOptions = {}) => {
  const server = buildServer({ appConfigDir: options.appConfigDir ?? await temp(), ...options });
  servers.push(server);
  await server.ready();
  return server;
};
const get = (server: ReturnType<typeof buildServer>, url: string, selectionId?: string) =>
  server.inject({ method: "GET", url, ...(selectionId ? { headers: { "x-daycrew-workspace": selectionId } } : {}) });
const create = (server: ReturnType<typeof buildServer>, root: string, name = "My Workspace") =>
  server.inject({ method: "POST", url: "/api/app/workspace/create", payload: { root, name } });

afterEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  vi.mocked(fs.mkdirSync).mockImplementation(actual.mkdirSync);
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("creating the first Workspace", () => {
  it("creates a folder that does not exist yet and selects it", async () => {
    const root = path.join(await temp(), "daycrew-first-run-test");
    const server = await build();
    const response = await create(server, root);
    expect(response.statusCode).toBe(200);
    expect(response.json().workspace).toMatchObject({ selected: true, initialized: true, name: "My Workspace" });
    expect(fs.statSync(path.join(root, ".daycrew", "workspace.json")).isFile()).toBe(true);
    for (const directory of ["teams", "knowledge", "memory", "sessions", "skills", "state"]) {
      expect(fs.statSync(path.join(root, ".daycrew", directory)).isDirectory()).toBe(true);
    }
    // The picker asked for a Workspace, not a filesystem tour.
    expect(response.body).not.toContain(root);
  });

  it("recovers from a remembered Workspace that no longer exists", async () => {
    const missing = await temp();
    await new WorkspaceService(missing).create("Vanished");
    const appConfigDir = await temp();
    const first = await build({ appConfigDir });
    await first.inject({ method: "POST", url: "/api/app/workspace/open", payload: { root: missing } });
    await rm(missing, { recursive: true, force: true });

    const server = await build({ appConfigDir });
    const before = (await get(server, "/api/app")).json();
    expect(before.workspace).toMatchObject({ selected: true, initialized: false });
    expect(before.issue.code).toBe("WORKSPACE_NOT_FOUND");

    const replacement = path.join(await temp(), "replacement");
    const created = (await create(server, replacement)).json();
    expect(created.workspace).toMatchObject({ selected: true, initialized: true, name: "My Workspace" });
    expect(created.issue).toBeUndefined();

    // The next poll must agree: no lingering missing-Workspace state anywhere.
    const after = (await get(server, "/api/app")).json();
    expect(after.workspace).toMatchObject({ selected: true, initialized: true, name: "My Workspace" });
    expect(after.issue).toBeUndefined();
    expect((await get(server, "/api/teams", after.workspace.selectionId)).json()).toEqual([]);
  });

  it("persists the new selection across a restart", async () => {
    const appConfigDir = await temp();
    const root = path.join(await temp(), "persisted");
    const first = await build({ appConfigDir });
    await create(first, root, "Persisted");
    expect(JSON.parse(await readFile(path.join(appConfigDir, "app.json"), "utf8")).selectedWorkspace)
      .toBe(fs.realpathSync(root));
    const restarted = await build({ appConfigDir });
    expect((await get(restarted, "/api/app")).json().workspace)
      .toMatchObject({ selected: true, initialized: true, name: "Persisted" });
  });

  it("issues a fresh selection token and retires the previous one", async () => {
    const server = await build();
    const before = (await get(server, "/api/app")).json().workspace.selectionId;
    const created = (await create(server, path.join(await temp(), "tokened"))).json().workspace;
    expect(created.selectionId).not.toBe(before);
    expect((await get(server, "/api/teams", created.selectionId)).statusCode).toBe(200);
    const stale = await get(server, "/api/teams", before);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("WORKSPACE_CHANGED");
  });

  it("does not let a Workspace opened before the create overwrite the new selection", async () => {
    const previous = await temp();
    await new WorkspaceService(previous).create("Previous");
    const server = await build();
    const selectedPrevious = (await server.inject({
      method: "POST", url: "/api/app/workspace/open", payload: { root: previous },
    })).json().workspace;
    const created = (await create(server, path.join(await temp(), "winner"), "Winner")).json().workspace;
    expect((await get(server, "/api/app")).json().workspace.name).toBe("Winner");
    const stale = await get(server, "/api/teams/dashboard", selectedPrevious.selectionId);
    expect(stale.statusCode).toBe(409);
    expect((await get(server, "/api/app")).json().workspace.selectionId).toBe(created.selectionId);
  });

  it("applies concurrent create requests one at a time without corrupting state", async () => {
    const root = path.join(await temp(), "double-submit");
    const server = await build();
    const [first, second] = await Promise.all([create(server, root), create(server, root)]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    expect(conflict.json().error.code).toBe("WORKSPACE_ALREADY_INITIALIZED");
    expect((await get(server, "/api/app")).json().workspace).toMatchObject({ initialized: true, name: "My Workspace" });
  });

  it.each([
    ["a relative path", "packages/server", 400, "WORKSPACE_PATH_INVALID"],
    ["an empty path", "", 400, "REQUEST_INVALID"],
  ])("rejects %s", async (_label, root, status, code) => {
    const server = await build();
    const response = await create(server, root);
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
  });

  it("rejects a path that is a file, and a path whose parent is a file", async () => {
    const root = await temp();
    const file = path.join(root, "notes.txt");
    await writeFile(file, "");
    const server = await build();
    for (const candidate of [file, path.join(file, "inside")]) {
      const response = await create(server, candidate);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("WORKSPACE_PATH_INVALID");
    }
    expect(fs.statSync(file).isFile()).toBe(true);
  });

  it.each(["EACCES", "EPERM"])("reports %s while creating the folder as a permission problem", async (code) => {
    const root = path.join(await temp(), "denied");
    const actual = await vi.importActual<typeof fs>("node:fs");
    vi.mocked(fs.mkdirSync).mockImplementation(((candidate: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (candidate === root) throw Object.assign(new Error("OS path detail: " + root), { code });
      return actual.mkdirSync(candidate, options);
    }) as typeof fs.mkdirSync);
    const server = await build();
    const response = await create(server, root);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("WORKSPACE_PERMISSION_DENIED");
    expect(response.body).not.toContain(root);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("keeps two Workspaces created in a row fully isolated", async () => {
    const server = await build();
    const a = (await create(server, path.join(await temp(), "a"), "Alpha")).json().workspace;
    await server.inject({
      method: "POST", url: "/api/teams", headers: { "x-daycrew-workspace": a.selectionId },
      payload: { name: "Alpha Team", members: [{ id: "manager", name: "Manager", role: "Manager", instructions: "Coordinate.", isManager: true, engine: { mode: "auto" } }] },
    });
    const b = (await create(server, path.join(await temp(), "b"), "Beta")).json().workspace;
    expect(b.key).not.toBe(a.key);
    expect((await get(server, "/api/teams", b.selectionId)).json()).toEqual([]);
  });
});
