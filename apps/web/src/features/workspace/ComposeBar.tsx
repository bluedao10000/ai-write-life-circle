import { useEffect, useRef, useState } from 'react'
import type { ChapterRevisionSummaryV04 } from '@writer-agent/contracts'
import { Btn, Dialog, IconBtn } from '../../components/vnext/ui'
import { listChapterRevisions } from '../../services/api/chapterApi'
import type { useStudioController } from '../vnext/useStudioController'

type Studio = ReturnType<typeof useStudioController>

/**
 * Reading ↔ compose switch. Reading mounts the same editor read-only; compose
 * enables editing inside the existing Revision/CAS autosave pipeline.
 */
export function ReadingBar({ studio, api }: { studio: Studio; api: boolean }) {
  const { compose, setCompose, readonly, chapter, workspace, setAssetsOpen, assetsOpen } = studio
  const loaded = workspace.chapterLoadState.status === 'loaded' && !!chapter.id
  if (compose) return null
  return (
    <div className="chrome mx-auto flex w-full max-w-page flex-wrap items-center gap-2 px-8 pt-4 text-ui-sm text-ink-3 sm:px-12">
      <span>阅读模式 · 正文不可编辑</span>
      <span className="ml-auto" />
      {api && loaded && (
        <Btn size="sm" pressed={assetsOpen} onClick={() => setAssetsOpen(!assetsOpen)}>
          本章设定
        </Btn>
      )}
      <Btn size="sm" variant="primary" disabled={!loaded || readonly} title={readonly ? '此章节为只读保护格式' : undefined} onClick={() => setCompose(true)}>
        进入创作
      </Btn>
    </div>
  )
}

export function ComposeBar({ studio, api }: { studio: Studio; api: boolean }) {
  const { compose, setCompose, typewriter, toggleTypewriter, assetsOpen, setAssetsOpen, bridge, status, workspace, current } = studio
  const start = useRef<{ chapter: string; words: number } | null>(null)
  const [history, setHistory] = useState(false)
  useEffect(() => {
    if (!compose) {
      start.current = null
      return
    }
    if (bridge.words !== null && start.current?.chapter !== current) start.current = { chapter: current, words: bridge.words }
  }, [compose, bridge.words, current])
  if (!compose) return null
  const words = bridge.words ?? 0
  const delta = start.current ? words - start.current.words : 0
  return (
    <>
      <div role="toolbar" aria-label="创作工具栏" className="chrome pointer-events-auto fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-surface/95 px-3 py-1 text-ui-sm text-ink-3 shadow-soft backdrop-blur">
        <span className="font-mono-num tabular-nums" aria-live="polite">
          {words} 字{delta !== 0 ? ` · 本次 ${delta > 0 ? '+' : ''}${delta}` : ''}
        </span>
        <span className="mx-1 text-ink-4">|</span>
        <span>{status}</span>
        <IconBtn icon="target" label={typewriter ? '关闭打字机模式' : '打字机模式'} active={typewriter} onClick={toggleTypewriter} size="sm" />
        {api && <IconBtn icon="layers" label={assetsOpen ? '收起本章设定' : '本章设定'} active={assetsOpen} onClick={() => setAssetsOpen(!assetsOpen)} size="sm" />}
        {api && <IconBtn icon="history" label="历史版本" onClick={() => setHistory(true)} size="sm" />}
        <Btn
          size="sm"
          onClick={() => {
            void workspace.flushSave().finally(() => setCompose(false))
          }}
        >
          完成创作
        </Btn>
      </div>
      {history && <RevisionHistory projectId={workspace.projectId} chapterId={current} onClose={() => setHistory(false)} />}
    </>
  )
}

function RevisionHistory({ projectId, chapterId, onClose }: { projectId: string; chapterId: string; onClose: () => void }) {
  const [items, setItems] = useState<ChapterRevisionSummaryV04[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    listChapterRevisions(projectId, chapterId)
      .then((page) => alive && setItems(page.items))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : '历史版本读取失败。'))
    return () => {
      alive = false
    }
  }, [projectId, chapterId])
  return (
    <Dialog title="历史版本" label="历史版本" onClose={onClose} footnote="每次保存都生成新版本；旧版本保留在服务器，不会被覆盖。">
      {error && <p role="alert">{error}</p>}
      {!items && !error && <p>正在读取…</p>}
      {items && items.length === 0 && <p>还没有保存过的版本。</p>}
      <ol className="max-h-80 space-y-1 overflow-auto">
        {[...(items ?? [])].reverse().map((r, i) => (
          <li key={r.revisionId ?? i} className="flex items-baseline gap-3 text-ui-sm">
            <time className="tabular-nums text-ink">{r.createdAt ? new Date(r.createdAt).toLocaleString('zh-CN') : '初始版本'}</time>
            <span className="text-ink-3">{r.wordCount ?? 0} 字</span>
            <span className="text-micro text-ink-4">{r.createdBy?.type === 'author' ? '作者' : r.createdBy?.type ?? ''}</span>
            {i === 0 && <span className="text-micro text-ok">当前</span>}
          </li>
        ))}
      </ol>
    </Dialog>
  )
}
