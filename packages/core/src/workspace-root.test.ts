import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalizeWorkspaceRoot, prepareWorkspaceRoot, resolveWorkspaceRoot } from "./workspace-root.js";
import { statePath } from "./storage.js";
import { WorkspaceService } from "./workspace.js";
import { workspaceError } from "./workspace-errors.js";

const directories: string[] = [];
const temporary = async () => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "daycrew-root-")));
  directories.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical WorkspaceRoot", () => {
  it("does not discover the application or cwd by default", () => {
    expect(resolveWorkspaceRoot()).toBeNull();
  });
  it("prioritizes an explicit root over remembered selection and discovery", async () => {
    const a = await temporary();
    const b = await temporary();
    expect(resolveWorkspaceRoot({ explicitRoot: a, selectedRoot: b, discoveryStart: b }))
      .toEqual({ workspaceRoot: a, source: "explicit" });
    expect(resolveWorkspaceRoot({ selectedRoot: b, discoveryStart: a }))
      .toEqual({ workspaceRoot: b, source: "app-config" });
  });
  it("only discovers the nearest marker when explicitly requested", async () => {
    const root = await temporary();
    const inner = path.join(root, "project");
    const nested = path.join(inner, "src");
    await mkdir(nested, { recursive: true });
    await new WorkspaceService(root).create("Outer");
    await new WorkspaceService(inner).create("Inner");
    expect(resolveWorkspaceRoot({ discoveryStart: nested })?.workspaceRoot).toBe(inner);
  });
  it("does not treat a DayCrew source manifest as a workspace", async () => {
    const root = await temporary();
    await writeFile(path.join(root, "package.json"), '{"name":"daycrew"}');
    expect(resolveWorkspaceRoot({ discoveryStart: root })).toBeNull();
  });
  it("rejects relative roots, nonexistent folders, and files", async () => {
    const root = await temporary();
    const file = path.join(root, "file");
    await writeFile(file, "");
    for (const candidate of ["packages/server", "", file, path.join(root, "missing")]) {
      expect(() => canonicalizeWorkspaceRoot(candidate)).toThrow();
    }
  });
  it("creates the folder a new Workspace is meant to live in", async () => {
    const root = await temporary();
    const missing = path.join(root, "new", "workspace");
    expect(() => canonicalizeWorkspaceRoot(missing)).toThrow();
    expect(prepareWorkspaceRoot(missing)).toBe(realpathSync(missing));
  });
  it("leaves an existing folder and its contents untouched", async () => {
    const root = await temporary();
    await writeFile(path.join(root, "keep.txt"), "kept");
    expect(prepareWorkspaceRoot(root)).toBe(root);
    expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("kept");
  });
  it("refuses to turn a relative path, a file, or a path under a file into a Workspace", async () => {
    const root = await temporary();
    const file = path.join(root, "file");
    await writeFile(file, "");
    for (const candidate of ["packages/server", "", file, path.join(file, "inside")]) {
      expect(() => prepareWorkspaceRoot(candidate)).toThrow(
        expect.objectContaining({ code: "WORKSPACE_PATH_INVALID" }) as Error,
      );
    }
  });
  it("canonicalizes the selected directory and ignores stale rootPath metadata", async () => {
    const root = await temporary();
    const workspace = await new WorkspaceService(root).create("Moved");
    await writeFile(statePath(root, "workspace.json"), JSON.stringify({ ...workspace, rootPath: "/old/location" }));
    expect(canonicalizeWorkspaceRoot(path.join(root, ".", "nested", ".."))).toBe(root);
    expect((await new WorkspaceService(root).load()).rootPath).toBe(root);
  });
  it.each(["..", "../outside", "..\\outside", "/etc/passwd", "C:\\secret", "file:stream", "nul.json", "file.", "file\0"])(
    "rejects escaping or unsafe state component %s", async (segment) => {
      const root = await temporary();
      expect(() => statePath(root, "teams", segment)).toThrow();
    },
  );
  it("rejects symlinks/junctions inside state and accepts a canonical root alias", async () => {
    const root = await temporary();
    const outside = await temporary();
    await symlink(outside, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    expect(canonicalizeWorkspaceRoot(path.join(root, "alias"))).toBe(outside);
    await symlink(outside, path.join(root, ".daycrew"), process.platform === "win32" ? "junction" : "dir");
    expect(() => statePath(root, "workspace.json")).toThrow();
    await rm(path.join(root, ".daycrew"));
    await new WorkspaceService(root).create("Safe");
    await symlink(outside, statePath(root, "memory", "alias"), process.platform === "win32" ? "junction" : "dir");
    expect(() => statePath(root, "memory", "alias", "entry.json")).toThrow();
  });
  it.each(["EACCES", "EPERM"])("maps %s to a safe permission error", (code) => {
    const error = workspaceError(Object.assign(new Error("raw OS detail"), { code }));
    expect(error.code).toBe("WORKSPACE_PERMISSION_DENIED");
    expect(error.message).not.toContain("raw OS detail");
  });
});