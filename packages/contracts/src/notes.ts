import { z } from 'zod'

/** Author-owned application state; never a confirmed Harness fact. */
export const noteCreateSchema = z
  .object({
    content: z.string().min(1).max(20000).regex(/\S/, 'Content must not be blank'),
    chapterId: z.string().min(1).max(200).nullable().default(null),
    purpose: z.enum(['note', 'next_writing']).default('note'),
  })
  .strict()
export const noteUpdateSchema = noteCreateSchema
  .extend({
    baseVersion: z.number().int().positive(),
    status: z.enum(['active', 'archived']),
  })
  .strict()
export const authorNoteSchema = z.object({
  noteId: z.string().uuid(),
  projectId: z.string(),
  content: z.string(),
  chapterId: z.string().nullable(),
  purpose: z.enum(['note', 'next_writing']),
  status: z.enum(['active', 'archived']),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string(),
})
export const noteListSchema = z.object({ items: z.array(authorNoteSchema) })
export const capabilitiesSchema = z.object({
  notes: z.boolean(),
  agentRuntime: z.boolean(),
  knowledge: z.boolean(),
  annotations: z.boolean(),
  canonChanges: z.boolean(),
  evidenceReview: z.boolean().optional(),
})
export type AuthorNote = z.infer<typeof authorNoteSchema>
export type NoteCreate = z.infer<typeof noteCreateSchema>
export type NoteUpdate = z.infer<typeof noteUpdateSchema>
export type WorkspaceCapabilities = z.infer<typeof capabilitiesSchema>

/** Used by the reproducible OpenAPI extension generator. */
export const notesJsonSchemas = {
  AuthorNote: z.toJSONSchema(authorNoteSchema),
  NoteCreate: z.toJSONSchema(noteCreateSchema, { io: 'input' }),
  NoteUpdate: z.toJSONSchema(noteUpdateSchema, { io: 'input' }),
  NoteList: z.toJSONSchema(noteListSchema),
  WorkspaceCapabilities: z.toJSONSchema(capabilitiesSchema),
}
