import { useEffect, useRef } from 'react'
import { progress, type Progress, type ReaderSettings } from './store'

// One cancellable lifecycle owns restoration and persistence. Position is sampled
// on user scroll, before a later font/viewport/settings change can move paragraphs.
export function useReadingProgress(
  book: string | undefined,
  chapter: string | undefined,
  settings: ReaderSettings,
  onRatio: (r: number) => void,
  onRestored: (r: boolean) => void,
  onScroll: (y: number) => void,
) {
  const callbacks = useRef({ onRatio, onRestored, onScroll })
  callbacks.current = { onRatio, onRestored, onScroll }
  const metrics = `${settings.size}:${settings.leading}:${settings.width}`
  useEffect(() => {
    if (!book || !chapter) return
    let cancelled = false,
      ready = false,
      frame = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      notice: ReturnType<typeof setTimeout> | undefined,
      fontDeadline: ReturnType<typeof setTimeout> | undefined
    const saved = progress.get()[book],
      source = saved?.chapter === chapter ? saved : null
    let position: Progress[string] = source ?? {
      chapter,
      ratio: 0,
      at: Date.now(),
      anchor: 0,
      anchorOffset: 0,
    }
    const max = () =>
      Math.max(0, document.documentElement.scrollHeight - innerHeight)
    const paragraphs = () =>
      Array.from(document.querySelectorAll<HTMLElement>('.site-markdown p'))
    const ratio = () =>
      max() > 0 ? Math.max(0, Math.min(1, scrollY / max())) : 0
    const samplePosition = () => {
      const nodes = paragraphs()
      let anchor = 0
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].getBoundingClientRect().top <= 100) anchor = i
        else break
      }
      return {
        chapter,
        ratio: ratio(),
        at: Date.now(),
        anchor,
        anchorOffset: nodes[anchor]?.getBoundingClientRect().top ?? 0,
      }
    }
    const persist = () => {
      if (ready && !cancelled) progress.set((p) => ({ ...p, [book]: position }))
    }
    const settled = (initial: boolean) => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (cancelled) return
          ready = true
          position = samplePosition()
          callbacks.current.onRatio(ratio())
          if (initial && !source) persist()
          if (initial && source && source.ratio > 0.02) {
            callbacks.current.onRestored(true)
            notice = setTimeout(() => callbacks.current.onRestored(false), 2400)
          }
        })
      })
    }
    const restore = (initial: boolean) => {
      if (cancelled) return
      const anchor =
        position.anchor === undefined
          ? undefined
          : paragraphs()[position.anchor]
      const y = anchor
        ? scrollY +
          anchor.getBoundingClientRect().top -
          (position.anchorOffset ?? 0)
        : position.ratio * max()
      window.scrollTo(0, Math.min(max(), Math.max(0, y)))
      settled(initial)
    }
    const sample = () => {
      if (!ready || cancelled) return
      position = samplePosition()
      callbacks.current.onRatio(position.ratio)
      callbacks.current.onScroll(scrollY)
      clearTimeout(timer)
      timer = setTimeout(persist, 200)
    }
    const layoutChanged = () => {
      if (!ready || cancelled) return
      persist()
      ready = false
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => restore(false))
    }
    void Promise.race([
      document.fonts?.ready ?? Promise.resolve(),
      new Promise((resolve) => {
        fontDeadline = setTimeout(resolve, 1500)
      }),
    ]).then(() => {
      clearTimeout(fontDeadline)
      if (!cancelled) frame = requestAnimationFrame(() => restore(true))
    })
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(layoutChanged)
    const article = document.querySelector('article')
    if (article) observer?.observe(article)
    addEventListener('scroll', sample, { passive: true })
    addEventListener('resize', layoutChanged)
    addEventListener('pagehide', persist)
    return () => {
      persist()
      cancelled = true
      clearTimeout(timer)
      clearTimeout(notice)
      clearTimeout(fontDeadline)
      cancelAnimationFrame(frame)
      observer?.disconnect()
      removeEventListener('scroll', sample)
      removeEventListener('resize', layoutChanged)
      removeEventListener('pagehide', persist)
    }
  }, [book, chapter, metrics])
}
