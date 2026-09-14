import { describe, expect, it } from "vitest";

import {
  ENGINE_REGISTRY,
  EngineDescriptorSchema,
  findEngine,
  readinessState,
  validateEngineModel,
} from "./engine.js";
import { EngineSelectionSchema } from "./domain.js";

describe("AI Engine registry", () => {
  it("declares every engine in a shape screens can render without special cases", () => {
    expect(ENGINE_REGISTRY.length).toBeGreaterThan(0);
    for (const engine of ENGINE_REGISTRY) expect(() => EngineDescriptorSchema.parse(engine)).not.toThrow();
    expect(new Set(ENGINE_REGISTRY.map((engine) => engine.id)).size).toBe(ENGINE_REGISTRY.length);
    // Only the adapter with an enforceable safety boundary may be chosen automatically.
    expect(ENGINE_REGISTRY.filter((engine) => engine.autoEligible).map((engine) => engine.id)).toEqual(["claude-code"]);
  });

  it("declares only local CLI engines and never a credential", () => {
    expect(ENGINE_REGISTRY.every((engine) => engine.kind === "cli" || engine.kind === "simulated")).toBe(true);
    expect(findEngine("cursor")).toMatchObject({ kind: "cli", binary: "cursor-agent" });
    expect(findEngine("grok")).toMatchObject({ kind: "cli", binary: "grok", autoEligible: false });
    // Authentication belongs to each CLI, so no descriptor may carry a credential
    // field. The prose may still say DayCrew never asks for a key.
    for (const engine of ENGINE_REGISTRY) {
      expect(Object.keys(engine)).not.toContain("credential");
      expect(Object.keys(engine.setup ?? {})).not.toContain("envVar");
    }
    for (const engine of ENGINE_REGISTRY) {
      if (engine.kind === "simulated") continue;
      expect(engine.setup?.install.length).toBeGreaterThan(0);
      expect(engine.setup?.authCheck).toBeTruthy();
    }
  });

  it("names the Antigravity bridge apart from the separate Gemini CLI", () => {
    const gemini = findEngine("gemini");
    expect(gemini?.name).toContain("Antigravity");
    expect(gemini?.name).not.toMatch(/Gemini CLI/);
    expect(gemini?.limitations.join(" ")).toMatch(/not the separate Gemini CLI/);
  });

  it("collapses readiness into a state that never guesses past the evidence", () => {
    expect(readinessState({ id: "codex", ready: true, installed: true, authenticated: true, message: "" })).toBe("ready");
    expect(readinessState({ id: "codex", ready: false, installed: true, authenticated: false, message: "" })).toBe("signed-out");
    expect(readinessState({ id: "codex", ready: false, installed: false, message: "" })).toBe("not-installed");
    // A failed check proves nothing: it must read as unknown, not as missing.
    expect(readinessState({ id: "codex", ready: false, message: "" })).toBe("unknown");
    expect(readinessState({ id: "codex", ready: false, installed: true, message: "" })).toBe("unknown");
  });

  it("accepts listed models and any documented custom identifier", () => {
    const claude = findEngine("claude-code")!;
    expect(validateEngineModel(claude, "sonnet")).toEqual({ ok: true });
    expect(validateEngineModel(claude, "claude-opus-5")).toEqual({ ok: true });
    // Claude Code documents full model names beyond the aliases DayCrew lists.
    expect(validateEngineModel(claude, "claude-something-new")).toEqual({ ok: true });
    expect(validateEngineModel(claude, undefined)).toEqual({ ok: true });
  });

  it("rejects a model an engine cannot express, and rejects unsafe identifiers", () => {
    const gemini = findEngine("gemini")!;
    expect(validateEngineModel(gemini, "pro")).toEqual({ ok: true });
    const unsupported = validateEngineModel(gemini, "gpt-5");
    expect(unsupported.ok).toBe(false);
    expect(unsupported.ok === false && unsupported.message).toContain("flash");
    const injection = validateEngineModel(findEngine("cursor")!, "gpt-5 --dangerously");
    expect(injection.ok).toBe(false);
  });

  it("refuses a model for an engine that takes none", () => {
    const demo = findEngine("demo")!;
    expect(validateEngineModel(demo, "anything").ok).toBe(false);
    expect(validateEngineModel(demo, undefined)).toEqual({ ok: true });
  });

  it("validates against the live catalogue when one was read", () => {
    const cursor = findEngine("cursor")!;
    const live = [{ id: "composer-1", label: "composer-1" }];
    expect(validateEngineModel(cursor, "composer-1", live)).toEqual({ ok: true });
    // Cursor publishes no canonical list, so an unlisted id stays acceptable.
    expect(validateEngineModel(cursor, "gpt-5", live)).toEqual({ ok: true });
  });

  it("stores a model on a Member only in a shape a CLI can safely receive", () => {
    expect(EngineSelectionSchema.parse({ mode: "manual", provider: "cursor", model: "composer-1" }).model).toBe("composer-1");
    expect(() => EngineSelectionSchema.parse({ mode: "manual", provider: "codex", model: "a b" })).toThrow();
    expect(() => EngineSelectionSchema.parse({ mode: "manual", provider: "codex", model: "--model" })).toThrow();
    // An agent saved before model selection existed still loads.
    expect(EngineSelectionSchema.parse({ mode: "manual", provider: "codex" }).model).toBeUndefined();
    expect(EngineSelectionSchema.parse({ mode: "auto" })).toEqual({ mode: "auto" });
  });
});
