import { useEffect, useRef, useState } from 'react'
import { Btn, Icon, IconBtn } from '../components/vnext/ui'
import { allChapters } from './data'
import { useReadingProgress } from './readingProgress'
import { Markdown } from './Markdown'
import { A, EmptyState, useCatalog } from './kit'
import { go, readerSettings, useTitle, type ReaderSettings } from './store'

const SIZES = [16, 17, 18, 20, 22]
const LEADS = [1.8, 2, 2.2]
const WIDTHS = ['32rem', '38rem', '44rem']

/** Read-only novel reader. Not the author's editor: no selection tools, no AI, no drafts. */
export default function Reader({ slug, no }: { slug: string; no: string }) {
  const { books, authors } = useCatalog()
  const book = books.find((b) => b.slug === slug)
  const s = readerSettings.use()
  const [bar, setBar] = useState(true)
  const [panel, setPanel] = useState<null | 'toc' | 'settings'>(null)
  const [ratio, setRatio] = useState(0)
  const [restored, setRestored] = useState(false)
  const lastY = useRef(0)
  const chapters = book ? allChapters(book) : []
  const idx = chapters.findIndex((c) => c.slug === no)
  const chapter = chapters[idx]
  const chapterVolumeTitle = book?.volumes.find((v) =>
    v.chapters.includes(chapter),
  )?.title
  const prev = chapters[idx - 1],
    next = chapters[idx + 1]
  useTitle(
    book && chapter
      ? `第 ${chapter.no} 章 ${chapter.title} · ${book.title} · story2u`
      : 'story2u',
  )

  useReadingProgress(
    book?.slug,
    chapter?.slug,
    s,
    setRatio,
    setRestored,
    (y) => {
      if (Math.abs(y - lastY.current) > 8) {
        setBar(y < lastY.current || y < 80)
        lastY.current = y
      }
    },
  )

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement)?.closest('input,textarea,select,button') ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey
      )
        return
      if (e.key === 'ArrowRight' && next)
        go(`/books/${slug}/chapters/${next.slug}`)
      if (e.key === 'ArrowLeft' && prev)
        go(`/books/${slug}/chapters/${prev.slug}`)
      if (e.key === 'Escape') setPanel(null)
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [prev, next, slug])

  useEffect(() => {
    if (!panel) return
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const container = document.querySelector<HTMLElement>('[data-reader-panel]')
    const controls = () =>
      Array.from(
        container?.querySelectorAll<HTMLElement>(
          'button,a[href],input,select,[tabindex="0"]',
        ) ?? [],
      ).filter((node) => !node.hasAttribute('disabled'))
    controls()[0]?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const list = controls(),
        first = list[0],
        last = list.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.removeEventListener('keydown', trap)
      previous?.focus()
    }
  }, [panel])

  if (!book || !chapter)
    return (
      <div className="p-10">
        <EmptyState
          title="这一章不存在或未公开"
          action={
            <Btn
              variant="outline"
              onClick={() => go(book ? `/books/${slug}` : '/')}
            >
              返回
            </Btn>
          }
        >
          作者可能已撤回这一章的公开。
        </EmptyState>
      </div>
    )
  const author = authors.find((a) => a.slug === book.authorSlug)
  const theme = s.theme === 'light' ? '' : `reader-${s.theme}`
  const toggleBar = () => setBar((b) => !b)

  return (
    <div className={`reader min-h-full ${theme}`}>
      <div className="fixed inset-x-0 top-0 z-40 h-0.5">
        <div
          className="reader-progress h-full transition-[width]"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <header
        className={`fixed inset-x-0 top-0 z-30 transition-transform duration-300 ${bar || panel ? '' : '-translate-y-full'}`}
      >
        <div className="r-bg flex h-14 items-center gap-2 px-3 sm:px-5">
          <IconBtn
            icon="back"
            label="返回作品详情"
            onClick={() => go(`/books/${slug}`)}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-prose text-ui">{book.title}</div>
            <div className="r-ink-2 truncate text-micro">
              第 {chapter.no} 章 · {chapter.title}
            </div>
          </div>
          <IconBtn
            icon="menu"
            label="目录"
            active={panel === 'toc'}
            onClick={() => setPanel(panel === 'toc' ? null : 'toc')}
          />
          <IconBtn
            icon="panel"
            label="阅读设置"
            active={panel === 'settings'}
            onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
          />
        </div>
      </header>

      <main
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button,a')) return
          if (innerWidth < 768) toggleBar()
        }}
        className="mx-auto px-6 pt-28 pb-40"
        style={{ maxWidth: WIDTHS[s.width] }}
      >
        <article aria-label={`第 ${chapter.no} 章 ${chapter.title}`}>
          <header className="mb-14">
            <div className="r-ink-2 text-ui-sm">
              {chapterVolumeTitle ? `${chapterVolumeTitle} · ` : ''}第{' '}
              {chapter.no} 章
            </div>
            <h1 className="mt-3 font-prose text-title font-medium sm:text-display">
              {chapter.title}
            </h1>
          </header>
          {chapter.paras ? (
            <div
              className="reader-text font-prose"
              style={{
                fontSize: SIZES[s.size],
                lineHeight: LEADS[s.leading],
                ['--r-gap' as string]: `${LEADS[s.leading] * 0.5}em`,
              }}
            >
              <Markdown
                markdown={chapter.markdown ?? chapter.paras.join('\n\n')}
              />
            </div>
          ) : (
            <p className="r-ink-2 text-ui">
              本章正文暂时无法加载，请刷新重试。
            </p>
          )}
        </article>

        <nav aria-label="章节导航" className="mt-24">
          <div className="r-ink-2 text-center text-ui-sm">— 本章完 —</div>
          {next ? (
            <A
              growth="next_chapter"
              to={`/books/${slug}/chapters/${next.slug}`}
              className="r-card mt-10 block rounded-lg px-6 py-5 text-center"
            >
              <div className="r-ink-2 text-ui-sm">下一章</div>
              <div className="mt-1 font-prose text-ui-lg">
                第 {next.no} 章 · {next.title}
              </div>
            </A>
          ) : (
            <div className="mt-10 text-center">
              <p className="font-prose text-ui-lg">
                {book.status === '已完结' ? '全书完。' : '你已读到最新一章。'}
              </p>
              <p className="r-ink-2 mt-2 text-ui-sm">
                {book.status !== '已完结'
                  ? `${author?.name ?? '作者'}发布新章节后，会出现在目录里。`
                  : `感谢阅读《${book.title}》。`}
              </p>
              <A to={`/books/${slug}`} variant="outline" className="mt-6">
                返回作品详情
              </A>
            </div>
          )}
          <div className="mt-6 flex justify-between text-ui-sm">
            {prev ? (
              <A
                to={`/books/${slug}/chapters/${prev.slug}`}
                className="r-ink-2 hover:underline"
              >
                ← 上一章
              </A>
            ) : (
              <span />
            )}
            <A to={`/books/${slug}`} className="r-ink-2 hover:underline">
              目录
            </A>
          </div>
        </nav>
      </main>

      {/* Mobile bottom bar */}
      <div
        className={`r-bg fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line-soft py-1 transition-transform duration-300 md:hidden ${bar || panel ? '' : 'translate-y-full'}`}
      >
        <Btn
          variant="quiet"
          disabled={!prev}
          onClick={() => prev && go(`/books/${slug}/chapters/${prev.slug}`)}
        >
          上一章
        </Btn>
        <Btn variant="quiet" onClick={() => setPanel('toc')}>
          目录
        </Btn>
        <Btn variant="quiet" onClick={() => setPanel('settings')}>
          设置
        </Btn>
        <Btn
          variant="quiet"
          disabled={!next}
          onClick={() => next && go(`/books/${slug}/chapters/${next.slug}`)}
        >
          下一章
        </Btn>
      </div>

      {restored && (
        <div
          role="status"
          className="fade-up fixed bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-ink px-4 py-2 text-ui text-page shadow-soft"
        >
          已回到上次读到的位置
        </div>
      )}

      {panel && (
        <>
          <div
            className="fade fixed inset-0 z-40 bg-scrim"
            onClick={() => setPanel(null)}
            aria-hidden
          />
          {panel === 'toc' ? (
            <nav
              data-reader-panel
              role="dialog"
              aria-modal="true"
              aria-label="目录"
              className="slide-r fixed inset-y-0 right-0 z-50 flex w-full max-w-drawer flex-col bg-surface shadow-soft"
            >
              <div className="flex items-center px-5 pt-4 pb-2">
                <span className="font-prose text-ui-lg text-ink">
                  {book.title}
                </span>
                <IconBtn
                  icon="x"
                  label="关闭"
                  className="ml-auto"
                  onClick={() => setPanel(null)}
                />
              </div>
              <div className="scroll flex-1 overflow-auto px-3 pb-8">
                {book.volumes.map((v, index) => (
                  <div key={index} className="mt-4">
                    {v.title && (
                      <div className="px-2 text-ui-sm text-ink-3">
                        {v.title}
                      </div>
                    )}
                    {v.chapters.map((c) => (
                      <A
                        key={c.no}
                        to={`/books/${slug}/chapters/${c.slug}`}
                        className={`flex gap-3 rounded-md px-2 py-2.5 ${c.slug === no ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2'}`}
                      >
                        <span className="w-7 text-ui-sm tabular-nums text-ink-3">
                          {c.no}
                        </span>
                        <span className="font-prose text-ui">{c.title}</span>
                      </A>
                    ))}
                  </div>
                ))}
              </div>
            </nav>
          ) : (
            <Settings s={s} onClose={() => setPanel(null)} />
          )}
        </>
      )}
    </div>
  )
}

