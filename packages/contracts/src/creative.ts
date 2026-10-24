import { z } from "zod";

// Creative assets are author intentions (characters, rules, plans). They are a
// separate authority from knowledge, which only holds manuscript observations.
const list = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item)
    .nullish()
    .transform((value) => value ?? []);

const model = z
  .object({
    provider: z.string(),
    model: z.string(),
    endpoint: z.string(),
    execution: z.string(),
  })
  .strict();

export const creativeKindSchema = z.enum([
  "character",
  "world_rule",
  "place",
  "organization",
  "plot_line",
  "event",
  "foreshadowing",
  "character_arc",
  "open_question",
]);
export const creativeAssetStatusSchema = z.enum([
  "draft",
  "accepted",
  "superseded",
  "archived",
]);
export const creativeStanceSchema = z.enum([
  "author_decision",
  "author_hypothesis",
  "author_question",
  "author_rejection",
  "ai_suggestion",
]);
export const creativeOperationSchema = z.enum([
  "CREATE",
  "UPDATE",
  "LINK",
  "SUPERSEDE",
]);
export const creativeProposalStatusSchema = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "superseded",
  "expired",
]);

export const creativeFieldSchema = z
  .object({ key: z.string().min(1).max(40), value: z.string().min(1).max(2000) })
  .strict();
export const creativePlanSchema = z
  .object({
    chapterId: z.string().optional(),
    payoffChapterId: z.string().optional(),
  })
  .strict();
export const creativeContentSchema = z
  .object({
    name: z.string(),
    aliases: list(z.string()),
    summary: z.string(),
    fields: list(creativeFieldSchema),
    plan: creativePlanSchema.optional(),
  })
  .strict();
export const creativeAssetSchema = z
  .object({
    assetId: z.string(),
    bookId: z.string(),
    kind: creativeKindSchema,
    name: z.string(),
    aliases: list(z.string()),
    summary: z.string(),
    fields: list(creativeFieldSchema),
    plan: creativePlanSchema.optional(),
    status: creativeAssetStatusSchema,
    supersededBy: z.string().optional(),
    origin: z.enum(["author", "conversation"]),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export const creativeAssetSummarySchema = creativeAssetSchema
  .extend({ pendingProposals: z.number().int().nonnegative() })
  .strict();

export const conversationSourceSchema = z
  .object({
    type: z.literal("conversation"),
    sessionId: z.string(),
    messageId: z.string(),
    answerId: z.string(),
    bookId: z.string(),
    capturedAt: z.string(),
    excerptHash: z.string(),
    model,
    strategy: z.string(),
    sessionDeleted: z.boolean().optional(),
  })
  .strict();
export const conversationEvidenceSchema = z
  .object({
    messageId: z.string(),
    role: z.enum(["user", "assistant"]),
    quote: z.string(),
  })
  .strict();
export const creativeVersionSchema = z
  .object({
    version: z.number().int().positive(),
    kind: creativeKindSchema,
    content: creativeContentSchema,
    status: creativeAssetStatusSchema,
    actorId: z.string(),
    at: z.string(),
    origin: z.enum([
      "author_create",
      "author_edit",
      "proposal_accept",
      "proposal_edit_accept",
      "status_change",
    ]),
    proposalId: z.string().optional(),
    source: conversationSourceSchema.optional(),
    evidence: list(conversationEvidenceSchema),
    note: z.string().optional(),
  })
  .strict();
export const creativeLinkSchema = z
  .object({
    linkId: z.string(),
    fromAssetId: z.string(),
    to: z
      .object({
        type: z.enum(["asset", "knowledge_entity", "chapter"]),
        id: z.string(),
      })
      .strict(),
    relation: z.string(),
    status: z.enum(["active", "removed"]),
    origin: z.string(),
    proposalId: z.string().optional(),
    actorId: z.string(),
    createdAt: z.string(),
    removedAt: z.string().optional(),
    fromName: z.string().optional(),
    toName: z.string().optional(),
  })
  .strict();
const decision = z
  .object({
    action: z.string(),
    actorId: z.string(),
    at: z.string(),
    note: z.string().optional(),
    edited: z.boolean().optional(),
  })
  .strict();
export const creativePatchSchema = z
  .object({
    name: z.string().optional(),
    summary: z.string().optional(),
    addAliases: list(z.string()).optional(),
    setFields: list(creativeFieldSchema).optional(),
    removeFields: list(z.string()).optional(),
    plan: creativePlanSchema.optional(),
  })
  .strict();
export const creativeProposalSchema = z
  .object({
    proposalId: z.string(),
    bookId: z.string(),
    changeSetId: z.string(),
    operation: creativeOperationSchema,
    kind: creativeKindSchema,
    stance: creativeStanceSchema,
    exploratory: z.boolean(),
    alternativeGroup: z.string().optional(),
    status: creativeProposalStatusSchema,
    targetAssetId: z.string().optional(),
    baseVersion: z.number().int().optional(),
    draft: creativeContentSchema.optional(),
    patch: creativePatchSchema.optional(),
    link: z
      .object({
        toAssetId: z.string().optional(),
        toProposalId: z.string().optional(),
        relation: z.string(),
      })
      .strict()
      .optional(),
    reason: z.string(),
    evidence: list(conversationEvidenceSchema),
    source: conversationSourceSchema,
    replacesProposalId: z.string().optional(),
    replacedByProposalId: z.string().optional(),
    createdAt: z.string(),
    decision: decision.optional(),
    resultAssetId: z.string().optional(),
    resultVersion: z.number().int().optional(),
    statusReason: z.string().optional(),
    // View fields computed by the server for review diffs.
    stale: z.boolean(),
    targetName: z.string().optional(),
    currentVersion: z.number().int().optional(),
    current: creativeContentSchema.optional(),
    result: creativeContentSchema.optional(),
    linkTargetName: z.string().optional(),
  })
  .strict();

export const creativeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    paused: z.boolean(),
    autoOrganize: z.boolean(),
    consentAt: z.string().optional(),
    model,
    configFingerprint: z.string().optional(),
    dailyTokenBudget: z.number().int(),
    dailyJobBudget: z.number().int(),
    available: z.boolean(),
    currentModel: model,
    needsModelConsent: z.boolean(),
    disclosure: z.string(),
    reserveTokens: z.number().int(),
    budgetDay: z.string(),
    budgetTokens: z.number().int(),
    budgetAttempts: z.number().int(),
  })
  .strict();
