import { z } from "zod";

import {
  IdentifierSchema,
  PermissionPolicySchema,
  RunLimitsSchema,
} from "./models.js";

const KebabCaseSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected a kebab-case identifier");
const SemverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "Expected a semantic version",
  );

export const PackManifestSchema = z
  .object({
    schema: z.literal("daycrew.pack/v1"),
    id: KebabCaseSchema,
    name: z.string().trim().min(1),
    version: SemverSchema,
    description: z.string().trim().min(1),
    author: z.string().trim().min(1),
    license: z.string().trim().min(1),
    homepage: z.string().url().optional(),
    tags: z.array(KebabCaseSchema).optional(),
    minDayCrewVersion: SemverSchema.optional(),
    // The example and §6 vocabulary currently disagree. Keep validation safe and
    // forward-compatible until the architecture ruling narrows this value.
    categories: z.array(KebabCaseSchema).optional(),
  })
  .strict();
export type PackManifest = z.infer<typeof PackManifestSchema>;

export const TeamEngineSchema = z
  .object({
    default: IdentifierSchema,
  })
  .strict();
export type TeamEngine = z.infer<typeof TeamEngineSchema>;

export const TeamMemberSchema = z
  .object({
    id: IdentifierSchema,
    title: z.string().trim().min(1),
    role: IdentifierSchema,
    instructions: z.string().trim().min(1),
    orchestrator: z.boolean().default(false),
    permissionPolicy: PermissionPolicySchema,
    allowedTools: z.array(IdentifierSchema).optional(),
  })
  .strict();
export type TeamMember = z.infer<typeof TeamMemberSchema>;

const TeamLimitsSchema = RunLimitsSchema.pick({
  maxTurns: true,
  maxUsd: true,
  maxWallclockMs: true,
});

export const TeamDefinitionSchema = z
  .object({
    schema: z.literal("daycrew.team/v1"),
    engines: z.record(IdentifierSchema, TeamEngineSchema).optional(),
    members: z.array(TeamMemberSchema).min(1),
    workflow: z.string().trim().min(1).optional(),
    limits: TeamLimitsSchema.optional(),
  })
  .strict()
  .superRefine((team, context) => {
    const orchestrators = team.members.filter(
      (member) => member.orchestrator,
    ).length;
    if (orchestrators !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A team must define exactly one orchestrator",
        path: ["members"],
      });
    }

    if (team.engines) {
      team.members.forEach((member, index) => {
        if (!(member.role in team.engines!)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown engine role "${member.role}"`,
            path: ["members", index, "role"],
          });
        }
      });
    }
  });
export type TeamDefinition = z.infer<typeof TeamDefinitionSchema>;
