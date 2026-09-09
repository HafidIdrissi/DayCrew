import { z } from "zod";

import {
  ActionClassSchema,
  AgentStatusSchema,
  MessageActSchema,
  MessageSchema,
  PermissionPolicySchema,
  TaskSchema,
  TaskStatusSchema,
  type AgentStatus,
} from "./models.js";

export const DetectResultSchema = z
  .object({
    available: z.boolean(),
    version: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();
export type DetectResult = z.infer<typeof DetectResultSchema>;

export const ProviderCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    nativeToolUse: z.boolean(),
    nativePermissionPrompts: z.boolean(),
    resume: z.boolean(),
    mcp: z.boolean(),
  })
  .strict();
export type ProviderCapabilities = z.infer<
  typeof ProviderCapabilitiesSchema
>;

// The approved provider spec names this type but does not define its fields.
// Keeping the value opaque prevents shared from inventing provider-specific keys.
export const McpServerConfigSchema = z.record(z.unknown());
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const AgentSpecSchema = z
  .object({
    agentId: z.string().trim().min(1),
    memberId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    instructions: z.string(),
    objective: z.string().trim().min(1),
    cwd: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    permissionPolicy: PermissionPolicySchema,
    allowedTools: z.array(z.string().trim().min(1)).optional(),
    mcpServers: z.array(McpServerConfigSchema).optional(),
    context: z
      .object({
        tasks: z.array(TaskSchema).optional(),
        inbox: z.array(MessageSchema).optional(),
        memory: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const AgentInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("objective"),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      from: z.string().trim().min(1),
      subject: z.string().trim().min(1),
      body: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval_result"),
      requestId: z.string().trim().min(1),
      decision: z.enum(["approved", "denied"]),
      feedback: z.string().optional(),
    })
    .strict(),
]);
export type AgentInput = z.infer<typeof AgentInputSchema>;

const StatusEventSchema = z
  .object({
    type: z.literal("status"),
    status: AgentStatusSchema,
  })
  .strict();
const TextEventSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();
const ToolCallEventSchema = z
  .object({
    type: z.literal("tool_call"),
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    input: z.unknown(),
  })
  .strict();
const ToolResultEventSchema = z
  .object({
    type: z.literal("tool_result"),
    id: z.string().trim().min(1),
    output: z.unknown(),
    isError: z.boolean().optional(),
  })
  .strict();
const ApprovalRequestEventSchema = z
  .object({
    type: z.literal("approval_request"),
    actionClass: ActionClassSchema,
    summary: z.string().trim().min(1),
    payload: z.unknown(),
    nativeId: z.string().trim().min(1).optional(),
  })
  .strict();
const TaskUpdateEventSchema = z
  .object({
    type: z.literal("task_update"),
    task: z
      .object({
        id: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).optional(),
        description: z.string().optional(),
        status: TaskStatusSchema.optional(),
        assignee: z.string().trim().min(1).optional(),
        deps: z.array(z.string().trim().min(1)).optional(),
      })
      .strict(),
  })
  .strict();
const MessageOutEventSchema = z
  .object({
    type: z.literal("message_out"),
    to: z.string().trim().min(1),
    act: MessageActSchema,
    subject: z.string().trim().min(1),
    body: z.string(),
  })
  .strict();
const ArtifactEventSchema = z
  .object({
    type: z.literal("artifact"),
    path: z.string().trim().min(1),
    kind: z.string().trim().min(1),
    description: z.string().optional(),
  })
  .strict();
const UsageEventSchema = z
  .object({
    type: z.literal("usage"),
    usd: z.number().nonnegative().optional(),
    tokens: z.number().int().nonnegative().optional(),
    turns: z.number().int().nonnegative().optional(),
  })
  .strict();
const TurnEndEventSchema = z.object({ type: z.literal("turn_end") }).strict();
const DoneEventSchema = z
  .object({
    type: z.literal("done"),
    summary: z.string().optional(),
  })
  .strict();
const ErrorEventSchema = z
  .object({
    type: z.literal("error"),
    message: z.string().trim().min(1),
    fatal: z.boolean().optional(),
  })
  .strict();

export const AgentEventSchema = z.discriminatedUnion("type", [
  StatusEventSchema,
  TextEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ApprovalRequestEventSchema,
  TaskUpdateEventSchema,
  MessageOutEventSchema,
  ArtifactEventSchema,
  UsageEventSchema,
  TurnEndEventSchema,
  DoneEventSchema,
  ErrorEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// RunContext.emit's EngineEvent is undefined in the approved spec. Unknown keeps
// the interface usable without falsely blessing a guessed lifecycle contract.
export type EngineEvent = unknown;

export interface RunContext {
  runId: string;
  emit(event: EngineEvent): void;
  logSink: (chunk: string) => void;
  signal: AbortSignal;
}

export interface AgentHandle {
  send(input: AgentInput): Promise<void>;
  readonly events: AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  status(): AgentStatus;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  detect(): Promise<DetectResult>;
  readonly capabilities: ProviderCapabilities;
  startAgent(spec: AgentSpec, context: RunContext): Promise<AgentHandle>;
}
