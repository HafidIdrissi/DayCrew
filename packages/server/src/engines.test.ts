import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { TeamService, WorkspaceService } from "@daycrew/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "./index.js";

const directories: string[] = [];
const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-engines-"));
  directories.push(root);
  await new WorkspaceService(root).create("Engine QA");
  await new TeamService(root).create({ id: "crew", name: "Crew", members: [
    { id: "manager", name: "Alex", role: "Manager", instructions: "Coordinate", isManager: true, engine: { mode: "auto" } },
  ] });
  const configDir = path.join(root, "config");
  const server = buildServer({ workspaceRoot: root, appConfigDir: configDir });
  servers.push(server);
  return { root, configDir, server };
};

type ServedEngine = {
  id: string;
  name: string;
  kind: string;
  binary?: string;
  autoEligible: boolean;
  modelDiscovery: string;
  setup?: { signInCommand?: string; authDetectable: boolean; install: { platform: string; command: string }[] };
};

describe("AI Engine catalogue API", () => {
  it("serves a CLI-only registry with install and sign-in guidance and no credential surface", async () => {
    const { server } = await fixture();
    const engines: ServedEngine[] = (await server.inject({ method: "GET", url: "/api/engines" })).json();
    const ids = engines.map((engine) => engine.id);
    expect(ids).toEqual(["claude-code", "codex", "gemini", "cursor", "grok", "demo"]);
    expect(engines.every((engine) => engine.kind === "cli" || engine.kind === "simulated")).toBe(true);
    // Auto stays pinned to the one adapter whose approval boundary is enforceable.
    expect(engines.filter((engine) => engine.autoEligible).map((engine) => engine.id)).toEqual(["claude-code"]);

    const cursor = engines.find((engine) => engine.id === "cursor");
    expect(cursor).toMatchObject({ binary: "cursor-agent", modelDiscovery: "dynamic" });
    expect(cursor?.setup?.signInCommand).toBe("cursor-agent login");
    expect(cursor?.setup?.install.some((step) => /win32|PowerShell/i.test(step.platform))).toBe(true);

    const grok = engines.find((engine) => engine.id === "grok");
    expect(grok).toMatchObject({ binary: "grok", modelDiscovery: "dynamic", autoEligible: false });
    expect(grok?.setup?.signInCommand).toBe("grok login --device-code");

    // DayCrew must never serve a credential field, though the guidance text may say
    // that DayCrew never asks for a key.
    for (const engine of engines as unknown as Record<string, unknown>[]) {
      expect(Object.keys(engine)).not.toContain("credential");
      expect(Object.keys(engine)).not.toContain("requiresCredential");
      expect(Object.keys(engine)).not.toContain("configured");
    }
    expect(engines.some((engine) => engine.kind === "api")).toBe(false);
  });

  it("names the Antigravity bridge honestly instead of calling it the Gemini CLI", async () => {
    const { server } = await fixture();
    const engines: ServedEngine[] = (await server.inject({ method: "GET", url: "/api/engines" })).json();
    const gemini = engines.find((engine) => engine.id === "gemini");
    expect(gemini?.name).toContain("Antigravity");
    expect(gemini?.name).not.toMatch(/Gemini CLI/);
    expect(JSON.stringify(gemini)).toMatch(/not the separate Gemini CLI/);
  });

  it("removes the API-key routes that the direct-integration approach had added", async () => {
    const { server } = await fixture();
    for (const [method, url] of [
      ["PUT", "/api/settings/engines/cursor/credential"],
      ["DELETE", "/api/settings/engines/cursor/credential"],
      ["POST", "/api/settings/engines/cursor/test"],
    ] as const) {
      const response = await server.inject({ method, url, payload: { apiKey: "x" } });
      expect(response.statusCode).toBe(404);
    }
  });

  it("returns a maintained list for engines with no listing command", async () => {
    const { server } = await fixture();
    const claude = (await server.inject({ method: "GET", url: "/api/engines/claude-code/models" })).json();
    expect(claude).toMatchObject({ engineId: "claude-code", source: "catalog", allowsCustomModelId: true });
    expect(claude.models.map((model: { id: string }) => model.id)).toContain("sonnet");
    const gemini = (await server.inject({ method: "GET", url: "/api/engines/gemini/models" })).json();
    expect(gemini.allowsCustomModelId).toBe(false);
    expect(gemini.models.map((model: { id: string }) => model.id)).toEqual(["flash", "flash_lite", "pro"]);
    const grok = (await server.inject({ method: "GET", url: "/api/engines/grok/models" })).json();
    expect(grok.models.map((model: { id: string }) => model.id)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(grok.allowsCustomModelId).toBe(true);
    expect((await server.inject({ method: "GET", url: "/api/engines/not-an-engine/models" })).statusCode).toBe(400);
  });

  it("explains a model list it could not read without blocking agent setup", async () => {
    const { server } = await fixture();
    // cursor-agent is not installed in CI, so this exercises the honest fallback.
    const cursor = (await server.inject({ method: "GET", url: "/api/engines/cursor/models" })).json();
    expect(cursor.engineId).toBe("cursor");
    if (cursor.source === "catalog") {
      expect(typeof cursor.warning).toBe("string");
      expect(cursor.warning.length).toBeGreaterThan(0);
    }
    // Either way the form can still offer a custom identifier.
    expect(cursor.allowsCustomModelId).toBe(true);
  });

  it("reports readiness as three separate facts and never invents a missing one", async () => {
    const { server } = await fixture();
    const detections = (await server.inject({ method: "POST", url: "/api/settings/engines/detect" })).json();
    expect(detections.map((item: { id: string }) => item.id)).toEqual(["claude-code", "codex", "gemini", "cursor", "grok"]);
    for (const detection of detections) {
      expect(typeof detection.ready).toBe("boolean");
      expect(typeof detection.message).toBe("string");
      // installed/authenticated are omitted when DayCrew could not determine them.
      if ("installed" in detection) expect(typeof detection.installed).toBe("boolean");
      if ("authenticated" in detection) expect(typeof detection.authenticated).toBe("boolean");
      // A ready engine must have proved both facts.
      if (detection.ready) expect([detection.installed, detection.authenticated]).toEqual([true, true]);
    }
  });
});
