import type { PrototypeThinkingAgent } from '../../services/prototypeThinking'
import { useEffect, useMemo, useState, type SetStateAction } from 'react'
import type { CanonChange, Entry, Margin, Session, StoryConflict } from './model'
import { relatedFor } from '../../mocks/vnextRelevance'
import type { Chapter, Doc } from './model'

export function usePrototype(enabled: boolean, chapter: Chapter | undefined, doc: Doc) {
  const [thinkingAgent, setThinkingAgent] = useState<PrototypeThinkingAgent | null>(null)
  const [baselineDoc, setBaselineDoc] = useState<Doc>({})
  const [entries, setEntries] = useState<Entry[]>([])
  const [margins, setMargins] = useState<Margin[]>([])
  const [conflicts, setConflicts] = useState<StoryConflict[]>([])
  const [changes, setChanges] = useState<CanonChange[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const session = sessions.find((value) => value.id === activeSessionId) ?? null
  const setSession = (value: SetStateAction<Session | null>) => {
    const next = typeof value === 'function' ? value(session) : value
    if (next) setSessions((all) => [...all.filter((item) => item.id !== next.id), next])
    setActiveSessionId(next?.id ?? null)
  }
  const [ignored, setIgnored] = useState<string[]>([])
  useEffect(() => {
    if (!enabled) return
    let active = true
    void Promise.all([import('../../mocks/vnextData'), import('../../mocks/vnextAgent')]).then(
      ([data, agent]) => {
        if (active) {
          setThinkingAgent(agent)
          setBaselineDoc(data.initialDoc)
          setSessions(data.initialSessions)
          setEntries(data.initialEntries)
          setMargins(data.initialMargins)
          setConflicts(data.initialConflicts)
        }
      },
    )
    return () => {
      active = false
    }
  }, [enabled])
  const related = useMemo(
    () =>
      enabled
        ? relatedFor(chapter, doc, entries)
        : { people: [], rules: [], facts: [], threads: [], more: 0 },
    [enabled, chapter, doc, entries],
  )
  const resolved = margins
    .filter((m) => m.chapterId === chapter?.id)
    .map((m) => {
      const quoteCount = (doc[m.chapterId] ?? []).reduce(
        (count, p) => count + (m.quote ? p.split(m.quote).length - 1 : 0),
        0,
      )
      const sameVersion =
        JSON.stringify(doc[m.chapterId]) === JSON.stringify(baselineDoc[m.chapterId])
      return {
        ...m,
        state: quoteCount === 1 && sameVersion ? m.state : ('stale' as const),
        facts: m.facts.map((s) =>
          s.chapterId
            ? {
                ...s,
                state:
                  JSON.stringify(doc[s.chapterId]) === JSON.stringify(baselineDoc[s.chapterId]) &&
                  (doc[s.chapterId] ?? []).reduce(
                    (n, p) => n + (s.quote ? p.split(s.quote).length - 1 : 0),
                    0,
                  ) === 1
                    ? ('ok' as const)
                    : ('stale' as const),
              }
            : s,
        ),
      }
    })
  const resolveSource = (source: import('./model').Source) =>
    source.chapterId
      ? {
          ...source,
          state:
            JSON.stringify(doc[source.chapterId]) ===
              JSON.stringify(baselineDoc[source.chapterId]) &&
            (doc[source.chapterId] ?? []).reduce(
              (n, p) => n + (source.quote ? p.split(source.quote).length - 1 : 0),
              0,
            ) === 1
              ? ('ok' as const)
              : ('stale' as const),
        }
      : source
  const resolvedConflicts = conflicts.map((conflict) => ({
    ...conflict,
    a: resolveSource(conflict.a),
    b: resolveSource(conflict.b),
  }))
  return {
    thinkingAgent,
    entries,
    setEntries,
    conflicts: resolvedConflicts,
    setConflicts,
    changes,
    setChanges,
    session,
    setSession,
    sessions,
    setActiveSessionId,
    ignored,
    setIgnored,
    related,
    margins: resolved,
  }
}
