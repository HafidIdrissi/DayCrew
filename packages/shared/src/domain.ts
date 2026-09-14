import { z } from "zod";

export const IdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Expected a stable identifier");
export const TimestampSchema = z.string().datetime({ offset: true });

/**
 * Provider model identifiers are not DayCrew ids: real catalogues use dots, colons
 * and slashes (`grok-4.6`, `claude-haiku-4-5`, `gpt-5.6-terra`). The pattern stays
 * strict enough that a stored model id can never smuggle an argument into a CLI engine.
 */
export const ModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Expected a provider model identifier");

export const AutonomyLevelSchema = z.enum([
  "assist",
  "work-with-approval",
  "autonomous",
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const EngineSelectionSchema = z
  .object({
    mode: z.enum(["auto", "manual"]).default("auto"),
    provider: IdSchema.optional(),
    model: ModelIdSchema.optional(),
  })
  .strict()
  .superRefine((selection, context) => {
    if (selection.mode === "manual" && !selection.provider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Manual engine selection requires a provider",
        path: ["provider"],
      });
    }
  });
export type EngineSelection = z.infer<typeof EngineSelectionSchema>;

export const WorkspaceSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    rootPath: z.string().trim().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const TeamMemberSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    role: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    isManager: z.boolean().default(false),
    engine: EngineSelectionSchema.default({ mode: "auto" }),
    skillIds: z.array(IdSchema).max(12).optional(),
  })
  .strict();
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    name: z.string().trim().min(1),
    description: z.string().default(""),
    autonomy: AutonomyLevelSchema.default("work-with-approval"),
    members: z.array(TeamMemberSchema).min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((team, context) => {
    const managerCount = team.members.filter((member) => member.isManager).length;
    if (managerCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A Team must have exactly one Manager",
        path: ["members"],
      });
    }
  });
export type Team = z.infer<typeof TeamSchema>;

