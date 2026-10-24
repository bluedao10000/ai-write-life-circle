import { useCallback, useEffect, useRef, useState } from 'react'
import type { CreativeOverview } from '@writer-agent/contracts'
import { creativeApi } from '../../services/api/creativeApi'
import { creativeError } from './labels'

/** Book-level creative settings and counts. Refresh is explicit; no polling. */
export function useCreativeOverview(bookId: string | undefined, enabled: boolean) {
  const [overview, setOverview] = useState<CreativeOverview | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    if (!enabled || !bookId) return
    const id = ++generation.current
    const abort = new AbortController()
    creativeApi
      .overview(bookId, abort.signal)
      .then((value) => {
        if (id === generation.current) {
          setOverview(value)
          setError('')
        }
      })
      .catch((e: unknown) => {
        if (id === generation.current && !abort.signal.aborted) setError(creativeError(e))
      })
    return () => abort.abort()
  }, [bookId, enabled, tick])
  const refresh = useCallback(() => setTick((n) => n + 1), [])
  return { overview, error, refresh }
}
