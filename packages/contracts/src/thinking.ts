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
    modelId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
    displayName: z.string().max(120).optional(),
    hostedBy: z.string().max(120).optional(),
    contextWindow: z.number().int().min(1024).max(1000000).optional(),
    billingPolicy: z.literal("standard-points-v1").optional(),
    toolCalling: z.boolean().optional(),
    tokenParameter: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    providerOptions: z.enum(["default", "deepseek", "bedrock"]).optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    endpoint: z.string().url(),
    protocol: z.literal(thinkingProtocol),
    limits: thinkingLimitsSchema,
  })
  .strict();
export const thinkingCreateSchema = z
  .object({
    consent: z.literal(true).optional(),
    model: thinkingModelSchema.optional(),
    modelId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
    scopes: z.array(thinkingScopeSchema).max(4).optional(),
  })
  .strict();
// Recovery is an explicit author action; it never silently replays a paid call.
export const thinkingRecoverySchema = z.object({
  runId: z.string().uuid(),
  confirmAdditionalCost: z.literal(true),
  continuationContext: z.string().trim().min(1).max(12000).optional(),
}).strict();
export const thinkingFailureSchema = z.object({
  code: z.enum(["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "RATE_LIMITED", "CONTEXT_OVERFLOW", "TOOL_TIMEOUT", "TOOL_EXECUTION_FAILED", "SESSION_INTERRUPTED", "SESSION_EXPIRED", "AUTHORIZATION_REQUIRED", "MODEL_CONFIGURATION_ERROR", "BUDGET_EXCEEDED", "INTERNAL_ERROR"]),
  retryable: z.boolean(), autoRecoverable: z.boolean(),
  userAction: z.enum(["retry", "continue", "reauthorize", "provide_context", "new_session", "contact_support"]),
  contextRetained: z.literal(true), mayHaveIncurredCost: z.boolean(),
  retryMayIncurCost: z.literal(true), message: z.string(),
}).strict();
export const thinkingRunSchema = z.object({
  runId: z.string().uuid(), traceId: z.string().uuid(), messageId: z.string(),
  status: z.enum(["accepted", "running", "checkpointed", "completed", "failed", "interrupted", "cancelled"]),
  stepType: z.enum(["accepted", "provider", "tool", "completed"]),
  authorizationVersion: z.number().int().nonnegative().optional(),
  checkpointId: z.string().uuid(), epoch: z.number().int().nonnegative(),
  attempt: z.number().int().positive(), retryCount: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(), resumable: z.boolean(),
  provider: z.string(), model: z.string(), startedAt: z.string(), updatedAt: z.string(),
  durationMs: z.number().nonnegative(), failure: thinkingFailureSchema.optional(),
}).strict();
export type ThinkingRun = z.infer<typeof thinkingRunSchema>;
export type ThinkingFailure = z.infer<typeof thinkingFailureSchema>;
export type ThinkingRecovery = z.infer<typeof thinkingRecoverySchema>;
export const thinkingMessageInputSchema = z
  .object({
    text: z.string().trim().min(1).max(12000),
    modelId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
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
export const thinkingExecutionInputSchema = thinkingMessageInputSchema.extend({recovery:thinkingRecoverySchema.optional()}).strict();
export type ThinkingExecutionInput = z.infer<typeof thinkingExecutionInputSchema>;

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
    modelId: z.string().optional(),
    modelLabel: z.string().optional(),
    requestKey: z.string().max(128).optional(),
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
    run: thinkingRunSchema.optional(),
    cancellationPending: z.boolean().optional(),
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
export const thinkingCancelReceiptSchema = z.object({sessionId:z.string(),status:z.literal("cancelled"),syncPending:z.boolean()}).strict();
export type ThinkingCancelReceipt = z.infer<typeof thinkingCancelReceiptSchema>;

export const thinkingEventsSchema = z
  .object({
    items: z.array(thinkingEventSchema),
    cursor: z.number().int().nonnegative(),
    status: z.enum(["idle", "running", "deleted"]),
    cancellationPending: z.boolean().optional(),
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
    authorizationVersion: z.number().int().nonnegative().optional(),
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
    input: thinkingExecutionInputSchema,
    key: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    capability: z.string().max(4096),
  })
  .strict();

export const thinkingModelsSchema = z.object({items: z.array(z.object({
  modelId: z.string(), displayName: z.string(), provider: z.string(), hostedBy: z.string(),
  description: z.string(), enabled: z.boolean(), toolCalling: z.boolean(), pointMultiplier: z.literal(1),
}).strict())}).strict();
export const thinkingPreferencesSchema = z.object({scopes: z.array(thinkingScopeSchema).max(4)}).strict();
export type ThinkingModelOption = z.infer<typeof thinkingModelsSchema>["items"][number];
