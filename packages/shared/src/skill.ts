import { z } from "zod";

import { IdSchema, TimestampSchema } from "./domain.js";

export const SkillCapabilitySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, "Expected a capability identifier");
export type SkillCapability = z.infer<typeof SkillCapabilitySchema>;

export const SkillSourceSchema = z
  .object({
    type: IdSchema,
    reference: z.string().trim().min(1).optional(),
  })
  .strict();
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const SkillSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    version: z.string().trim().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i, "Expected a semantic version"),
    author: z.string().trim().min(1).max(100).optional(),
    source: SkillSourceSchema,
    instructions: z.string().trim().min(1).max(6_000),
    tags: z.array(IdSchema).max(12),
    requiredCapabilities: z.array(SkillCapabilitySchema).max(12),
    recommendedTools: z.array(IdSchema).max(12),
    compatibleRoles: z.array(z.string().trim().min(1).max(80)).max(12),
    conflictsWith: z.array(IdSchema).max(12).optional(),
    createdAt: TimestampSchema.optional(),
  })
  .strict();
export type Skill = z.infer<typeof SkillSchema>;

export const SkillManifestSchema = SkillSchema.omit({ instructions: true, source: true }).extend({
  source: SkillSourceSchema.optional(),
  instructionsFile: z.literal("instructions.md").default("instructions.md"),
}).strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const SkillCompatibilitySchema = z
  .object({
    compatible: z.boolean(),
    missingCapabilities: z.array(SkillCapabilitySchema),
    reason: z.string().optional(),
    resolution: z.string().optional(),
  })
  .strict();
export type SkillCompatibility = z.infer<typeof SkillCompatibilitySchema>;

export const MemberSkillSchema = z
  .object({
    skill: SkillSchema,
    scope: z.enum(["permanent", "temporary"]),
    taskId: IdSchema.optional(),
    compatibility: SkillCompatibilitySchema,
  })
  .strict();
export type MemberSkill = z.infer<typeof MemberSkillSchema>;

export const SkillRecommendationSchema = z
  .object({
    skill: SkillSchema,
    reason: z.string().trim().min(1),
    compatibility: SkillCompatibilitySchema,
  })
  .strict();
export type SkillRecommendation = z.infer<typeof SkillRecommendationSchema>;
