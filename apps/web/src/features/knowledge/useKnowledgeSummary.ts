import { useEffect, useState } from 'react'
import type { MemoryView } from '@writer-agent/contracts'
import { knowledgeApi } from '../../services/api/knowledgeApi'

const POLL_MS = 8000

/**
 * Lightweight, read-only knowledge status for the header chip. It reads the
 * real Go `view` and never fabricates a value: on any failure it returns null
 * and the chip is simply not shown.
 */
export function useKnowledgeSummary(bookId: string | undefined, enabled: boolean) {
  const [view, setView] = useState<MemoryView | null>(null)

  useEffect(() => {
    setView(null)
    if (!enabled || !bookId) return
    let alive = true
    let timer: number | undefined
    let controller: AbortController | undefined

    const load = async () => {
      controller?.abort()
      controller = new AbortController()
      try {
        const next = await knowledgeApi.summary(bookId, controller.signal)
        if (!alive) return
        setView(next)
        // Poll only while work is outstanding; idle books cost nothing.
        const busy = next.settings.enabled && !next.settings.paused && (next.pending > 0 || next.running > 0)
        if (busy && document.visibilityState === 'visible') timer = window.setTimeout(() => void load(), POLL_MS)
      } catch {
        if (alive) setView(null)
      }
    }
    void load()
    const onVisible = () => {
      if (document.visibilityState === 'visible' && alive) {
        window.clearTimeout(timer)
        void load()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [bookId, enabled])

  return view
}
