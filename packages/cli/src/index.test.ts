import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("DayCrew CLI", () => {
  it("validates a contributor Skill without requiring an initialized Workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-cli-skill-"));
    const skillRoot = path.join(root, "fixture-review");
    directories.push(root);
    await mkdir(skillRoot);
    await writeFile(path.join(skillRoot, "skill.json"), JSON.stringify({
      id: "fixture-review",
      name: "Fixture Review",
      description: "Review a fixture.",
      version: "1.0.0",
      tags: ["review"],
      requiredCapabilities: [],
      recommendedTools: [],
      compatibleRoles: ["QA Engineer"],
    }), "utf8");
    await writeFile(path.join(skillRoot, "instructions.md"), "Review the fixture carefully.", "utf8");

    expect(JSON.parse(await runCli(["skill", "validate", skillRoot], root))).toMatchObject({
      id: "fixture-review",
      instructions: "Review the fixture carefully.",
    });
  });

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

  it("creates an isolated, explicitly labelled Demo Workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "daycrew-cli-demo-"));
    directories.push(root);
    const demo = JSON.parse(await runCli(["demo", "create", "--path", root])) as {
      mode: string; label: string; team: { members: Array<{ engine: { provider?: string } }> };
    };
    expect(demo.mode).toBe("demo");
    expect(demo.label).toContain("not real AI execution");
    expect(demo.team.members.every((member) => member.engine.provider === "demo")).toBe(true);
  });
});
