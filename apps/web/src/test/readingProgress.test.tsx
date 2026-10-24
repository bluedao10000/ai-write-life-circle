import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useReadingProgress } from '../site/readingProgress'
import { progress, type ReaderSettings } from '../site/store'
const settings: ReaderSettings = {
  size: 2,
  leading: 1,
  width: 1,
  theme: 'light',
}
const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (fonts) Object.defineProperty(document, 'fonts', fonts)
  else Reflect.deleteProperty(document, 'fonts')
  progress.set({})
})
it('never writes restoration scroll over saved progress and cancels chapter A before B initializes', async () => {
  vi.useFakeTimers()
  let finishFonts: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    finishFonts = resolve
  })
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready },
  })
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    value: 5000,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 1000,
  })
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
  const scroll = vi
    .spyOn(window, 'scrollTo')
    .mockImplementation(
      (x: number | ScrollToOptions | undefined, y?: number) => {
        const top = typeof x === 'number' ? y : x?.top
        Object.defineProperty(window, 'scrollY', {
          configurable: true,
          value: top ?? 0,
        })
      },
    )
  progress.set({ story: { chapter: 'chapter-a', ratio: 0.6, at: 1 } })
  const ratio = vi.fn(),
    restored = vi.fn(),
    moved = vi.fn()
  const { rerender, unmount } = renderHook(
    ({ chapter }) =>
      useReadingProgress('story', chapter, settings, ratio, restored, moved),
    { initialProps: { chapter: 'chapter-a' } },
  )
  fireEvent.scroll(window)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(progress.get().story.ratio).toBe(0.6)
  rerender({ chapter: 'chapter-b' })
  await act(async () => {
    finishFonts()
    await vi.advanceTimersByTimeAsync(120)
  })
  expect(scroll.mock.calls).toEqual([[0, 0]])
  expect(progress.get().story.chapter).toBe('chapter-b')
  expect(progress.get().story.ratio).toBe(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(restored).not.toHaveBeenCalledWith(true)
  expect(progress.get().story.chapter).toBe('chapter-b')
  unmount()
})
it('keeps an existing same-chapter ratio intact until layout restoration completes', async () => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  })
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    value: 5000,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 1000,
  })
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
  const scroll = vi
    .spyOn(window, 'scrollTo')
    .mockImplementation(
      (x: number | ScrollToOptions | undefined, y?: number) => {
        Object.defineProperty(window, 'scrollY', {
          configurable: true,
          value: typeof x === 'number' ? y : (x?.top ?? 0),
        })
        fireEvent.scroll(window)
      },
    )
  progress.set({ story: { chapter: 'chapter-a', ratio: 0.5, at: 1 } })
  const { unmount } = renderHook(() =>
    useReadingProgress(
      'story',
      'chapter-a',
      settings,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    ),
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(scroll).toHaveBeenCalledWith(0, 2000)
  expect(progress.get().story.ratio).toBe(0.5)
  unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(progress.get().story.ratio).toBe(0.5)
})
