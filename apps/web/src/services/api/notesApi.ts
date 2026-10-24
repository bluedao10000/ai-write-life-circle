import {
  authorNoteSchema,
  noteListSchema,
  type AuthorNote,
  type NoteCreate,
  type NoteUpdate,
} from '@writer-agent/contracts'
import { getJson, postJson, requestApi } from './client'

export interface NotesAdapter {
  list(projectId: string): Promise<AuthorNote[]>
  save(
    projectId: string,
    input: NoteCreate | NoteUpdate,
    key: string,
    noteId?: string,
  ): Promise<AuthorNote>
}
export const httpNotesAdapter: NotesAdapter = {
  async list(projectId) {
    const items = noteListSchema.parse(
      await getJson(`/v1/projects/${encodeURIComponent(projectId)}/notes`),
    ).items
    if (items.some((note) => note.projectId !== projectId))
      throw new Error('笔记列表与当前作品不匹配。')
    return items
  },
  async save(projectId, input, key, noteId) {
    const path = `/v1/projects/${encodeURIComponent(projectId)}/notes`
    const body = noteId
      ? (
          await requestApi(`${path}/${encodeURIComponent(noteId)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
            body: JSON.stringify(input),
          })
        ).body
      : await postJson(path, input, key)
    const note = authorNoteSchema.parse(body)
    if (note.projectId !== projectId || (noteId && note.noteId !== noteId))
      throw new Error('笔记响应与请求不匹配。')
    return note
  },
}
