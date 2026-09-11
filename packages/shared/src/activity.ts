import { z } from "zod";

import { IdSchema, TimestampSchema } from "./domain.js";

export const ActivityKindSchema = z.enum([
  "session.started",
  "session.status_changed",
  "member.status_changed",
  "task.created",
  "task.updated",
  "task.handed_off",
  "message.sent",
  "needs_you.created",
  "needs_you.resolved",
  "approval.requested",
  "approval.decided",
  "approval.recovery_required",
  "approval.action_outcome",
  "member.resumed",
  "session.cancelled",
  "member.text",
  "member.tool_used",
  "usage.updated",
  "session.completed",
  "session.failed",
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivityEventSchema = z
  .object({
    id: IdSchema,
    sequence: z.number().int().positive(),
    timestamp: TimestampSchema,
    workspaceId: IdSchema,
    teamId: IdSchema,
    sessionId: IdSchema,
    kind: ActivityKindSchema,
    summary: z.string().trim().min(1),
    data: z.record(z.unknown()).default({}),
  })
  .strict();
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
