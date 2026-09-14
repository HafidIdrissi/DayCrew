import { z } from "zod";
import { IdSchema, TimestampSchema, TeamMemberSchema } from "./domain.js";

export const ChatMemberInputSchema = TeamMemberSchema.pick({ name: true, role: true, instructions: true, engine: true }).extend({
  name: z.string().trim().min(1).max(80), role: z.string().trim().min(1).max(120), instructions: z.string().trim().min(1).max(20_000),
});
export const ChatSendInputSchema = z.object({ text: z.string().trim().min(1).max(8_000), targetId: IdSchema.optional(), allowIsolatedPreview: z.boolean().default(false) }).strict();

export const ChatMessageSchema = z.object({
  id: IdSchema,
  author: z.enum(["human", "agent"]),
  memberId: IdSchema.optional(),
  name: z.string(),
  provider: z.string().optional(),
  /** The model the agent asked for, as stored on the Member. */
  model: z.string().optional(),
  /** The model the engine confirmed it ran, when it reports one. */
  resolvedModel: z.string().optional(),
  text: z.string(),
  status: z.enum(["complete", "responding", "waiting", "failed", "stopped"]),
  createdAt: TimestampSchema,
  sessionId: IdSchema.optional(),
  notice: z.string().optional(),
}).strict();
export const ConversationSchema = z.object({
  id: IdSchema,
  teamId: IdSchema,
  messages: z.array(ChatMessageSchema),
}).strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
