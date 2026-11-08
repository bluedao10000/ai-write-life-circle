import { z } from 'zod'

export const analysisStrategyVersion = 'novel-intelligence-v1' as const

export const analysisStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
])
export const analysisBatchStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'stale',
])
export const analysisFindingKindSchema = z.enum([
  'character',
  'place',
  'event',
  'rule',
  'relationship',
  'thread',
  'timeline',
  'conflict',
  'continuity',
])
export const analysisFindingStatusSchema = z.enum([
  'proposed',
  'author_confirmed',
  'rejected',
  'superseded',
  'stale',
])
const extractedFindingKindSchema = z.enum([
  'character',
  'place',
  'event',
  'rule',
  'relationship',
  'thread',
  'timeline',
])
export const worldEntityKindSchema = z.enum([
  'character',
  'place',
  'faction',
  'item',
  'rule',
  'event',
  'thread',
])
export const worldEntityStateSchema = z.enum([
  'observed',
  'candidate',
  'author_confirmed',
  'rejected',
  'superseded',
])

export const analysisEvidenceSchema = z
  .object({
    chapterId: z.string().regex(/^CH-\d{1,6}$/),
    revisionId: z.string().min(1),
    contentHash: z.string().min(1),
    quote: z.string().min(1).max(4000),
    startUTF16: z.number().int().nonnegative(),
    endUTF16: z.number().int().positive(),
  })
  .strict()

export const analysisChapterRefSchema = z
  .object({
    chapterId: z.string().regex(/^CH-\d{1,6}$/),
    revisionId: z.string().min(1),
    contentHash: z.string().min(1),
    wordCount: z.number().int().nonnegative(),
    volumeId: z.string().optional(),
    order: z.number().int().nonnegative(),
  })
  .strict()

export const analysisBatchSchema = z
  .object({
    batchId: z.string().regex(/^batch-[0-9a-f]{24}$/),
    chapterIds: z.array(z.string().regex(/^CH-\d{1,6}$/)).max(5),
    status: analysisBatchStatusSchema,
    phase: z.enum(['chapters', 'synthesis']),
    attempts: z.number().int().nonnegative(),
    failureCode: z.string().optional(),
    taskId: z.string().optional(),
  })
  .strict()

export const analysisProgressSchema = z
  .object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  })
  .strict()

export const novelAnalysisJobSchema = z
  .object({
    analysisId: z.string().regex(/^ana-[0-9a-f]{24}$/),
    bookId: z.string().min(1),
    status: analysisStatusSchema,
    strategyVersion: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    progress: analysisProgressSchema,
    batches: z.array(analysisBatchSchema),
    synthesisStatus: z.enum(['pending', 'running', 'completed', 'failed']),
  })
  .strict()

export const novelAnalysisManifestSchema = z
  .object({
    analysisId: z.string().regex(/^ana-[0-9a-f]{24}$/),
    bookId: z.string().min(1),
    strategyVersion: z.string().min(1),
    createdAt: z.string(),
    chapters: z.array(analysisChapterRefSchema),
    batches: z.array(
      z.object({
        batchId: z.string().regex(/^batch-[0-9a-f]{24}$/),
        chapterIds: z.array(z.string().regex(/^CH-\d{1,6}$/)).max(5),
      }).strict(),
    ),
  })
  .strict()

export const analysisFindingSchema = z
  .object({
    findingId: z.string().regex(/^find-[0-9a-f]{24}$/),
    analysisId: z.string().regex(/^ana-[0-9a-f]{24}$/),
    batchId: z.string().regex(/^batch-[0-9a-f]{24}$/),
    kind: analysisFindingKindSchema,
    title: z.string().min(1),
    statement: z.string().min(1),
    alternativeExplanation: z.string().optional(),
    confidence: z.number().min(0).max(1),
    status: analysisFindingStatusSchema,
    entityIds: z.array(z.string()).max(20),
    evidence: z.array(analysisEvidenceSchema).min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    authorNote: z.string().optional(),
  })
  .strict()

