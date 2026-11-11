import { useEffect, useMemo, useState } from 'react'
import { useManagement } from './ManagedStudio'
import { useWorkNavigation } from './StudioPage'
import type { ManagedChapter, ManagedBook } from '@writer-agent/contracts'

function chapterNumber(title: string, fallback: number) {
  return Number(title.match(/^第\s*(\d+)\s*章/)?.[1] ?? fallback)
}
function chapterName(title: string) {
  return title.replace(/^第\s*\d+\s*章[\s:：·.-]*/, '') || title
}
function Name({
  label,
  value,
  save,
  cancel,
}: {
  label: string
  value: string
  save: (value: string) => Promise<boolean>
  cancel: () => void
}) {
  const [text, setText] = useState(value)
  return (
    <form
      className="flex flex-wrap gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        void save(text).then((ok) => {
          if (ok) cancel()
        })
      }}
    >
      <input
        autoFocus
        aria-label={label}
        className="min-w-0 w-32 rounded border bg-page p-1"
        maxLength={200}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button>保存名称</button>
      <button type="button" onClick={cancel}>
        取消
      </button>
    </form>
  )
}
export default function ManagedDirectory({
  current,
  onOpen,
  onClose,
}: {
  current: string
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const m = useManagement()!
  const navigation = useWorkNavigation()
  const { editing, setEditing } = m
  const b = m.book
  const readOnly = b.readOnly
  const [query, setQuery] = useState('')
  const visible = useMemo(() => b.chapters.filter((chapter) => !chapter.archived), [b.chapters])
  const numbers = useMemo(
    () => new Map(visible.map((chapter, index) => [chapter.chapterId, chapterNumber(chapter.title, index + 1)])),
    [visible],
  )
  const groups: ManagedBook['volumes'] = useMemo(
    () => [{ volumeId: '', title: '未分卷' }, ...b.volumes.filter((volume) => !volume.archived)],
    [b.volumes],
  )
  const words = (chapterId: string) => m.wordCounts?.[chapterId]
  const totalWords = visible.reduce((total, chapter) => total + (words(chapter.chapterId) ?? 0), 0)
  const currentVolume = visible.find((chapter) => chapter.chapterId === current)?.volumeId ?? ''
  const [openVolumes, setOpenVolumes] = useState<Record<string, boolean>>(() => {
    const many = visible.length > 200
    return Object.fromEntries(
      groups.map((volume) => [volume.volumeId, !many || volume.volumeId === currentVolume]),
    )
  })
  useEffect(() => {
    if (!currentVolume) return
    setOpenVolumes((open) => (open[currentVolume] ? open : { ...open, [currentVolume]: true }))
  }, [currentVolume])
  const needle = query.trim()
  const matches = needle
    ? visible.filter(
        (chapter) =>
          chapter.title.includes(needle) ||
          String(numbers.get(chapter.chapterId) ?? '').includes(needle),
      )
    : visible
  const update = async (chapters = b.chapters, volumes = b.volumes) =>
    !!(await m.change({ operation: 'structure', chapters, volumes }))
  const patch = (c: ManagedChapter, fields: Partial<ManagedChapter>) =>
    update(b.chapters.map((x) => (x.chapterId === c.chapterId ? { ...x, ...fields } : x)))
  const move = (id: string, direction: number) => {
    const chapters = [...b.chapters],
      index = chapters.findIndex((c) => c.chapterId === id)
    const peers = chapters
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          c.volumeId === chapters[index].volumeId && c.archived === chapters[index].archived,
      )
    const next = peers[peers.findIndex((p) => p.i === index) + direction]?.i
    if (next === undefined) return
    ;[chapters[index], chapters[next]] = [chapters[next], chapters[index]]
    void update(chapters)
  }
  const volumeMove = (id: string, direction: number) => {
    const volumes = [...b.volumes]
    const peers = volumes.map((volume, index) => ({ volume, index })).filter(({ volume }) => !volume.archived)
    const position = peers.findIndex(({ volume }) => volume.volumeId === id)
    const current = peers[position]?.index
    const next = peers[position + direction]?.index
    if (current === undefined || next === undefined) return
    ;[volumes[current], volumes[next]] = [volumes[next], volumes[current]]
    void update(b.chapters, volumes)
  }
  const newChapter = (volumeId = b.chapters.find((c) => c.chapterId === current)?.volumeId) => {
    void m.change({ operation: 'chapter', ...(volumeId ? { volumeId } : {}) }, 'new')
  }
  const chapter = (c: ManagedChapter) => (
    <div
      key={c.chapterId}
      className="my-1 rounded px-2 py-1 [content-visibility:auto] [contain-intrinsic-size:32px]"
      style={{
        background: current === c.chapterId ? 'var(--surface-2)' : undefined,
      }}
    >
      {editing === c.chapterId && !readOnly ? (
        <Name
          label="章节名称"
          value={c.title}
          save={(title) => patch(c, { title })}
          cancel={() => setEditing(null)}
        />
      ) : (
        <div className="flex items-start gap-1">
          <button
            className="flex min-w-0 flex-1 items-baseline gap-2 py-1 text-left"
            aria-current={current === c.chapterId ? 'page' : undefined}
            onClick={() => onOpen(c.chapterId)}
          >
            <span className="w-6 shrink-0 text-right font-mono-num text-micro text-ink-3">
              {numbers.get(c.chapterId)}
            </span>
            <span className={`min-w-0 flex-1 truncate ${current === c.chapterId ? 'font-medium text-ink' : 'text-ink'}`}>
              {chapterName(c.title)}
            </span>
            <span className="shrink-0 font-mono-num text-micro text-ink-3">
              {words(c.chapterId) === undefined ? '—' : `${words(c.chapterId)!.toLocaleString('zh-CN')} 字`}
            </span>
          </button>
          {!readOnly && (
            <details className="relative">
              <summary aria-label={`${c.title}菜单`} className="cursor-pointer list-none px-1 py-1 [&::-webkit-details-marker]:hidden">
                ···
              </summary>
              <div className="relative z-10 grid gap-1 rounded border bg-page p-2 text-left">
                <button onClick={() => setEditing(c.chapterId)}>重命名</button>
                <button onClick={() => move(c.chapterId, -1)}>上移</button>
                <button onClick={() => move(c.chapterId, 1)}>下移</button>
                <label>
                  移动到
                  <select
                    aria-label={`${c.title}移动到卷`}
                    value={c.volumeId ?? ''}
                    className="w-full bg-page"
                    onChange={(e) => void patch(c, { volumeId: e.target.value || undefined })}
                  >
                    <option value="">未分卷</option>
                    {b.volumes
                      .filter((v) => !v.archived)
                      .map((v) => (
                        <option key={v.volumeId} value={v.volumeId}>
                          {v.title}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        '归档本章？正文和历史会保留，可随时恢复。已经公开的章节可能仍可被阅读；撤回请前往发布管理。',
                      )
                    )
                      void patch(c, { archived: true })
                  }}
                >
                  归档
                </button>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
  return (
    <div className="scroll flex h-full flex-col border-r bg-page text-ui text-ink">
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <h2>目录</h2>
        <div className="flex items-center gap-1">
          <button
            aria-label="刷新目录"
            className="px-2 py-1 text-ink-2 disabled:opacity-40"
            disabled={!m.refresh || m.busy}
            onClick={() => m.refresh?.()}
          >
            ↻
          </button>
          {!readOnly && (
            <details>
              <summary className="cursor-pointer list-none p-2 [&::-webkit-details-marker]:hidden" aria-label="新建章节或卷">
                ＋
              </summary>
              <div className="grid gap-2 border p-2">
                <button onClick={() => newChapter()}>新章节</button>
                <button
                  onClick={() => {
                    void m.change({ operation: 'volume' }).then((next) => {
                      if (next) setEditing(next.volumes.at(-1)!.volumeId)
                    })
                  }}
                >
                  新卷
                </button>
              </div>
            </details>
          )}
          <button aria-label="关闭目录" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      <p className="px-3 pb-2 text-micro text-ink-3" role="status">
        {readOnly ? '只读 · ' : ''}
        {visible.length.toLocaleString('zh-CN')} 章 · {groups.filter((volume) => volume.volumeId).length} 卷 ·{' '}
        {totalWords.toLocaleString('zh-CN')} 字
      </p>
      {m.busy && (
        <p role="status" className="px-3 pb-2 text-micro text-ink-3">
          正在更新目录…
        </p>
      )}
      {navigation && <button type="button" className="btn mx-3 mb-3 rounded-md border border-line px-3 py-2 text-left text-ui-sm text-ink-2 hover:bg-surface-2" onClick={() => navigation.open('chapters')}>管理章节 →</button>}
      <div className="px-3 pb-2">
        <input
          type="search"
          aria-label="查找章节"
          className="w-full rounded border border-line bg-page px-2 py-1.5 text-ui-sm"
          placeholder={`在 ${visible.length} 章中查找`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="scroll min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {visible.length === 0 ? (
          <div className="py-6 text-ui text-ink-3">
            <p>还没有章节。</p>
            {!readOnly && (
              <button className="mt-3 rounded border px-3 py-1.5 text-ink" onClick={() => newChapter()}>
                新建第一章
              </button>
            )}
          </div>
        ) : matches.length === 0 ? (
          <p className="py-6 text-ui text-ink-3">没有匹配的章节。</p>
        ) : (
          groups.map((v) => {
            const list = matches.filter((c) => (c.volumeId ?? '') === v.volumeId)
            if (needle && list.length === 0) return null
            const expanded = needle ? true : (openVolumes[v.volumeId] ?? false)
            const volumeWords = list.reduce((total, c) => total + (words(c.chapterId) ?? 0), 0)
            return (
              <section key={v.volumeId} className="mt-4">
                <div className="flex items-start justify-between gap-1 text-ink-2">
                  <div className="flex min-w-0 flex-1 items-baseline gap-2 py-1">
                    <button
                      className="shrink-0 px-1 text-ui-sm"
                      aria-label={`${expanded ? '收起' : '展开'}${v.title}`}
                      aria-expanded={expanded}
                      onClick={() => setOpenVolumes((open) => ({ ...open, [v.volumeId]: !expanded }))}
                    >
                      {expanded ? '▾' : '▸'}
                    </button>
                    {editing === v.volumeId && v.volumeId && !readOnly ? (
                      <Name
                        key={v.volumeId}
                        label="卷名称"
                        value={v.title}
                        save={(title) =>
                          update(
                            b.chapters,
                            b.volumes.map((x) => (x.volumeId === v.volumeId ? { ...x, title } : x)),
                          )
                        }
                        cancel={() => setEditing(null)}
                      />
                    ) : (
                      <h3 className="min-w-0 flex-1 break-words">{v.title}</h3>
                    )}
                    <span className="shrink-0 font-mono-num text-micro text-ink-3">
                      {list.length} 章 · {volumeWords.toLocaleString('zh-CN')} 字
                    </span>
                  </div>
                  {v.volumeId && !readOnly && (
                    <details>
                      <summary className="cursor-pointer" aria-label={`${v.title}菜单`}>
                        ···
                      </summary>
                      <div className="grid gap-2 rounded border bg-page p-2">
                        <button onClick={() => setEditing(v.volumeId)}>重命名卷</button>
                        <button onClick={() => volumeMove(v.volumeId, -1)}>卷上移</button>
                        <button onClick={() => volumeMove(v.volumeId, 1)}>卷下移</button>
                        <button onClick={() => newChapter(v.volumeId)}>在本卷新建章节</button>
                        <button
                          disabled={b.chapters.some((c) => c.volumeId === v.volumeId)}
                          onClick={() => {
                            if (window.confirm('归档这个空卷？'))
                              void update(
                                b.chapters,
                                b.volumes.map((x) =>
                                  x.volumeId === v.volumeId ? { ...x, archived: true } : x,
                                ),
                              )
                          }}
                        >
                          归档空卷
                        </button>
                      </div>
                    </details>
                  )}
                </div>
                {expanded && list.map(chapter)}
              </section>
            )
          })
        )}
        {!needle && b.volumes.some((v) => v.archived) && (
          <details className="mt-4">
            <summary>已归档空卷</summary>
            {b.volumes
              .filter((v) => v.archived)
              .map((v) => (
                <div key={v.volumeId}>
                  {v.title}
                  {!readOnly && (
                    <button
                      onClick={() =>
                        void update(
                          b.chapters,
                          b.volumes.map((x) =>
                            x.volumeId === v.volumeId ? { ...x, archived: false } : x,
                          ),
                        )
                      }
                    >
                      恢复卷
                    </button>
                  )}
                </div>
              ))}
          </details>
        )}
        {!needle && b.chapters.some((c) => c.archived) && (
          <details className="mt-6 border-t pt-3">
            <summary>已归档章节</summary>
            <p className="my-2 text-ink-3">归档不撤回已发布版本。</p>
            {b.chapters
              .filter((c) => c.archived)
              .map((c) => (
                <div key={c.chapterId} className="flex justify-between gap-2 py-2">
                  <span>{c.title}</span>
                  {!readOnly && <button onClick={() => void patch(c, { archived: false })}>恢复</button>}
                </div>
              ))}
          </details>
        )}
      </div>
    </div>
  )
}
