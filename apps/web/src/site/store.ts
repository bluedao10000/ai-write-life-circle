import { useEffect, useSyncExternalStore } from 'react'
import { z } from 'zod'
export const go = (path: string) => {
  window.location.assign(path)
}
export const href = (path: string) => path
function persisted<T>(key: string, schema: z.ZodType<T>, initial: T) {
  let value = initial,
    loaded = false
  const listeners = new Set<() => void>()
  const load = () => {
    if (!loaded && typeof localStorage !== 'undefined') {
      loaded = true
      try {
        const raw = localStorage.getItem(key)
        if (raw) {
          const parsed = schema.safeParse(JSON.parse(raw))
          if (parsed.success) value = parsed.data
        }
      } catch {
        /* storage can be disabled */
      }
    }
    return value
  }
  return {
    get: load,
    set: (next: T | ((prior: T) => T)) => {
      const candidate =
        typeof next === 'function' ? (next as (p: T) => T)(load()) : next
      const parsed = schema.safeParse(candidate)
      if (!parsed.success) return
      value = parsed.data
      loaded = true
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* in-memory reading still works */
      }
      listeners.forEach((cb) => cb())
    },
    use: () =>
      useSyncExternalStore(
        (cb) => {
          listeners.add(cb)
          return () => {
            listeners.delete(cb)
          }
        },
        load,
        () => initial,
      ),
  }
}
export const prefs = persisted(
  'story2u.site.v2',
  z.object({ dark: z.boolean() }),
  { dark: false },
)
const progressSchema = z.record(
  z.string(),
  z.object({
    chapter: z.string(),
    ratio: z.number().min(0).max(1),
    at: z.number().nonnegative(),
    anchor: z.number().int().nonnegative().optional(),
    anchorOffset: z.number().optional(),
  }),
)
export type Progress = z.infer<typeof progressSchema>
export const progress = persisted<Progress>(
  'story2u.progress.v2',
  progressSchema,
  {},
)
const settingsSchema = z.object({
  size: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  leading: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  width: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  theme: z.enum(['light', 'soft', 'dark']),
})
export type ReaderSettings = z.infer<typeof settingsSchema>
export const readerSettings = persisted<ReaderSettings>(
  'story2u.reader.v2',
  settingsSchema,
  { size: 2, leading: 1, width: 1, theme: 'light' },
)
export function useTitle(title: string) {
  useEffect(() => {
    // Public navigation loads a new document: preserve authoritative SSR metadata.
    if (!document.getElementById('story2u-data')) document.title = title
  }, [title])
}
