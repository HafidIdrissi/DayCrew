import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("DayCrew CLI", () => {
  it("discovers an initialized Workspace above the CLI cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-cli-discovery-"));
    const nested = path.join(root, "packages", "tooling");
    directories.push(root);
    await mkdir(nested, { recursive: true });
    await runCli(["workspace", "create", "Discovered", "--path", root]);

    expect(JSON.parse(await runCli(["workspace", "show"], nested))).toMatchObject({
      name: "Discovered",
      rootPath: root,
    });
  });

  it("exercises the M1 Workspace and bundled Team flow", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-cli-"));
    directories.push(root);

    expect(JSON.parse(await runCli(["workspace", "create", "Demo", "--path", root]))).toMatchObject({
      id: "demo",
      name: "Demo",
    });
    expect(
      JSON.parse(await runCli(["team", "install", "software-development", "--path", root])),
    ).toMatchObject({ id: "software-development" });
    expect(JSON.parse(await runCli(["team", "list", "--path", root]))).toHaveLength(1);
    const work = JSON.parse(
      await runCli([
        "work",
        "start",
        "software-development",
        "Build authentication",
        "--path",
        root,
      ]),
    ) as { session: { status: string }; tasks: Array<{ status: string }> };
    expect(work.session.status).toBe("completed");
    expect(work.tasks.every((task) => task.status === "done")).toBe(true);
    expect(JSON.parse(await runCli(["activity", "list", "--path", root]))).not.toHaveLength(0);
  });
});
