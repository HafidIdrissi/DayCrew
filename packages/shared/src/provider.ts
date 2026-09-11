import { z } from "zod";

import {
  IdSchema,
  MessageSchema,
  RiskLevelSchema,
  RiskyActionSchema,
  TaskStatusSchema,
  UsageSchema,
} from "./domain.js";

export const ProviderCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    toolUse: z.boolean(),
    approvals: z.boolean(),
    interruption: z.boolean(),
    resume: z.boolean(),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderDetectionSchema = z
  .object({
    available: z.boolean(),
    version: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ProviderDetection = z.infer<typeof ProviderDetectionSchema>;

export const AgentSpecSchema = z
  .object({
    sessionId: IdSchema,
    memberId: IdSchema,
    role: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    workspacePath: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
  })
  .strict();
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const AgentInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goal"), text: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal("message"), message: MessageSchema }).strict(),
  z
    .object({
      type: z.literal("approval-decision"),
      requestId: IdSchema,
      decision: z.enum(["approved", "denied"]),
      feedback: z.string().optional(),
    })
    .strict(),
]);
export type AgentInput = z.infer<typeof AgentInputSchema>;

export const TaskUpdateSchema = z
  .object({
    id: IdSchema.optional(),
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    status: TaskStatusSchema.optional(),
    ownerId: IdSchema.optional(),
    previousOwnerId: IdSchema.optional(),
    dependsOn: z.array(IdSchema).optional(),
    handoffNote: z.string().optional(),
    needsYou: z.boolean().optional(),
  })
  .strict()
  .refine((task) => task.id !== undefined || task.title !== undefined, {
    message: "A task update requires an id or title",
  });
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;

export const AgentMessageSchema = z
  .object({
    toMemberId: IdSchema,
    taskId: IdSchema.optional(),
    subject: z.string().trim().min(1),
    body: z.string(),
  })
  .strict();
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const ApprovalRequestSchema = z
  .object({
    requestId: IdSchema.optional(),
    action: RiskyActionSchema,
    risk: RiskLevelSchema,
    summary: z.string().trim().min(1),
    payload: z.unknown(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

const AgentEventSchemas = [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("tool_call"),
      callId: IdSchema,
      name: z.string().trim().min(1),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      callId: IdSchema,
      output: z.unknown(),
      isError: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("task_update"),
      task: TaskUpdateSchema,
    })
    .strict(),
  z.object({ type: z.literal("message"), message: AgentMessageSchema }).strict(),
  z
    .object({
      type: z.literal("approval_request"),
      request: ApprovalRequestSchema,
    })
    .strict(),
  z.object({ type: z.literal("usage"), usage: UsageSchema }).strict(),
  z.object({ type: z.literal("turn_end") }).strict(),
  z.object({ type: z.literal("done"), summary: z.string().optional() }).strict(),
  z
    .object({
      type: z.literal("error"),
      message: z.string().trim().min(1),
      recoverable: z.boolean().default(false),
    })
    .strict(),
] as const;

export const AgentEventSchema = z.discriminatedUnion("type", AgentEventSchemas);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export interface AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  /** Provider-owned conversation identity, when one is known and safe to persist. */
  getSessionIdentity?(): string | undefined;
  send(input: AgentInput): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  detect(): Promise<ProviderDetection>;
  startAgent(spec: AgentSpec): Promise<AgentHandle>;
}
