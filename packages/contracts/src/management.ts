import { z } from 'zod'
const title = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\r\n\0]/.test(value))
// Legacy Harness headings predate the managed input length limit.
// Preserve readable existing titles; constrain only new mutations.
const inputTitle = title.max(200)
export const managedVolumeSchema = z
  .object({
    volumeId: z.string().regex(/^VOL-[A-Za-z0-9-]+$/),
    title,
    archived: z.boolean().optional(),
  })
  .strict()
export const managedChapterSchema = z
  .object({
    chapterId: z.string().regex(/^CH-\d{1,6}$/),
    title,
    volumeId: z.string().optional(),
    archived: z.boolean(),
  })
  .strict()
export const managedBookSchema = z
  .object({
    bookId: z.string().min(1),
    title,
    version: z.number().int().positive(),
    volumes: z.array(managedVolumeSchema),
    chapters: z.array(managedChapterSchema),
    readOnly: z.boolean(),
  })
  .strict()
export const managedBooksSchema = z
  .object({ items: z.array(managedBookSchema) })
  .strict()
export const structureInputSchema = z
  .object({
    baseVersion: z.number().int().nonnegative(),
    operation: z.enum(['create', 'rename', 'chapter', 'volume', 'structure']),
    title: inputTitle.optional(),
    volumeId: z.string().optional(),
    volumes: z
      .array(managedVolumeSchema.extend({ title: inputTitle }))
      .optional(),
    chapters: z
      .array(managedChapterSchema.extend({ title: inputTitle }))
      .optional(),
  })
  .strict()
export const deleteBookInputSchema = z
  .object({
    baseVersion: z.number().int().positive(),
  })
  .strict()
export type ManagedBook = z.infer<typeof managedBookSchema>
export type ManagedChapter = z.infer<typeof managedChapterSchema>
export type StructureInput = z.infer<typeof structureInputSchema>
export type DeleteBookInput = z.infer<typeof deleteBookInputSchema>

export const importWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict()
export const importVolumeSchema = z
  .object({
    volumeId: z.string().regex(/^VOL-[A-Za-z0-9-]+$/),
    title: inputTitle,
  })
  .strict()
export const importPreviewChapterSchema = z
  .object({
    chapterId: z.string().regex(/^CH-\d{1,6}$/),
    title,
    volumeId: z.string().regex(/^VOL-[A-Za-z0-9-]+$/).optional(),
    wordCount: z.number().int().nonnegative(),
    sourcePart: z.string().min(1),
    excerpt: z.string(),
  })
  .strict()
export const importPreviewSchema = z
  .object({
    importId: z.string().regex(/^imp-[0-9a-f]{24}$/),
    status: z.enum(['previewed', 'committed']),
    title,
    author: z.string().optional(),
    language: z.string().optional(),
    volumes: z.array(importVolumeSchema),
    chapters: z.array(importPreviewChapterSchema).min(1).max(2000),
    warnings: z.array(importWarningSchema).max(100),
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    bookId: z.string().optional(),
    knowledge: z
      .object({ status: z.literal('awaiting_author_consent') })
      .strict(),
    createdAt: z.string(),
    committedAt: z.string().optional(),
  })
  .strict()
export const importCommitChapterSchema = z
  .object({
    chapterId: z.string().regex(/^CH-\d{1,6}$/),
    title: inputTitle,
    volumeId: z.string().regex(/^VOL-[A-Za-z0-9-]+$/).optional(),
  })
  .strict()
export const importCommitInputSchema = z
  .object({
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    title: inputTitle,
    volumes: z.array(importVolumeSchema),
    chapters: z.array(importCommitChapterSchema).min(1).max(2000),
  })
  .strict()
export type ImportPreview = z.infer<typeof importPreviewSchema>
export type ImportCommitInput = z.infer<typeof importCommitInputSchema>
export const managementJsonSchemas = Object.fromEntries(
  Object.entries({
    ManagedBook: managedBookSchema,
    ManagedBooks: managedBooksSchema,
    StructureInput: structureInputSchema,
    DeleteBookInput: deleteBookInputSchema,
    ImportPreview: importPreviewSchema,
    ImportCommitInput: importCommitInputSchema,
  }).map(([key, schema]) => [
    key,
    z.toJSONSchema(schema, { unrepresentable: 'any' }),
  ]),
)
