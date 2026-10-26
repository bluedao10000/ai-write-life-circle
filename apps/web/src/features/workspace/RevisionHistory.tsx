import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChapterRevisionSummaryV04 } from '@writer-agent/contracts'
import type { useWorkspaceController } from './useWorkspaceController'
import { Btn, Dialog } from '../../components/vnext/ui'
import { getChapterRevision, listChapterRevisions } from '../../services/api/chapterApi'
import { revisionDiff } from './revisionDiff'

type Props = { workspace: ReturnType<typeof useWorkspaceController>; onClose: () => void }
export default function RevisionHistory({ workspace, onClose }: Props) {
  const { projectId, current: chapterId } = workspace
  const [items, setItems] = useState<ChapterRevisionSummaryV04[]>([])
  const [cursor, setCursor] = useState<string | null>()
  const [selected, setSelected] = useState('')
  const [body, setBody] = useState<string>()
  const [selection, setSelection] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const alive = useRef(true)
  const current = workspace.markdownByChapter[chapterId] ?? ''
  const changes = useMemo(() => body === undefined ? [] : revisionDiff(body, current), [body, current])
  useEffect(() => {
    alive.current = true
    const abort = new AbortController()
    listChapterRevisions(projectId, chapterId, undefined, abort.signal).then((page) => {
      if (abort.signal.aborted) return
      setItems(page.items); setCursor(page.nextCursor); setSelected(page.items[0]?.revisionId ?? '')
    }).catch(() => { if (!abort.signal.aborted) setError('历史版本读取失败，请关闭后重试。') })
    return () => { alive.current = false; abort.abort() }
  }, [projectId, chapterId])
  useEffect(() => {
    if (!selected) return
    const abort = new AbortController()
    setBody(undefined); setSelection(''); setConfirm(false); setError('')
    getChapterRevision(projectId, chapterId, selected, abort.signal).then((revision) => {
      if (!abort.signal.aborted) setBody(revision.markdown)
    }).catch(() => { if (!abort.signal.aborted) setError('历史正文读取或校验失败，请重新选择版本。') })
    return () => abort.abort()
  }, [selected, projectId, chapterId])
  const restore = async (mode: 'replace' | 'append') => {
    if (body === undefined) return
    setBusy(true); setError(''); setMessage('')
    try {
      await workspace.restoreHistoricalText(mode === 'replace' ? body : selection, mode)
      if (alive.current) { setConfirm(false); setMessage('已保存为新版本，之前的版本仍然保留。') }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '恢复未完成。') }
    finally { if (alive.current) setBusy(false) }
  }
  const more = async () => {
    setBusy(true)
    try { const page = await listChapterRevisions(projectId, chapterId, cursor ?? undefined); if (alive.current) { setItems((old) => [...old, ...page.items]); setCursor(page.nextCursor) } }
    catch { if (alive.current) setError('更多版本读取失败，请重试。') }
    finally { if (alive.current) setBusy(false) }
  }
  return <Dialog title="历史版本" label="历史版本" size="xl" onClose={() => { if (!busy) onClose() }} actions={<Btn disabled={busy} onClick={onClose}>关闭</Btn>} footnote="恢复前会先保存当前修改；恢复生成新版本，不删除旧版本。">
    {error && <p role="alert" className="text-danger">{error}</p>}
    {message && <p role="status">{message}</p>}
    <label className="block">选择历史版本<select aria-label="选择历史版本" className="my-2 w-full rounded bg-surface-2 p-2" disabled={busy} value={selected} onChange={(e) => setSelected(e.target.value)}>
      {items.map((item, i) => <option key={item.revisionId} value={item.revisionId}>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '初始版本'} · {item.wordCount ?? 0} 字{i === 0 ? ' · 最近保存' : ''}</option>)}
    </select></label>
    {cursor && <Btn disabled={busy} onClick={() => void more()}>加载更多版本</Btn>}
    {!selected && !error && <p>正在读取版本列表…</p>}
    {selected && body === undefined && !error && <p>正在读取历史正文…</p>}
    {body !== undefined && <>
      <div className="my-3 grid gap-3 md:grid-cols-2">
        <label>历史版本正文<textarea aria-label="历史版本正文" readOnly value={body} className="mt-1 h-64 w-full resize-y rounded border border-line bg-surface p-2 font-prose text-ink" onSelect={(e) => setSelection(e.currentTarget.value.slice(e.currentTarget.selectionStart, e.currentTarget.selectionEnd))} /></label>
        <label>当前正文{workspace.saveState.s !== 'saved' ? '（含未保存修改）' : ''}<textarea aria-label="当前正文" readOnly value={current} className="mt-1 h-64 w-full resize-y rounded border border-line bg-surface p-2 font-prose text-ink" /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Btn disabled={!selection || busy} onClick={() => void navigator.clipboard.writeText(selection).then(() => { if (alive.current) setMessage('所选文字已复制。') }).catch(() => { if (alive.current) setError('无法访问剪贴板，请在历史正文中选择文字后手动复制。') })}>复制所选文字</Btn>
        <Btn disabled={!selection || busy} onClick={() => void restore('append')}>将所选片段追加到章末</Btn>
        <Btn disabled={busy || current === body || workspace.recoveryDraft !== undefined} onClick={() => setConfirm(true)}>恢复整个版本</Btn>
      </div>
      {confirm && <div role="group" aria-label="确认恢复" className="my-3 rounded border border-line p-3"><p>先保存当前修改，再将这个历史版本恢复为新版本？恢复后仍能找回当前版本。</p><div className="mt-2 flex gap-2"><Btn variant="primary" disabled={busy} onClick={() => void restore('replace')}>{busy ? '正在保存…' : '确认恢复为新版本'}</Btn><Btn disabled={busy} onClick={() => setConfirm(false)}>取消恢复</Btn></div></div>}
      <h3 className="mt-5 font-medium">差异：历史 → 当前</h3>
      <p className="text-ui-sm text-ink-3">新增、删除及修改均以文字标注；原始 Markdown 保留在上方。</p>
      {changes === null ? <p>章节较长，已停止自动差异计算以保持流畅。可在上方双栏查看完整正文。</p> : <div className="mt-2 max-h-64 overflow-auto">{changes.map((change, i) => <div key={i} className={`mb-2 rounded p-2 ${change.kind === '未变' ? 'text-ink-3' : 'border border-line bg-surface-2'}`}><span className="text-micro">{change.kind}</span><pre className="whitespace-pre-wrap break-words font-prose text-ui-sm">{change.text}</pre></div>)}</div>}
    </>}
  </Dialog>
}
