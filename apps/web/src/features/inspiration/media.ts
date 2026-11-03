// Viewport helpers for the 灵感 workspace, ported from Figma Make
// (Writer Agent UI_UX Design/src/components/idea/Chat.tsx).
import { useEffect, useState } from 'react'

export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const sync = () => setMatches(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query])
  return matches
}

/**
 * Mobile soft keyboard: visualViewport writes the visible height into --app-h so
 * the composer and send button stay above the keyboard (iOS Safari / WebView do
 * not resize the layout viewport). Only on narrow screens inside 灵感; pinch zoom
 * (scale > 1) is left alone and leaving the page restores the normal height.
 */
export function useKeyboard(on: boolean) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const vv = window.visualViewport
    if (!on || !vv) return
    const root = document.documentElement
    const sync = () => {
      if (vv.scale > 1.01) return
      root.style.setProperty('--app-h', `${Math.round(vv.height)}px`)
      setOpen(window.innerHeight - vv.height > 120)
      if (window.scrollY !== 0) window.scrollTo(0, 0)
    }
    sync()
    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
    return () => {
      vv.removeEventListener('resize', sync)
      vv.removeEventListener('scroll', sync)
      root.style.removeProperty('--app-h')
      setOpen(false)
    }
  }, [on])
  return open
}

/**
 * iPhone Safari only reports env(safe-area-inset-bottom) with viewport-fit=cover.
 * Scoped to 灵感 on narrow screens so other pages keep their current layout.
 */
export function useSafeArea(on: boolean) {
  useEffect(() => {
    if (!on) return
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (!meta || /viewport-fit/.test(meta.content)) return
    const before = meta.content
    meta.content = `${before}, viewport-fit=cover`
    return () => {
      meta.content = before
    }
  }, [on])
}

export const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
