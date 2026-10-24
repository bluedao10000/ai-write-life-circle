import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNotes } from '../features/notes/useNotes'
import type { AuthorNote } from '@writer-agent/contracts'
import type { NotesAdapter } from '../services/api/notesApi'

const note: AuthorNote = { noteId: '00000000-0000-4000-8000-000000000001', projectId: 'test', chapterId: null, content: '测试笔记', purpose: 'note', status: 'active', version: 1, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', createdBy: 'author' }
describe('notes service state', () => {
  it('keeps a confirmed save when an older list response arrives afterwards', async () => {
    let resolveList!: (items: AuthorNote[]) => void
    const adapter: NotesAdapter = { list: () => new Promise((resolve) => { resolveList = resolve }), save: async () => note }
    const { result } = renderHook(() => useNotes(adapter, 'test', true))
    await act(async () => { await result.current.save({ content: note.content, chapterId: null, purpose: 'note' }, note.noteId) })
    await act(async () => resolveList([]))
    expect(result.current.items).toEqual([note])
  })
  it('does not call an adapter when the server has not declared notes capability', async () => {
    const list = vi.fn(async () => [note])
    const adapter: NotesAdapter = { list, save: vi.fn(async () => note) }
    const { result } = renderHook(() => useNotes(adapter, 'test', false))
    expect(list).not.toHaveBeenCalled()
    await expect(result.current.save({ content: note.content, chapterId: null, purpose: 'note' }, note.noteId)).rejects.toThrow('服务器尚未提供笔记能力')
    expect(adapter.save).not.toHaveBeenCalled()
  })
  it('does not show a saved result when storage fails', async () => {
    const adapter: NotesAdapter = { list: async () => [], save: async () => { throw new Error('storage unavailable') } }
    const { result } = renderHook(() => useNotes(adapter, 'test', true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await expect(result.current.save({ content: note.content, chapterId: null, purpose: 'note' }, note.noteId)).rejects.toThrow('storage unavailable')
    expect(result.current.items).toEqual([])
  })
})