export const creativeOverviewSchema = z
  .object({
    bookId: z.string(),
    version: z.number().int(),
    settings: creativeSettingsSchema,
    counts: z.record(z.string(), z.record(z.string(), z.number().int())),
    pendingProposals: z.number().int(),
    jobs: z.record(z.string(), z.number().int()),
    openDivergences: z.number().int(),
  })
  .strict();
const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: list(item),
      total: z.number().int(),
      nextCursor: z.number().int().nullable(),
    })
    .strict();
export const creativeAssetPageSchema = pageOf(creativeAssetSummarySchema);
export const creativeProposalPageSchema = pageOf(creativeProposalSchema);
export const creativeAssetDetailSchema = z
  .object({
    asset: creativeAssetSchema,
    versions: list(creativeVersionSchema),
    links: list(creativeLinkSchema),
    proposals: list(creativeProposalSchema),
  })
  .strict();
export const creativeTurnSchema = z
  .object({
    turnKey: z.string(),
    sessionId: z.string(),
    messageId: z.string(),
    answerId: z.string(),
    status: z.enum([
      "awaiting",
      "queued",
      "organized",
      "no_change",
      "skipped",
      "cancelled",
      "failed",
      "expired",
    ]),
    reason: z.string().optional(),
    trigger: z.enum(["auto", "manual"]),
    excerpt: list(
      z
        .object({
          messageId: z.string(),
          role: z.enum(["user", "assistant"]),
          text: z.string(),
        })
        .strict(),
    ).optional(),
    excerptHash: z.string().optional(),
    acceptedAt: z.string(),
    capturedAt: z.string().optional(),
    jobId: z.string().optional(),
    changeSetId: z.string().optional(),
    updatedAt: z.string(),
    proposals: z.number().int().optional(),
    pending: z.number().int().optional(),
    summary: z.string().optional(),
  })
  .strict();
export const creativeTurnListSchema = z
  .object({ items: list(creativeTurnSchema) })
  .strict();
export const manuscriptEvidenceSchema = z
  .object({
    chapterId: z.string(),
    revisionId: z.string(),
    contentHash: z.string(),
    quote: z.string(),
    startUTF16: z.number().int().nonnegative(),
    endUTF16: z.number().int().nonnegative(),
  })
  .strict();