export const TaskStatusSchema = z.enum([
  "todo",
  "in-progress",
  "review",
  "done",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskHandoffSchema = z
  .object({
    fromMemberId: IdSchema.optional(),
    toMemberId: IdSchema,
    note: z.string().default(""),
    createdAt: TimestampSchema,
  })
  .strict();
export type TaskHandoff = z.infer<typeof TaskHandoffSchema>;

export const TaskSkillAssignmentSchema = z
  .object({
    memberId: IdSchema,
    skillIds: z.array(IdSchema).max(12),
  })
  .strict();
export type TaskSkillAssignment = z.infer<typeof TaskSkillAssignmentSchema>;

export const TaskSchema = z
  .object({
    id: IdSchema,
    sessionId: IdSchema,
    title: z.string().trim().min(1),
    description: z.string().default(""),
    status: TaskStatusSchema.default("todo"),
    ownerId: IdSchema.optional(),
    previousOwnerId: IdSchema.optional(),
    dependsOn: z.array(IdSchema).default([]),
    handoffs: z.array(TaskHandoffSchema).default([]),
    needsYou: z.boolean().default(false),
    skillAssignments: z.array(TaskSkillAssignmentSchema).max(20).optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

export const WorkSessionStatusSchema = z.enum([
  "created",
  "planning",
  "working",
  "waiting-for-you",
  "waiting-for-human",
  "review",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkSessionStatus = z.infer<typeof WorkSessionStatusSchema>;

export const MemberStatusSchema = z.enum([
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked-on-approval",
  "paused",
  "completed",
  "failed",
  "stopped",
]);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

export const MemberRuntimeSchema = z
  .object({
    memberId: IdSchema,
    status: MemberStatusSchema.default("idle"),
    currentTaskId: IdSchema.optional(),
    lastActiveAt: TimestampSchema.optional(),
  })
  .strict();
export type MemberRuntime = z.infer<typeof MemberRuntimeSchema>;

export const WorkSessionLimitsSchema = z
  .object({
    maxTurns: z.number().int().positive().default(100),
    maxRepeatedUpdates: z.number().int().positive().default(5),
  })
  .strict();
export type WorkSessionLimits = z.infer<typeof WorkSessionLimitsSchema>;

export const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    costUsd: z.number().nonnegative().default(0),
    /**
     * The model the engine reports it actually billed this turn against. An agent
     * asks for a model (often an alias such as `haiku`); this is what the CLI
     * confirms it ran. Absent when the engine does not report one.
     */
    model: ModelIdSchema.optional(),
  })
  .strict();
export type Usage = z.infer<typeof UsageSchema>;

export const WorkSessionSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    teamId: IdSchema,
    goal: z.string().trim().min(1),
    status: WorkSessionStatusSchema.default("created"),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    summary: z.string().optional(),
    pausedReason: z.string().optional(),
    usage: UsageSchema.default({}),
    members: z.array(MemberRuntimeSchema).default([]),
    limits: WorkSessionLimitsSchema.default({}),
    turnCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type WorkSession = z.infer<typeof WorkSessionSchema>;

export const MessageSchema = z
  .object({
    id: IdSchema,
    sessionId: IdSchema,
    fromMemberId: IdSchema,
    toMemberId: IdSchema,
    taskId: IdSchema.optional(),
    subject: z.string().trim().min(1),
    body: z.string(),
    createdAt: TimestampSchema,
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskyActionSchema = z.enum([
  "filesystem.write",
  "command.run",
  "shell.destructive",
  "filesystem.delete",
  "external.publish",
  "money.spend",
  "git.push",
  "git.destructive",
  "network.sensitive",
  "credential.access",
]);
export type RiskyAction = z.infer<typeof RiskyActionSchema>;

export const NeedsYouKindSchema = z.enum([
  "approval",
  "decision",
  "blocker",
  "failed-task",
  "review",
]);

export const NeedsYouItemSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    teamId: IdSchema,
    sessionId: IdSchema,
    memberId: IdSchema,
    kind: NeedsYouKindSchema,
    title: z.string().trim().min(1),
    detail: z.string(),
    taskId: IdSchema.optional(),
    risk: RiskLevelSchema.optional(),
    action: RiskyActionSchema.optional(),
    approvalId: IdSchema.optional(),
    status: z.enum(["pending", "resolved", "dismissed"]).default("pending"),
    createdAt: TimestampSchema,
    resolvedAt: TimestampSchema.optional(),
    resolution: z.enum(["approved", "denied", "expired", "resolved", "dismissed"]).optional(),
    feedback: z.string().optional(),
  })
  .strict();
export type NeedsYouItem = z.infer<typeof NeedsYouItemSchema>;

export const ApprovalDecisionActorSchema = z
  .object({
    type: z.enum(["human", "system"]),
    id: z.string().trim().min(1),
  })
  .strict();

export const ApprovalRecordSchema = z
  .object({
    id: IdSchema,
    needsYouId: IdSchema,
    workspaceId: IdSchema,
    teamId: IdSchema,
    sessionId: IdSchema,
    memberId: IdSchema,
    taskId: IdSchema.optional(),
    providerId: IdSchema,
    providerRequestId: IdSchema,
    providerSessionId: z.string().trim().min(1).optional(),
    action: RiskyActionSchema,
    risk: RiskLevelSchema,
    summary: z.string().trim().min(1),
    payload: z.unknown(),
    status: z.enum(["pending", "approved", "denied", "expired"]).default("pending"),
    requestedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    decidedAt: TimestampSchema.optional(),
    decidedBy: ApprovalDecisionActorSchema.optional(),
    feedback: z.string().optional(),
    resumedAt: TimestampSchema.optional(),
    recovery: z.enum(["live", "required"]).default("live"),
    outcome: z.enum(["executed", "not-executed", "unknown"]).optional(),
    outcomeDetail: z.string().optional(),
    outcomeAt: TimestampSchema.optional(),
  })
  .strict();
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const KnowledgeEntrySchema = z
  .object({
    id: IdSchema,
    teamId: IdSchema,
    title: z.string().trim().min(1),
    content: z.string(),
    source: z.string().optional(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

export const MemberMemorySchema = z
  .object({
    memberId: IdSchema,
    notes: z.array(z.string()),
    updatedAt: TimestampSchema,
  })
  .strict();
export type MemberMemory = z.infer<typeof MemberMemorySchema>;

export const PermissionModeSchema = z.enum(["confirm-all", "ask-risky", "bounded-auto"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const PermissionPolicySchema = z
  .object({
    mode: PermissionModeSchema,
    hardBoundariesRequireApproval: z.literal(true),
  })
  .strict();
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;
