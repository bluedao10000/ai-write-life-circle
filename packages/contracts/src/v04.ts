import { z } from 'zod'
import { capabilitiesSchema } from './notes.js'

/** Runtime schemas for the Workspace and Chapter operations in Figma Make's proposed V0.4 contract. */
export const actorV04Schema = z.object({
  type: z.enum(['author', 'agent', 'system']),
  id: z.string().optional(),
  label: z.string().optional(),
})
export type ActorV04 = z.infer<typeof actorV04Schema>

export const userWorkspaceStateV04Schema = z.object({
  lastView: z.enum(['write', 'kb', 'reasoning']).optional(),
  lastChapterId: z.string().optional(),
  layout: z.object({
    leftOpen: z.boolean().optional(),
    rightOpen: z.boolean().optional(),
    leftW: z.number().int().min(200).max(360).optional(),
    rightW: z.number().int().min(320).max(560).optional(),
    focus: z.boolean().optional(),
  }).optional(),
  theme: z.enum(['light', 'dark']).optional(),
  kbRecent: z.array(z.string()).max(6).optional(),
  activeSessionId: z.string().optional(),
  currentBranchBySession: z.record(z.string(), z.string()).optional(),
})
export type UserWorkspaceStateV04 = z.infer<typeof userWorkspaceStateV04Schema>

export const workspaceV04Schema = z.object({
  capabilities: capabilitiesSchema.optional(),
  project: z.object({
    projectId: z.string().optional(),
    title: z.string().optional(),
    harnessHeadCommit: z.string().optional(),
    projectedFromCommit: z.string().optional(),
    demo: z.boolean().optional(),
  }),
  userState: userWorkspaceStateV04Schema,
  counts: z.object({
    pendingProposals: z.number().int().optional(),
    openIssues: z.number().int().optional(),
    runningTasks: z.number().int().optional(),
    pausedSessions: z.number().int().optional(),
  }),
  runningTasks: z.array(z.unknown()).optional(),
})
export type WorkspaceV04 = z.infer<typeof workspaceV04Schema>

export const chapterSummaryV04Schema = z.object({
  chapterId: z.string().optional(),
  title: z.string().optional(),
  meta: z.string().optional(),
  order: z.number().int().optional(),
  wordCount: z.number().int().optional(),
  pendingProposalCount: z.number().int().optional(),
  needsReview: z.boolean().optional(),
})

export const volumeWithChaptersV04Schema = z.object({
  volumeId: z.string().optional(),
  title: z.string().optional(),
  chapters: z.array(chapterSummaryV04Schema).optional(),
})
export type VolumeWithChaptersV04 = z.infer<typeof volumeWithChaptersV04Schema>

export const chapterListV04Schema = z.object({
  volumes: z.array(volumeWithChaptersV04Schema),
})
export type ChapterListV04 = z.infer<typeof chapterListV04Schema>

export const chapterRevisionSummaryV04Schema = z.object({
  revisionId: z.string().optional(),
  parentRevisionId: z.string().nullable().optional(),
  contentHash: z.string().optional(),
  wordCount: z.number().int().optional(),
  createdAt: z.string().datetime().optional(),
  createdBy: actorV04Schema.optional(),
  commitRef: z.string().nullable().optional(),
})
export type ChapterRevisionSummaryV04 = z.infer<typeof chapterRevisionSummaryV04Schema>

export const chapterRevisionCreateV04Schema = z.object({
  baseRevisionId: z.string().nullable(),
  markdown: z.string().max(2 * 1024 * 1024),
  clientSavedAt: z.string().datetime().optional(),
  trigger: z.enum(['autosave', 'manual', 'chapter_switch', 'pre_review']).optional(),
})
export type ChapterRevisionCreateV04 = z.infer<typeof chapterRevisionCreateV04Schema>

export const chapterDetailV04Schema = z.object({
  chapterId: z.string(),
  volumeId: z.string().optional(),
  title: z.string(),
  meta: z.string().optional(),
  headRevision: chapterRevisionSummaryV04Schema.extend({ markdown: z.string() }),
})
export type ChapterDetailV04 = z.infer<typeof chapterDetailV04Schema>

export const pageV04Schema = z.object({
  items: z.array(chapterRevisionSummaryV04Schema),
  nextCursor: z.string().nullable().optional(),
  total: z.number().int().optional(),
})
export type PageV04<T> = { items: T[]; nextCursor?: string | null; total?: number }

export const problemV04Schema = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  current: z.unknown().optional(),
  requestId: z.string().optional(),
})
export type ProblemV04 = z.infer<typeof problemV04Schema>
