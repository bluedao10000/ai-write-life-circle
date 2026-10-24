import { noteListSchema, type AuthorNote } from '@writer-agent/contracts'
import type { NotesAdapter } from '../services/api/notesApi'

const storageKey = (project: string) => `writer-agent.demo-notes.v1:${project}`
export const demoNotesAdapter: NotesAdapter = {
  async list(projectId) {
    const raw = localStorage.getItem(storageKey(projectId))
    if (raw) return noteListSchema.parse(JSON.parse(raw)).items
    const { initialNotes } = await import('./vnextData')
    const items = initialNotes.map((note, index) => ({
      noteId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      projectId,
      content: note.text,
      chapterId: note.chapterId ?? null,
      purpose: note.nextUp ? ('next_writing' as const) : ('note' as const),
      status: note.archived ? ('archived' as const) : ('active' as const),
      version: 1,
      createdAt: new Date(note.at).toISOString(),
      updatedAt: new Date(note.at).toISOString(),
      createdBy: 'demo-author',
    }))
    const validated = noteListSchema.parse({ items })
    // Persist the seed once, in the independent Demo namespace only.
    localStorage.setItem(storageKey(projectId), JSON.stringify(validated))
    return validated.items
  },
  async save(projectId, input, key, noteId) {
    const items = await this.list(projectId)
    const current = items.find((item) => item.noteId === (noteId ?? key))
    if (!noteId && current) return current
    if (noteId && (!current || !('baseVersion' in input) || current.version !== input.baseVersion))
      throw new Error('演示笔记已更新，请先读取最新版本。')
    if (
      input.purpose === 'next_writing' &&
      (!('status' in input) || input.status === 'active') &&
      items.some(
        (item) =>
          item.noteId !== noteId && item.status === 'active' && item.purpose === 'next_writing',
      )
    )
      throw new Error('已有“下次要写”笔记，请先编辑或归档原计划。')
    const at = new Date().toISOString()
    const note: AuthorNote = {
      noteId: noteId ?? key,
      projectId,
      content: input.content,
      chapterId: input.chapterId,
      purpose: input.purpose,
      status: 'status' in input ? input.status : 'active',
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? at,
      updatedAt: at,
      createdBy: 'demo-author',
    }
    // A failed localStorage write must reject instead of reporting a saved note.
    localStorage.setItem(
      storageKey(projectId),
      JSON.stringify({
        items: current
          ? items.map((item) => (item.noteId === noteId ? note : item))
          : [...items, note],
      }),
    )
    return note
  },
}
