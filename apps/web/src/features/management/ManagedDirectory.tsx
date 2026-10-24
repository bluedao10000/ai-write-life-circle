import { useState } from 'react'
import { useManagement } from './ManagedStudio'
import type { ManagedChapter, ManagedBook } from '@writer-agent/contracts'
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
  const { editing, setEditing } = m
  const b = m.book
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
      className="my-1 rounded px-2 py-1"
      style={{
        background: current === c.chapterId ? 'var(--surface-2)' : undefined,
      }}
    >
      {editing === c.chapterId ? (
        <Name
          label="章节名称"
          value={c.title}
          save={(title) => patch(c, { title })}
          cancel={() => setEditing(null)}
        />
      ) : (
        <div className="flex items-start gap-1">
          <button
            className="min-w-0 flex-1 truncate py-1 text-left"
            onClick={() => onOpen(c.chapterId)}
          >
            {c.title}
          </button>
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
        </div>
      )}
    </div>
  )
  const groups: ManagedBook['volumes'] = [
    { volumeId: '', title: '未分卷' },
    ...b.volumes.filter((v) => !v.archived),
  ]
  return (
    <div className="scroll h-full overflow-y-auto border-r bg-page p-3 text-ui text-ink">
      <div className="flex items-center justify-between">
        <h2>目录</h2>
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
        <button aria-label="关闭目录" onClick={onClose}>
          ×
        </button>
      </div>
      {groups.map((v) => (
        <section key={v.volumeId} className="mt-4">
          <div className="flex items-start justify-between gap-1 text-ink-2">
            {editing === v.volumeId && v.volumeId ? (
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
            {v.volumeId && (
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
          {b.chapters.filter((c) => !c.archived && (c.volumeId ?? '') === v.volumeId).map(chapter)}
        </section>
      ))}
      {b.volumes.some((v) => v.archived) && (
        <details className="mt-4">
          <summary>已归档空卷</summary>
          {b.volumes
            .filter((v) => v.archived)
            .map((v) => (
              <div key={v.volumeId}>
                {v.title}
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
              </div>
            ))}
        </details>
      )}
      {b.chapters.some((c) => c.archived) && (
        <details className="mt-6 border-t pt-3">
          <summary>已归档章节</summary>
          <p className="my-2 text-ink-3">归档不撤回已发布版本。</p>
          {b.chapters
            .filter((c) => c.archived)
            .map((c) => (
              <div key={c.chapterId} className="flex justify-between gap-2 py-2">
                <span>{c.title}</span>
                <button onClick={() => void patch(c, { archived: false })}>恢复</button>
              </div>
            ))}
        </details>
      )}
    </div>
  )
}