function Settings({ s, onClose }: { s: ReaderSettings; onClose: () => void }) {
  const set = (p: Partial<ReaderSettings>) =>
    readerSettings.set((x) => ({ ...x, ...p }))
  const step = (
    label: string,
    val: number,
    max: number,
    on: (v: number) => void,
    lo: string,
    hi: string,
  ) => (
    <div className="flex items-center gap-3">
      <span className="w-12 text-ui-sm text-ink-3">{label}</span>
      <Btn
        size="sm"
        variant="outline"
        disabled={val <= 0}
        onClick={() => on(val - 1)}
        ariaLabel={`${label}减小`}
      >
        {lo}
      </Btn>
      <div className="flex flex-1 justify-center gap-1" aria-hidden>
        {Array.from({ length: max + 1 }).map((_, i) => (
          <span
            key={i}
            className={`h-1 w-4 rounded-full ${i <= val ? 'bg-ink' : 'bg-line'}`}
          />
        ))}
      </div>
      <Btn
        size="sm"
        variant="outline"
        disabled={val >= max}
        onClick={() => on(val + 1)}
        ariaLabel={`${label}增大`}
      >
        {hi}
      </Btn>
    </div>
  )
  const themes: [ReaderSettings['theme'], string, string][] = [
    ['light', '浅色', 'bg-page'],
    ['soft', '柔和', 'reader-soft'],
    ['dark', '深色', 'reader-dark'],
  ]
  return (
    <div
      data-reader-panel
      role="dialog"
      aria-modal="true"
      aria-label="阅读设置"
      className="fade-up fixed inset-x-0 bottom-0 z-50 rounded-t-xl bg-surface p-6 shadow-soft md:inset-x-auto md:top-16 md:right-5 md:bottom-auto md:w-80 md:rounded-xl"
    >
      <div className="mb-5 flex items-center">
        <span className="text-ui font-medium text-ink">阅读设置</span>
        <IconBtn icon="x" label="关闭" className="ml-auto" onClick={onClose} />
      </div>
      <div className="space-y-4">
        {step(
          '字号',
          s.size,
          4,
          (v) => set({ size: v as ReaderSettings['size'] }),
          'A-',
          'A+',
        )}
        {step(
          '行距',
          s.leading,
          2,
          (v) => set({ leading: v as ReaderSettings['leading'] }),
          '紧',
          '松',
        )}
        {step(
          '宽度',
          s.width,
          2,
          (v) => set({ width: v as ReaderSettings['width'] }),
          '窄',
          '宽',
        )}
        <div className="flex items-center gap-3">
          <span className="w-12 text-ui-sm text-ink-3">背景</span>
          <div className="grid flex-1 grid-cols-3 gap-2">
            {themes.map(([t, l, cls]) => (
              <Btn
                key={t}
                pressed={s.theme === t}
                onClick={() => set({ theme: t })}
                className={`reader ${cls} h-10 border ${s.theme === t ? 'border-ink' : 'border-line'}`}
              >
                <span className="text-ui-sm">{l}</span>
              </Btn>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-5 flex items-center gap-1.5 text-micro text-ink-3">
        <Icon name="lock" className="h-3 w-3" />
        设置与阅读进度仅保存在此浏览器，不跨设备同步。
      </p>
    </div>
  )
}