export const worldEntitySchema = z
  .object({
    entityId: z.string().regex(/^went-[0-9a-f]{24}$/),
    bookId: z.string().min(1),
    kind: worldEntityKindSchema,
    name: z.string().min(1),
    aliases: z.array(z.string()).max(20),
    description: z.string(),
    attributes: z.record(z.string(), z.string()),
    state: worldEntityStateSchema,
    firstChapterId: z.string().optional(),
    lastChapterId: z.string().optional(),
    evidence: z.array(analysisEvidenceSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()

export const novelAnalysisViewSchema = z
  .object({
    job: novelAnalysisJobSchema.nullable(),
    manifest: novelAnalysisManifestSchema.nullable(),
    findings: z.array(analysisFindingSchema),
    entities: z.array(worldEntitySchema),
  })
  .strict()

export const createAnalysisInputSchema = z
  .object({
    chapterIds: z.array(z.string().regex(/^CH-\d{1,6}$/)).min(1).max(2000).optional(),
  })
  .strict()

export const analysisDecisionInputSchema = z
  .object({
    decision: z.enum(['confirm', 'reject']),
    note: z.string().max(2000).optional(),
  })
  .strict()

export const novelAnalysisCandidatesSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            kind: extractedFindingKindSchema,
            title: z.string().min(1).max(200),
            statement: z.string().min(1).max(2000),
            alternativeExplanation: z.string().max(1000).optional(),
            confidence: z.number().min(0).max(1),
            entityNames: z.array(z.string().min(1).max(120)).max(20).optional(),
            evidence: z
              .array(
                z
                  .object({
                    chapterId: z.string().regex(/^CH-\d{1,6}$/),
                    quote: z.string().min(1).max(4000),
                  })
                  .strict(),
              )
              .min(1)
              .max(12),
          })
          .strict(),
      )
      .max(80),
    entities: z
      .array(
        z
          .object({
            kind: worldEntityKindSchema,
            name: z.string().min(1).max(120),
            aliases: z.array(z.string().min(1).max(120)).max(20).optional(),
            description: z.string().max(2000).optional(),
            attributes: z.record(z.string(), z.string().max(500)).optional(),
          })
          .strict(),
      )
      .max(80),
  })
  .strict()

export const novelSynthesisCandidatesSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            kind: z.enum(['conflict', 'continuity']),
            title: z.string().min(1).max(200),
            statement: z.string().min(1).max(2000),
            confidence: z.number().min(0).max(1),
            entityNames: z.array(z.string().min(1).max(120)).max(20).optional(),
            evidence: z
              .array(
                z
                  .object({
                    chapterId: z.string().regex(/^CH-\d{1,6}$/),
                    quote: z.string().min(1).max(4000),
                  })
                  .strict(),
              )
              .min(1)
              .max(12),
          })
          .strict(),
      )
      .max(80),
    entities: z.array(z.object({}).strict()).max(0),
  })
  .strict()

export type NovelAnalysisJob = z.infer<typeof novelAnalysisJobSchema>
export type NovelAnalysisManifest = z.infer<typeof novelAnalysisManifestSchema>
export type AnalysisFinding = z.infer<typeof analysisFindingSchema>
export type WorldEntity = z.infer<typeof worldEntitySchema>
export type NovelAnalysisView = z.infer<typeof novelAnalysisViewSchema>
export type NovelAnalysisCandidates = z.infer<typeof novelAnalysisCandidatesSchema>
export type NovelSynthesisCandidates = z.infer<typeof novelSynthesisCandidatesSchema>

export const analysisJsonSchemas = Object.fromEntries(
  Object.entries({
    NovelAnalysisView: novelAnalysisViewSchema,
    CreateAnalysisInput: createAnalysisInputSchema,
    AnalysisDecisionInput: analysisDecisionInputSchema,
    NovelAnalysisCandidates: novelAnalysisCandidatesSchema,
    NovelSynthesisCandidates: novelSynthesisCandidatesSchema,
  }).map(([key, schema]) => [key, z.toJSONSchema(schema, { unrepresentable: 'any' })]),
)
