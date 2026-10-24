import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthorNote, NoteCreate, NoteUpdate } from '@writer-agent/contracts'
import type { NotesAdapter } from '../../services/api/notesApi'

export function useNotes(adapter: NotesAdapter | undefined, projectId: string, enabled: boolean) {
  const [items, setItems] = useState<AuthorNote[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const reload = useCallback(async () => {
    if (!adapter || !enabled) return
    const request = ++generation.current
    setLoading(true)
    setError('')
    try {
      const result = await adapter.list(projectId)
      if (request === generation.current) setItems(result)
    } catch (cause) {
      if (request === generation.current)
        setError(cause instanceof Error ? cause.message : '笔记读取失败')
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [adapter, enabled, projectId])
  useEffect(() => {
    const requestGeneration = generation
    void reload()
    return () => {
      requestGeneration.current++
    }
  }, [reload])
  const save = async (input: NoteCreate | NoteUpdate, key: string, noteId?: string) => {
    if (!adapter || !enabled) throw new Error('服务器尚未提供笔记能力。')
    const result = await adapter.save(projectId, input, key, noteId)
    // Discard an older in-flight list that might hide this confirmed save.
    generation.current++
    setLoading(false)
    setItems((current) => [...current.filter((note) => note.noteId !== result.noteId), result])
    return result
  }
  return { items, loading, error, reload, save }
}
