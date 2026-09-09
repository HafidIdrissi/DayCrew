import { describe, expect, it } from "vitest";

import { PackManifestSchema, TeamDefinitionSchema } from "./team-pack.js";

const member = {
  id: "lead",
  title: "Lead Architect",
  role: "lead",
  instructions: "instructions/lead.md",
  orchestrator: true,
  permissionPolicy: { mode: "ask" as const },
};

describe("team pack schemas", () => {
  it("accepts the documented manifest and rejects unknown keys", () => {
    const manifest = {
      schema: "daycrew.pack/v1",
      id: "software-development",
      name: "Software Development",
      version: "1.0.0",
      description: "A software delivery crew.",
      author: "DayCrew",
      license: "MIT",
      tags: ["engineering", "coding"],
      categories: ["software"],
    };

    expect(PackManifestSchema.parse(manifest).id).toBe(
      "software-development",
    );
    expect(() =>
      PackManifestSchema.parse({ ...manifest, futureKey: true }),
    ).toThrow();
  });

  it("requires exactly one orchestrator", () => {
    expect(
      TeamDefinitionSchema.parse({
        schema: "daycrew.team/v1",
        engines: { lead: { default: "mock" } },
        members: [member],
      }).members[0]?.orchestrator,
    ).toBe(true);

    expect(() =>
      TeamDefinitionSchema.parse({
        schema: "daycrew.team/v1",
        members: [{ ...member, orchestrator: false }],
      }),
    ).toThrow("exactly one orchestrator");
  });

  it("rejects member roles absent from a declared engine map", () => {
    expect(() =>
      TeamDefinitionSchema.parse({
        schema: "daycrew.team/v1",
        engines: { qa: { default: "mock" } },
        members: [member],
      }),
    ).toThrow("Unknown engine role");
  });
});
