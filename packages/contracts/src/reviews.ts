import { z } from 'zod'

export const reviewTypeSchema = z.enum(['character_consistency', 'timeline_consistency'])
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const reviewModelSchema = z.object({
  provider: z.literal('openai-compatible'), model: z.string().min(1), endpoint: z.string().url(),
  execution: z.enum(['local', 'external']),
})
export const reviewSourceSchema = z.object({
  sourceId: z.string(), kind: z.enum(['target', 'historical_chapter', 'confirmed_knowledge']),
  projectId: z.string(), chapterId: z.string().nullable(), documentId: z.string().nullable(),
  revisionId: z.string().nullable(), title: z.string(), path: z.string(),
  contentHash: hash, sourceHash: hash, structureHash: hash.optional(), excerptHash: hash, excerpt: z.string(),
  startUTF16: z.number().int().nonnegative(), endUTF16: z.number().int().nonnegative(),
  freshness: z.enum(['current', 'changed', 'missing']),
})
export const textAnchorSchema = z.object({
  revisionId: z.string(), contentHash: hash, quote: z.string(),
  offsetEncoding: z.literal('utf16'), status: z.enum(['unique', 'ambiguous']),
  startUTF16: z.number().int().nonnegative().nullable(), endUTF16: z.number().int().nonnegative().nullable(),
})
export const evidenceReferenceSchema = z.object({
  sourceId: z.string(), quote: z.string(), verified: z.literal(true),
  contentHash: hash, sourceHash: hash,
  startUTF16: z.number().int().nonnegative().nullable(), endUTF16: z.number().int().nonnegative().nullable(),
  ambiguity: z.enum(['unique', 'ambiguous']),
})
export const reviewFeedbackChoiceSchema = z.enum(['useful', 'false_positive', 'intentional', 'ignored'])
export const reviewFeedbackSchema = z.object({
  findingId: z.string().uuid(), choice: reviewFeedbackChoiceSchema, authorId: z.string(),
  createdAt: z.string().datetime(), version: z.number().int().positive(),
})
export const reviewFindingSchema = z.object({
  findingId: z.string().uuid(), type: reviewTypeSchema, title: z.string(), inference: z.string(),
  question: z.string(), alternativeExplanation: z.string(), evidence: z.array(evidenceReferenceSchema).min(2),
  anchor: textAnchorSchema, feedback: reviewFeedbackSchema.nullable(),
})
export const reviewPreviewInputSchema = z.object({
  revisionId: z.string().min(1).max(200), contentHash: hash,
  reviewTypes: z.array(reviewTypeSchema).min(1).max(2),
}).strict()
export const reviewCreateSchema = reviewPreviewInputSchema.extend({
  consent: z.object({ confirmed: z.literal(true), planHash: hash }).strict(),
}).strict()
export const reviewPlanSchema = reviewPreviewInputSchema.extend({
  cost: z.object({ policy: z.literal('free-review-v1'), maxOutputTokens: z.number().int().min(128).max(32768), reservedPoints: z.number().int().positive().max(217) }).optional(),
  configFingerprint:z.string().optional(),
 strategyVersion: z.string().min(1),
  projectId: z.string(), chapterId: z.string(), planHash: hash, model: reviewModelSchema,
  sources: z.array(reviewSourceSchema).min(1), contextBytes: z.number().int().positive(),
  budgetBytes: z.number().int().positive(), excludedKnowledgeCount: z.number().int().nonnegative(),
  skippedSourceCount: z.number().int().nonnegative(),
})
export const reviewRunSchema = reviewPlanSchema.extend({
  runId: z.string().uuid(), createdBy: z.string(), version: z.number().int().positive(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  startedAt: z.string().datetime(), completedAt: z.string().datetime().nullable(), deadlineAt: z.string().datetime(),
  findings: z.array(reviewFindingSchema), rejectedCount: z.number().int().nonnegative(),
  rejectionReasons: z.array(z.string()), failureCode: z.string().nullable(),
  stale: z.boolean(), staleReasons: z.array(z.string()),
  usage: z.object({ cachedInputTokens: z.number().int().nonnegative().optional(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).nullable(),
})
export const reviewFeedbackInputSchema = z.object({
  choice: reviewFeedbackChoiceSchema, baseVersion: z.number().int().positive(),
}).strict()
export const reviewListSchema = z.object({ items: z.array(reviewRunSchema) })
export const reviewCandidateSchema = z.object({ findings: z.array(z.object({
  type: reviewTypeSchema, title: z.string().min(1).max(120), inference: z.string().min(1).max(2000),
  question: z.string().min(1).max(1000), alternativeExplanation: z.string().min(1).max(1000),
  evidence: z.array(z.object({ sourceId: z.string().min(1).max(200), quote: z.string().min(1).max(600) }).strict()).min(2).max(4),
}).strict()).max(20) }).strict()
export type ReviewType = z.infer<typeof reviewTypeSchema>
export type ReviewModel = z.infer<typeof reviewModelSchema>
export type ReviewSource = z.infer<typeof reviewSourceSchema>
export type TextAnchor = z.infer<typeof textAnchorSchema>
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>
export type ReviewFeedback = z.infer<typeof reviewFeedbackSchema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type ReviewPreviewInput = z.infer<typeof reviewPreviewInputSchema>
export type ReviewCreate = z.infer<typeof reviewCreateSchema>
export type ReviewPlan = z.infer<typeof reviewPlanSchema>
export type ReviewRun = z.infer<typeof reviewRunSchema>
export type ReviewFeedbackInput = z.infer<typeof reviewFeedbackInputSchema>
export const reviewJsonSchemas = {
  ReviewPreviewInput: z.toJSONSchema(reviewPreviewInputSchema), ReviewCreate: z.toJSONSchema(reviewCreateSchema),
  ReviewPlan: z.toJSONSchema(reviewPlanSchema), ReviewRun: z.toJSONSchema(reviewRunSchema),
  ReviewFeedbackInput: z.toJSONSchema(reviewFeedbackInputSchema), ReviewFeedback: z.toJSONSchema(reviewFeedbackSchema),
  ReviewFinding: z.toJSONSchema(reviewFindingSchema), EvidenceReference: z.toJSONSchema(evidenceReferenceSchema),
  TextAnchor: z.toJSONSchema(textAnchorSchema), ReviewList: z.toJSONSchema(reviewListSchema),
  ReviewCandidate: z.toJSONSchema(reviewCandidateSchema),
}
