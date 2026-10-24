import { z } from "zod";
const model = z
  .object({
    provider: z.string(),
    model: z.string(),
    endpoint: z.string(),
    execution: z.string(),
  })
  .strict();
export const knowledgeSourceSchema = z
  .object({
    bookId: z.string(),
    chapterId: z.string(),
    revisionId: z.string(),
    contentHash: z.string(),
    quote: z.string(),
    startUTF16: z.number().int().nonnegative(),
    endUTF16: z.number().int().nonnegative(),
    sourceKind: z.enum(["narration", "dialogue", "thought", "author_note"]),
    validity: z.enum(["current", "stale", "unavailable"]),
    retired: z.boolean().optional(),
  })
  .strict();
export const memoryEntitySchema = z
  .object({
    entityId: z.string(),
    bookId: z.string(),
    type: z.enum([
      "character",
      "place",
      "organization",
      "world_rule",
      "event",
      "plot_line",
      "foreshadowing",
    ]),
    name: z.string(),
    aliases: z.array(z.string()),
    identity: z.string(),
    status: z.enum(["observed", "inferred", "disputed", "stale", "deprecated"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .strict();
export const memoryAssertionSchema = z
  .object({
    assertionId: z.string(),
    entityId: z.string(),
    predicate: z.string(),
    text: z.string(),
    targetEntityId: z.string().optional(),
 targetName:z.string().optional(),
    epistemic: z.enum(["observation", "claim", "inference"]),
    speaker: z.string().optional(),
    time: z.string().optional(),
    status: z.enum(["current", "stale", "disputed"]),
    sources: z.array(knowledgeSourceSchema),
  })
  .strict();
export const memorySettingsSchema = z
  .object({
    enabled: z.boolean(),
    paused: z.boolean(),
    consentAt: z.string().optional(),
    model,
    configFingerprint:z.string().optional(),
 dailyTokenBudget: z.number().int(),
    dailyJobBudget: z.number().int(),
  })
  .strict();
export const memoryViewSchema = z
  .object({
 needsModelConsent:z.boolean().optional(),
    bookId: z.string(),
    version: z.number().int(),
    budgetDay: z.string(),
    budgetTokens: z.number().int(),
    budgetAttempts: z.number().int(),
    settings: memorySettingsSchema,
    available: z.boolean(),
    workerStatus: z.enum(["online", "offline", "incompatible"]).optional(),
    model,
    disclosure: z.string(),
    pending: z.number().int(),
    running: z.number().int(),
    failed: z.number().int(),
    // Backfill progress. Optional so a newer Web build still parses a response
    // from an API that has not been upgraded yet; deploy Web before API.
    completed: z.number().int().nonnegative().optional(),
    chapterTotal: z.number().int().nonnegative().optional(),
    stale: z.boolean(),
  })
  .strict();
export const memoryPageSchema = memoryViewSchema
  .extend({
    entities: z.array(memoryEntitySchema),
    assertions: z.array(memoryAssertionSchema),
    total: z.number().int(),
    nextCursor: z.number().int().nullable(),
    assertionTotal: z.number().int(),
    nextAssertionCursor: z.number().int().nullable(),
  })
  .strict();
export const memoryJobSchema = z
  .object({
    jobId: z.string(),
    chapterId: z.string(),
    revisionId: z.string(),
    contentHash: z.string(),
    strategyVersion: z.string(),
    model,
    status: z.enum([
      "pending",
      "running",
      "completed",
      "retry",
      "failed",
      "superseded",
      "cancelled",
    ]),
    attempts: z.number().int(),
    nextAttemptAt: z.string(),
    deadlineAt: z.string().optional(),
    lease: z.string().optional(),
    failureCode: z.string().optional(),
    usage: z
      .object({ inputTokens: z.number().int(), outputTokens: z.number().int() })
      .strict()
      .optional(),
    usageIncomplete: z.boolean().optional(),
    modelCalls: z.number().int().optional(),
    discardedAliases: z.number().int().nonnegative().optional(),
    discardedAssertions: z.number().int().nonnegative().optional(),
    discardedEntities: z.number().int().nonnegative().optional(),
    reservedTokens: z.number().int(),
    durationMs: z.number(),
    createdAt: z.string(),
    completedAt: z.string().optional(),
  })
  .strict();
export const memoryChangeSchema = z
  .object({
    changeId: z.string(),
    at: z.string(),
    kind: z.string(),
    chapterId: z.string(),
    revisionId: z.string(),
    jobId: z.string(),
  })
  .strict();
export const memoryCorrectionSchema = z
  .object({
    correctionId: z.string(),
    anchorQuote: z.string().optional(),
    entityId: z.string().optional(),
    assertionId: z.string().optional(),
    chapterId: z.string().optional(),
    action: z.enum(["claim", "dispute", "separate"]),
    reason: z.string(),
    actorId: z.string(),
    active: z.boolean(),
    version: z.number().int(),
    createdAt: z.string(),
  })
  .strict();
const records = <T extends z.ZodType>(item: T) =>
  z
    .object({
      // Kept optional for rolling deployment compatibility with older Go
      // servers. The header uses /knowledge/summary instead of repeating it.
      view: memoryViewSchema.optional(),
      items: z.array(item),
      total: z.number().int(),
      nextCursor: z.number().int().nullable(),
    })
    .strict();
export const memoryJobsSchema = records(memoryJobSchema);
export const memoryHistorySchema = records(memoryChangeSchema);
export const memoryCorrectionsSchema = records(memoryCorrectionSchema);
export const memoryMutationSchema = z
  .object({
    baseVersion: z.number().int().nonnegative(),
    consent: z.boolean().optional(),
    model: model.optional(),
    // The Go service owns the real floor: the budget must cover one reserved
    // extraction (context + output bound), which depends on the active model
    // configuration. Keep this client bound loose; the server returns 422.
    dailyTokenBudget: z.number().int().min(1).max(100000000).optional(),
    dailyJobBudget: z.number().int().min(1).max(1000).optional(),
    chapterId: z.string().optional(),
    entityId: z.string().optional(),
    assertionId: z.string().optional(),
    correctionId: z.string().optional(),
    reason: z.string().max(1000).optional(),
    action: z.enum(["claim", "dispute", "separate"]).optional(),
  })
  .strict();
export type MemoryPage = z.infer<typeof memoryPageSchema>;
export type MemoryEntity = z.infer<typeof memoryEntitySchema>;
export type MemoryAssertion = z.infer<typeof memoryAssertionSchema>;
export type MemorySource = z.infer<typeof knowledgeSourceSchema>;
export type MemoryMutation = z.infer<typeof memoryMutationSchema>;
export type MemoryView = z.infer<typeof memoryViewSchema>;
export type MemoryJob = z.infer<typeof memoryJobSchema>;
export type MemoryChange = z.infer<typeof memoryChangeSchema>;
export type MemoryCorrection = z.infer<typeof memoryCorrectionSchema>;
export const knowledgeJsonSchemas = Object.fromEntries(
  Object.entries({
    MemoryPage: memoryPageSchema,
    MemoryView: memoryViewSchema,
    MemoryJobs: memoryJobsSchema,
    MemoryHistory: memoryHistorySchema,
    MemoryCorrections: memoryCorrectionsSchema,
    MemoryMutation: memoryMutationSchema,
  }).map(([key, schema]) => [
    key,
    z.toJSONSchema(schema, { unrepresentable: "any" }),
  ]),
);