export const creativeDivergenceSchema = z
  .object({
    divergenceId: z.string(),
    jobId: z.string(),
    assetId: z.string(),
    assetVersion: z.number().int(),
    planText: z.string(),
    chapterId: z.string(),
    revisionId: z.string(),
    contentHash: z.string(),
    assessment: z.enum(["fulfilled", "diverged", "not_yet", "unclear"]),
    explanation: z.string(),
    question: z.string(),
    evidence: manuscriptEvidenceSchema.optional(),
    status: z.enum(["open", "noted", "decided", "superseded"]),
    decision: decision.optional(),
    model,
    createdAt: z.string(),
    stale: z.boolean().optional(),
    assetName: z.string().optional(),
  })
  .strict();
export const creativeDivergenceListSchema = z
  .object({ items: list(creativeDivergenceSchema) })
  .strict();
export const creativeWritingContextSchema = z
  .object({
    chapterId: z.string(),
    plans: list(creativeAssetSchema),
    payoffs: list(creativeAssetSchema),
    characters: list(creativeAssetSchema),
    rules: list(creativeAssetSchema),
    related: list(creativeAssetSchema),
    openQuestions: list(creativeAssetSchema),
    divergences: list(creativeDivergenceSchema),
    notice: z.string(),
  })
  .strict();
export const creativeDecideResultSchema = z
  .object({
    proposals: list(creativeProposalSchema.partial({ stale: true })),
    assets: list(creativeAssetSchema),
    links: list(creativeLinkSchema),
  })
  .strict();
export const creativeJobSchema = z
  .object({ jobId: z.string(), kind: z.string(), status: z.string() })
  .passthrough();

// Inputs
export const creativeAssetInputSchema = z
  .object({
    kind: creativeKindSchema,
    content: creativeContentSchema,
    status: z.enum(["draft", "accepted"]),
    note: z.string().max(500).optional(),
  })
  .strict();
export const creativeAssetUpdateSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    content: creativeContentSchema.optional(),
    status: creativeAssetStatusSchema.optional(),
    supersededBy: z.string().optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
export const creativeDecisionInputSchema = z
  .object({
    proposalId: z.string(),
    action: z.enum(["accept", "accept_edited", "reject"]),
    content: creativeContentSchema.optional(),
    status: z.enum(["draft", "accepted"]).optional(),
    expectedVersion: z.number().int().optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export type CreativeKind = z.infer<typeof creativeKindSchema>;
export type CreativeAsset = z.infer<typeof creativeAssetSchema>;
export type CreativeAssetSummary = z.infer<typeof creativeAssetSummarySchema>;
export type CreativeContent = z.infer<typeof creativeContentSchema>;
export type CreativeField = z.infer<typeof creativeFieldSchema>;
export type CreativeProposal = z.infer<typeof creativeProposalSchema>;
export type CreativeOverview = z.infer<typeof creativeOverviewSchema>;
export type CreativeSettings = z.infer<typeof creativeSettingsSchema>;
export type CreativeAssetDetail = z.infer<typeof creativeAssetDetailSchema>;
export type CreativeTurn = z.infer<typeof creativeTurnSchema>;
export type CreativeDivergence = z.infer<typeof creativeDivergenceSchema>;
export type CreativeWritingContext = z.infer<typeof creativeWritingContextSchema>;
export type CreativeDecisionInput = z.infer<typeof creativeDecisionInputSchema>;
export type CreativeAssetInput = z.infer<typeof creativeAssetInputSchema>;
export type CreativeAssetUpdate = z.infer<typeof creativeAssetUpdateSchema>;
export type CreativeVersion = z.infer<typeof creativeVersionSchema>;
export type CreativeLink = z.infer<typeof creativeLinkSchema>;

export const creativeKindLabels: Record<CreativeKind, string> = {
  character: "人物",
  world_rule: "世界规则",
  place: "地点",
  organization: "组织",
  plot_line: "剧情线",
  event: "事件计划",
  foreshadowing: "伏笔计划",
  character_arc: "人物轨迹",
  open_question: "待决问题",
};
export const creativeStanceLabels: Record<z.infer<typeof creativeStanceSchema>, string> = {
  author_decision: "作者决定",
  author_hypothesis: "作者假设",
  author_question: "待决问题",
  author_rejection: "作者否定",
  ai_suggestion: "AI 建议",
};
