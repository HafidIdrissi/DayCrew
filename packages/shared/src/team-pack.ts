import { z } from "zod";

import { AutonomyLevelSchema, IdSchema, TeamMemberSchema } from "./domain.js";

export const TeamPackManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    name: z.string().trim().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    description: z.string().trim().min(1),
    license: z.string().trim().min(1),
    author: z.string().trim().min(1),
  })
  .strict();
export type TeamPackManifest = z.infer<typeof TeamPackManifestSchema>;

export const TeamPackMemberSchema = TeamMemberSchema.omit({ instructions: true }).extend({
  instructionsFile: z.string().trim().min(1),
});

export const TeamPackDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().trim().min(1),
    description: z.string().default(""),
    autonomy: AutonomyLevelSchema.default("work-with-approval"),
    members: z.array(TeamPackMemberSchema).min(1),
  })
  .strict()
  .superRefine((team, context) => {
    if (team.members.filter((member) => member.isManager).length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A Team Pack must define exactly one Manager",
        path: ["members"],
      });
    }
  });
export type TeamPackDefinition = z.infer<typeof TeamPackDefinitionSchema>;
