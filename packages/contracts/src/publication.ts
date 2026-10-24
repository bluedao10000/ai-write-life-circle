import { z } from 'zod'

const slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const id = z.string().min(1).max(256)
const nonblank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0)
const coverSchema = z.strictObject({
  bg: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  fg: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  mark: z.enum(['rule', 'circle', 'wave', 'grid', 'none']),
})
export const publicationMetadataSchema = z.strictObject({
  slug,
  title: nonblank(160),
  penName: nonblank(100),
  authorBio: z.string().max(2000),
  tagline: nonblank(250),
  description: nonblank(10000),
  category: nonblank(80),
  categories: z.array(nonblank(80)).max(10).optional(),
  serialStatus: z.enum(['ongoing', 'completed', 'paused']),
  cover: coverSchema.optional(),
  coverUrl: z.union([
    z.literal(''),
    z
      .url()
      .max(2048)
      .refine((s) => {
        const u = new URL(s)
        return u.protocol === 'https:' && !u.username && !u.password
      }),
  ]),
})
export const publicationSelectionSchema = z.strictObject({
  chapterId: z.string().regex(/^CH-\d{1,6}$/),
  revisionId: id,
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  volumeId: z.string().max(256),
  chapterOrder: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
})
export const publicationPreviewInputSchema = z.strictObject({
  baseVersionId: id.nullable(),
  metadata: publicationMetadataSchema,
  chapters: z.array(publicationSelectionSchema).max(100),
})
export const publicationCommitInputSchema = z.strictObject({
  note: z.string().max(2000).optional(),
  baseVersionId: id.nullable(),
  previewId: id,
})
export const publicationTransitionInputSchema = z.strictObject({
  baseVersionId: id,
})
const snapshot = publicationSelectionSchema.extend({
  slug: z.string(),
  title: z.string(),
  volumeTitle: z.string().optional(),
  volumeOrder: z.number().int().positive(),
  markdown: z.string(),
})
export const publicationPreviewSchema = z.strictObject({
  previousChapters: z.array(snapshot),
  previewId: id,
  bookId: id,
  baseVersionId: id.nullable(),
  metadata: publicationMetadataSchema,
  chapters: z.array(snapshot),
  expiresAt: z.iso.datetime({ offset: true }),
  createdBy: id,
})
export const publicationVersionSchema = z.strictObject({
  note: z.string().max(2000).optional(),
  publicUrl: z.string().regex(/^\/books\/[a-z0-9-]+$/),
  versionId: id,
  publicationId: id,
  versionNumber: z.number().int().positive(),
  state: z.enum(['listed', 'unlisted']),
  metadata: publicationMetadataSchema,
  chapters: z.array(snapshot),
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: id,
  auditReference: id,
})
const publication = z.strictObject({
  publicationId: id,
  studioBookId: id,
  ownerUserId: id,
  authorSlug: slug,
  currentVersionId: id,
  versions: z.array(publicationVersionSchema).min(1),
  chapterSlugs: z.record(z.string(), slug),
})
export const publicationManagementSchema = z.strictObject({
  publication: publication
    .extend({
      versions: z
        .array(
          publicationVersionSchema.extend({
            chapters: z.array(snapshot.omit({ markdown: true })),
          }),
        )
        .min(1),
    })
    .nullable(),
  changedChapterIds: z.array(id),
  drafts: z.array(
    publicationSelectionSchema.extend({
      title: z.string(),
      volumeTitle: z.string().optional(),
      words: z.number().int().nonnegative(),
      isEmpty: z.boolean(),
    }),
  ),
})
export const publicationHistorySchema = z.strictObject({
  items: z.array(publicationVersionSchema),
})
export const publicChapterRefSchema = z.strictObject({
  publishedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  slug,
  title: z.string(),
  volumeTitle: z.string().optional(),
  volumeOrder: z.number().int().positive(),
  chapterOrder: z.number().int().nonnegative(),
})
export const publicBookSchema = z.strictObject({
  contentUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  publicationUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  slug,
  title: z.string(),
  penName: z.string(),
  authorSlug: slug,
  tagline: z.string(),
  description: z.string(),
  cover: coverSchema.optional(),
  categories: z.array(z.string()).optional(),
  category: z.string(),
  serialStatus: z.enum(['ongoing', 'completed', 'paused']),
  coverUrl: z.string(),
  firstPublishedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  chapterCount: z.number().int().positive(),
  chapters: z.array(publicChapterRefSchema),
})
export const publicChapterSchema = publicChapterRefSchema.extend({
  bookSlug: slug,
  markdown: z.string(),
  previous: slug.nullable(),
  next: slug.nullable(),
})
export const publicCatalogSchema = z.strictObject({
  items: z.array(publicBookSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
})
export const publicHomeSchema = z.strictObject({
  items: z.array(publicBookSchema),
  total: z.number().int().nonnegative(),
  featured: publicBookSchema.nullable(),
  opening: z.string().nullable(),
  categories: z.array(z.string()),
})
export const publicAuthorSchema = z.strictObject({
  slug,
  penName: z.string(),
  bio: z.string(),
  books: z.array(publicBookSchema),
})
export const publicCategoriesSchema = z.strictObject({
  items: z.array(z.string()),
})
export const publicationProblemSchema = z.strictObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  code: z.string(),
  requestId: z.string().optional(),
})

export type PublicationMetadata = z.infer<typeof publicationMetadataSchema>
export type PublicationSelection = z.infer<typeof publicationSelectionSchema>
export type PublicationPreviewInput = z.infer<
  typeof publicationPreviewInputSchema
>
export type PublicationCommitInput = z.infer<
  typeof publicationCommitInputSchema
>
export type PublicationVersion = z.infer<typeof publicationVersionSchema>
export type PublicationPreview = z.infer<typeof publicationPreviewSchema>
export type PublicationManagement = z.infer<typeof publicationManagementSchema>
export type PublicBook = z.infer<typeof publicBookSchema>
export type PublicChapter = z.infer<typeof publicChapterSchema>
export type PublicHome = z.infer<typeof publicHomeSchema>
export type PublicCatalog = z.infer<typeof publicCatalogSchema>
export type PublicAuthor = z.infer<typeof publicAuthorSchema>

export const publicationSchemas = {
  PublicationMetadata: publicationMetadataSchema,
  PublicationSelection: publicationSelectionSchema,
  PublicationPreviewInput: publicationPreviewInputSchema,
  PublicationCommitInput: publicationCommitInputSchema,
  PublicationTransitionInput: publicationTransitionInputSchema,
  PublicationPreview: publicationPreviewSchema,
  PublicationVersion: publicationVersionSchema,
  PublicationManagement: publicationManagementSchema,
  PublicationHistory: publicationHistorySchema,
  PublicBook: publicBookSchema,
  PublicChapter: publicChapterSchema,
  PublicHome: publicHomeSchema,
  PublicCatalog: publicCatalogSchema,
  PublicAuthor: publicAuthorSchema,
  PublicCategories: publicCategoriesSchema,
  PublicationProblem: publicationProblemSchema,
}

export const publicationJsonSchemas = Object.fromEntries(
  Object.entries(publicationSchemas).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, { unrepresentable: 'any' }),
  ]),
)
