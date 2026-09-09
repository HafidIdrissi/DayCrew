import { z } from "zod";

export const IdentifierSchema = z.string().trim().min(1);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const ActionClassSchema = z.enum([
  "shell.exec",
  "fs.write",
  "fs.delete",
  "net.request",
  "spend",
  "git.push",
  "external.publish",
]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const PermissionRuleSchema = z
  .object({
    actionClass: ActionClassSchema,
    match: z.string().min(1).optional(),
    effect: z.enum(["allow", "ask", "deny"]),
  })
  .strict();
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

export const PermissionPolicySchema = z
  .object({
    mode: z.enum(["auto", "ask", "readonly"]).default("ask"),
    rules: z.array(PermissionRuleSchema).optional(),
  })
  .strict();
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

export const RunStatusSchema = z.enum([
  "created",
  "planning",
  "running",
  "paused",
  "blocked",
  "review",
  "done",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunModeSchema = z.enum(["single", "crew"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RunLimitsSchema = z
  .object({
    maxTurns: z.number().int().positive(),
    maxUsd: z.number().nonnegative(),
    maxWallclockMs: z.number().int().positive(),
    idleTimeoutMs: z.number().int().positive(),
  })
  .strict();
export type RunLimits = z.infer<typeof RunLimitsSchema>;

export const RunUsageSchema = z
  .object({
    turns: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
    tokens: z.number().int().nonnegative(),
  })
  .strict();
export type RunUsage = z.infer<typeof RunUsageSchema>;

export const RunSchema = z
  .object({
    id: IdentifierSchema,
    crewName: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    workspace: z.string().trim().min(1),
    status: RunStatusSchema,
    mode: RunModeSchema,
    createdAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.optional(),
    endedAt: IsoDateTimeSchema.optional(),
    limits: RunLimitsSchema,
    usage: RunUsageSchema,
  })
  .strict();
export type Run = z.infer<typeof RunSchema>;

export const AgentStatusSchema = z.enum([
  "idle",
  "thinking",
  "acting",
  "blocked-on-approval",
  "waiting-on-dep",
  "done",
  "error",
  "stopped",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSchema = z
  .object({
    runId: IdentifierSchema,
    agentId: IdentifierSchema,
    role: IdentifierSchema,
    provider: IdentifierSchema,
    model: z.string().trim().min(1).optional(),
    status: AgentStatusSchema,
    permissionPolicy: PermissionPolicySchema,
  })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;

export const TaskStatusSchema = z.enum([
  "todo",
  "doing",
  "blocked",
  "review",
  "done",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    title: z.string().trim().min(1),
    description: z.string(),
    assignee: IdentifierSchema,
    status: TaskStatusSchema,
    priority: z.string().trim().min(1),
    deps: z.array(IdentifierSchema),
    parentId: IdentifierSchema.optional(),
    artifacts: z.array(z.string().trim().min(1)),
    createdBy: IdentifierSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

export const MessageActSchema = z.enum([
  "request",
  "inform",
  "propose",
  "query",
  "agree",
  "refuse",
  "done",
]);
export type MessageAct = z.infer<typeof MessageActSchema>;

export const MessageSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    from: IdentifierSchema,
    to: IdentifierSchema,
    act: MessageActSchema,
    subject: z.string().trim().min(1),
    body: z.string(),
    conversation: IdentifierSchema.optional(),
    inReplyTo: IdentifierSchema.optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRequestSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    agentId: IdentifierSchema,
    actionClass: ActionClassSchema,
    summary: z.string().trim().min(1),
    payload: z.unknown(),
    risk: z.string().trim().min(1),
    status: ApprovalStatusSchema,
    createdAt: IsoDateTimeSchema,
    decidedAt: IsoDateTimeSchema.optional(),
    decidedBy: IdentifierSchema.optional(),
    decision: z.enum(["approved", "denied"]).optional(),
    feedback: z.string().optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ArtifactSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    path: z.string().trim().min(1),
    kind: z.string().trim().min(1),
    producedBy: IdentifierSchema,
    createdAt: IsoDateTimeSchema,
    description: z.string(),
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;

export const EventKindSchema = z.enum([
  "run.created",
  "run.status",
  "agent.spawned",
  "agent.status",
  "agent.text",
  "task.created",
  "task.updated",
  "message.sent",
  "approval.requested",
  "approval.decided",
  "artifact.created",
  "usage.updated",
  "guardrail.tripped",
  "run.ended",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

// Event payloads are intentionally not guessed here. The approved architecture
// specifies the envelope and kinds, but leaves the per-kind payload contract open.
export const EventSchema = z
  .object({
    ts: IsoDateTimeSchema,
    runId: IdentifierSchema,
    kind: EventKindSchema,
  })
  .passthrough();
export type Event = z.infer<typeof EventSchema>;
