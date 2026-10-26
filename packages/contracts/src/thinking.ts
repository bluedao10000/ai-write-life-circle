import { z } from "zod";
export const thinkingProtocol = "thinking-v1" as const;
export const thinkingScopeSchema = z.enum([
  "chapters",
  "knowledge",
  "notes",
  "creative",
]);
export const thinkingLimitsSchema = z
  .object({
    maxTurnsPerRequest: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxSessionTokens: z.number().int().positive(),
    maxConcurrentSessions: z.number().int().positive(),
    maxDurationMs: z.number().int().positive(),
    maxToolResultBytes: z.number().int().positive(),
  })
  .strict();
export const thinkingModelSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    endpoint: z.string().url(),
    protocol: z.literal(thinkingProtocol),
    limits: thinkingLimitsSchema,
  })
  .strict();
export const thinkingCreateSchema = z
  .object({
    consent: z.literal(true),
    model: thinkingModelSchema,
    scopes: z.array(thinkingScopeSchema).min(1).max(4),
  })
  .strict();
export const thinkingMessageInputSchema = z
  .object({
    text: z.string().trim().min(1).max(12000),
    selection: z
      .object({
        chapterId: z.string(),
        revisionId: z.string(),
        contentHash: z.string(),
        quote: z.string().max(4000),
      })
      .strict()
      .optional(),
    compact: z.boolean().optional(),
  })
  .strict();
export const thinkingSourceSchema = z
  .object({
    sourceId: z.string(),
    chapterId: z.string(),
    title: z.string(),
    revisionId: z.string(),
    contentHash: z.string(),
    quote: z.string().max(16000),
    startUTF16: z.number().int().nonnegative(),
    endUTF16: z.number().int().nonnegative(),
    validity: z.enum(["current", "stale", "unavailable"]),
    epistemic: z.enum(["observation", "claim", "inference"]).optional(),
  })
  .strict();
export const thinkingUsageSchema = z
  .object({
    input: z.number().nonnegative(),
 cachedInput: z.number().nonnegative().optional(),
    output: z.number().nonnegative(),
    charged: z.number().nonnegative(),
    incomplete: z.boolean(),
  })
  .strict();
export const thinkingEventSchema = z
  .object({
    id: z.number().int().nonnegative(),
    type: z.enum([
      "session_started",
      "message_started",
      "text_delta",
      "tool_started",
      "tool_completed",
      "message_completed",
      "usage",
      "error",
      "session_completed",
      "sources",
      "compaction",
    ]),
    messageId: z.string().optional(),
    text: z.string().optional(),
    tool: z.string().optional(),
    code: z.string().optional(),
    sources: z.array(thinkingSourceSchema).optional(),
    usage: thinkingUsageSchema.optional(),
  })
  .strict();
export const thinkingMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    status: z.enum([
      "accepted",
      "running",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    sources: z.array(thinkingSourceSchema),
    createdAt: z.string(),
    errorCode: z.string().optional(),
    usage: thinkingUsageSchema.optional(),
  })
  .strict();
export const thinkingSessionSchema = z
  .object({
    sessionId: z.string(),
    bookId: z.string(),
    title: z.string(),
    createdAt: z.string(),
    model: thinkingModelSchema,
    scopes: z.array(thinkingScopeSchema),
    status: z.enum(["idle", "running", "deleted"]),
    messages: z.array(thinkingMessageSchema),
    cursor: z.number().int().nonnegative(),
    usage: thinkingUsageSchema,
  })
  .strict();
export const thinkingSummarySchema = thinkingSessionSchema.pick({
  sessionId: true,
  bookId: true,
  title: true,
  createdAt: true,
  model: true,
  scopes: true,
  status: true,
});
export const thinkingEventsSchema = z
  .object({
    items: z.array(thinkingEventSchema),
    cursor: z.number().int().nonnegative(),
    status: z.enum(["idle", "running", "deleted"]),
  })
  .strict();
export type ThinkingLimits = z.infer<typeof thinkingLimitsSchema>;
export type ThinkingModel = z.infer<typeof thinkingModelSchema>;
export type ThinkingCreate = z.infer<typeof thinkingCreateSchema>;
export type ThinkingMessageInput = z.infer<typeof thinkingMessageInputSchema>;
export type ThinkingSource = z.infer<typeof thinkingSourceSchema>;
export type ThinkingSession = z.infer<typeof thinkingSessionSchema>;
export type ThinkingMessage = z.infer<typeof thinkingMessageSchema>;
export type ThinkingEvent = z.infer<typeof thinkingEventSchema>;
export type ThinkingUsage = z.infer<typeof thinkingUsageSchema>;

// Internal protocol: mounted exclusively on separate loopback listeners.
export const thinkingGrantSchema = z
  .object({
    sessionId: z
      .string()
      .regex(
        /^th-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
      ),
    authorId: z.string(),
    bookId: z.string(),
    model: thinkingModelSchema,
    scopes: thinkingScopeSchema.array(),
  })
  .strict();
export const thinkingToolRequestSchema = z
  .object({
    sessionId: z.string(),
    tool: z.enum([
      "search_knowledge",
      "read_chapter",
      "get_entity",
      "find_related_chapters",
      "get_author_notes",
      "get_timeline",
      "get_plot_threads",
      "list_creative_assets",
      "get_creative_asset",
      "list_creative_proposals",
      "list_open_questions",
      "get_writing_context",
      "compare_plan_with_manuscript",
      "request_turn_organize",
    ]),
    arguments: z
      .object({
        query: z.string().max(256).optional(),
        quote: z.string().max(4000).optional(),
        chapterId: z.string().optional(),
        revisionId: z.string().optional(),
        entityId: z.string().optional(),
        startUTF16: z.number().int().nonnegative().optional(),
        assetId: z.string().max(128).optional(),
        kind: z.string().max(40).optional(),
      })
      .strict(),
  })
  .strict();
export const thinkingPrivateCreateSchema = thinkingGrantSchema
  .extend({ createdAt: z.string(), capability: z.string().max(4096) })
  .strict();
export const thinkingPrivateMessageSchema = z
  .object({
    input: thinkingMessageInputSchema,
    key: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    capability: z.string().max(4096),
  })
  .strict();
