import { useEffect, useState } from 'react'
import type { ChapterRevisionSummaryV04 } from '@writer-agent/contracts'
import { Dialog } from '../../components/vnext/ui'
import { listChapterRevisions } from '../../services/api/chapterApi'


/** Saved revision list for the current chapter (metadata only; content stays on the server). */
export function RevisionHistory({ projectId, chapterId, onClose }: { projectId: string; chapterId: string; onClose: () => void }) {
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
