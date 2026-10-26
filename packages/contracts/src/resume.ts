import { z } from 'zod'

/** Navigation metadata only. Never store prose or excerpts here. */
export const workspaceResumeSchema = z.object({
  schema: z.literal(1),
  chapterId: z.string().min(1).max(128),
  view: z.enum(['inspire', 'read', 'book']),
  compose: z.boolean(),
  scroll: z.number().int().min(0).max(10_000_000),
  from: z.number().int().min(0).max(5_000_000),
  to: z.number().int().min(0).max(5_000_000),
  revisionId: z.string().max(512).optional(),
  updatedAt: z.string().datetime(),
}).strict()
export type WorkspaceResume = z.infer<typeof workspaceResumeSchema>
