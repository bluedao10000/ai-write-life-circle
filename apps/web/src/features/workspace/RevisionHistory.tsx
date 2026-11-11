import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChapterRevisionSummaryV04 } from '@writer-agent/contracts'
import type { useWorkspaceController } from './useWorkspaceController'
import { Btn, Dialog, Icon, Seg, Skeleton } from '../../components/vnext/ui'
import StudioPage from '../management/StudioPage'
import { getChapterRevision, listChapterRevisions } from '../../services/api/chapterApi'
import { findUnsupportedMarkdown } from '../../lib/manuscriptMarkdown'
import { revisionDiff } from './revisionDiff'

const selectedText = (area: HTMLTextAreaElement) => area.value.slice(area.selectionStart, area.selectionEnd)
const dateLabel = (at?: string) => at ? new Date(at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '初始版本'
const clock = (at?: string) => at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
type Props = { workspace: ReturnType<typeof useWorkspaceController>; onClose: () => void; embedded?: boolean }
export default function RevisionHistory({ workspace, onClose, embedded = false }: Props) {
  const { projectId, current: chapterId } = workspace
  const [items, setItems] = useState<ChapterRevisionSummaryV04[]>([])
  const [cursor, setCursor] = useState<string | null>()
  const [selected, setSelected] = useState('')
  const [body, setBody] = useState<string>()
  const [selection, setSelection] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [mode, setMode] = useState<'diff' | 'plain'>('diff')
  const alive = useRef(true)
  const current = workspace.markdownByChapter[chapterId] ?? ''
  const changes = useMemo(() => body === undefined ? [] : revisionDiff(body, current), [body, current])
  const groups = useMemo(() => {
    const days = new Map<string, ChapterRevisionSummaryV04[]>()
    for (const item of items) { const day = dateLabel(item.createdAt); days.set(day, [...(days.get(day) ?? []), item]) }
    return [...days]
  }, [items])
  const selectedItem = items.find((item) => item.revisionId === selected)
  const blocked = workspace.recoveryDraft ? '请先处理本地草稿恢复。'
    : workspace.saveState.s === 'error' ? '请先处理保存失败或版本冲突。'
    : workspace.saveState.s === 'saving' ? '正在保存，请稍候。'
    : workspace.chapterLoadState && workspace.chapterLoadState.status !== 'loaded' ? '请等待当前正文读取完成。'
    : findUnsupportedMarkdown(current).length ? '当前正文处于只读保护，请先导出并处理原格式。' : ''
  useEffect(() => {
    alive.current = true
    const abort = new AbortController()
    setLoading(true); setError(''); setMessage(''); setItems([]); setCursor(null); setSelected(''); setBody(undefined)
    if (!chapterId) { setLoading(false); return () => { alive.current = false; abort.abort() } }
    listChapterRevisions(projectId, chapterId, undefined, abort.signal).then((page) => {
      if (abort.signal.aborted) return
      setItems(page.items); setCursor(page.nextCursor); setSelected(page.items[0]?.revisionId ?? '')
    }).catch(() => { if (!abort.signal.aborted) setError('历史版本读取失败，请重试。') })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { alive.current = false; abort.abort() }
  }, [projectId, chapterId, attempt])
  useEffect(() => {
    if (!selected) return
    const abort = new AbortController()
    setBody(undefined); setSelection(''); setConfirm(false); setError('')
    getChapterRevision(projectId, chapterId, selected, abort.signal).then((revision) => {
      if (!abort.signal.aborted) setBody(revision.markdown)
    }).catch(() => { if (!abort.signal.aborted) setError('历史正文读取或校验失败，请重新读取。') })
    return () => abort.abort()
  }, [selected, projectId, chapterId, attempt])
  const restore = async (operation: 'replace' | 'append') => {
    if (body === undefined || blocked || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      await workspace.restoreHistoricalText(operation === 'replace' ? body : selection, operation)
      if (alive.current) { setConfirm(false); setMessage('已保存为新版本，之前的版本仍然保留。') }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '恢复未完成。') }
    finally { if (alive.current) setBusy(false) }
  }
  const copySelection = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(selection)
      if (alive.current) setMessage('所选文字已复制。')
    } catch { if (alive.current) setError('无法访问剪贴板，请在历史正文中选择文字后手动复制。') }
  }
  const more = async () => {
    setBusy(true)
    try { const page = await listChapterRevisions(projectId, chapterId, cursor ?? undefined); if (alive.current) { setItems((old) => [...old, ...page.items]); setCursor(page.nextCursor) } }
    catch { if (alive.current) setError('更多版本读取失败，请重试。') }
    finally { if (alive.current) setBusy(false) }
  }
  const content = <>
    {error && <div role="alert" className="my-4 flex flex-wrap items-center gap-3 rounded-md bg-danger-soft p-3 text-ui-sm text-danger"><span className="flex-1">{error}</span><Btn size="sm" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>重新读取</Btn></div>}
    {message && <p role="status" className="my-4 text-ui-sm text-ok">{message}</p>}
    {loading ? <div className="py-8"><Skeleton lines={6} /></div> : !items.length && !error ? <p className="border-y border-dashed border-line py-12 text-center text-ui text-ink-3">{chapterId ? '这一章还没有可读取的历史版本。' : '先打开一章，再查看历史版本。'}</p> : <div className="mt-8 grid gap-8 md:grid-cols-[14rem_minmax(0,1fr)] lg:gap-12">
      <nav aria-label="版本" className="min-w-0">
        <label className="mb-6 block text-ui-sm text-ink-3">选择历史版本<select aria-label="选择历史版本" className="mt-2 h-9 w-full rounded-md border border-line bg-page px-2 text-ui text-ink" disabled={busy} value={selected} onChange={(event) => setSelected(event.target.value)}>{items.map((item, i) => <option key={item.revisionId} value={item.revisionId}>{dateLabel(item.createdAt)} {clock(item.createdAt)} · {item.wordCount ?? 0} 字{i === 0 ? ' · 最近保存' : ''}</option>)}</select></label>
        <div className="hidden md:block">{groups.map(([day, list]) => <div key={day} className="mb-6"><h2 className="mb-2 text-micro text-ink-3">{day}</h2><ol className="border-l border-line">{list.map((item) => <li key={item.revisionId} className="relative"><span aria-hidden className={`absolute top-4 -left-[3.5px] h-1.5 w-1.5 rounded-full ${selected === item.revisionId ? 'bg-accent' : 'bg-ink-4'}`} /><button type="button" disabled={busy} aria-current={selected === item.revisionId ? 'true' : undefined} onClick={() => setSelected(item.revisionId ?? '')} className={`btn ml-3 flex w-[calc(100%-0.75rem)] items-baseline justify-between gap-2 rounded-md px-2 py-2 text-left text-ui-sm ${selected === item.revisionId ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2'}`}><span>{clock(item.createdAt) || '初始版本'}</span><span className="text-micro text-ink-3">{item.wordCount ?? 0} 字</span></button></li>)}</ol></div>)}</div>
        {cursor && <Btn disabled={busy} onClick={() => void more()}>加载更多版本</Btn>}
      </nav>
      <article className="min-w-0">
        {selected && body === undefined && !error && <p role="status" className="py-6 text-ui text-ink-3">正在读取历史正文…</p>}
        {body !== undefined && <>
          <div className="flex flex-wrap items-center gap-3 border-b border-line-soft pb-4"><h2 className="font-prose text-h2 text-ink">{dateLabel(selectedItem?.createdAt)}</h2><span className="text-ui-sm text-ink-3">{selectedItem?.wordCount ?? 0} 字</span><div className="ml-auto"><Seg size="sm" label="显示方式" value={mode} onChange={setMode} options={[[ 'diff', '对比当前' ], [ 'plain', '只看此版本' ]]} /></div></div>
          <div className={`my-5 grid gap-5 ${mode === 'diff' ? 'lg:grid-cols-2' : ''}`}>
            <label className="text-ui-sm text-ink-3">历史版本正文<textarea aria-label="历史版本正文" readOnly value={body} className="mt-2 h-72 w-full resize-y rounded-md border border-line bg-page p-3 font-prose text-ui-lg leading-relaxed text-ink" onSelect={(event) => setSelection(selectedText(event.currentTarget))} onKeyUp={(event) => setSelection(selectedText(event.currentTarget))} onMouseUp={(event) => setSelection(selectedText(event.currentTarget))} /></label>
            {mode === 'diff' && <label className="text-ui-sm text-ink-3">当前正文{workspace.saveState.s !== 'saved' ? '（含未保存修改）' : ''}<textarea aria-label="当前正文" readOnly value={current} className="mt-2 h-72 w-full resize-y rounded-md border border-line bg-page p-3 font-prose text-ui-lg leading-relaxed text-ink" /></label>}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-line-soft pt-4"><Btn disabled={!selection || busy} onClick={() => void copySelection()}>复制所选文字</Btn><Btn disabled={!selection || busy || !!blocked} title={blocked || undefined} onClick={() => void restore('append')}>将所选片段追加到章末</Btn><Btn variant="primary" disabled={busy || current === body || !!blocked} title={blocked || undefined} onClick={() => setConfirm(true)}><Icon name="undo" />恢复整个版本</Btn></div>
          <p className="mt-3 text-ui-sm text-ink-3">{blocked || '恢复前会先保存当前修改；恢复生成新版本，不删除旧版本。'}</p>
          {confirm && <div role="group" aria-label="确认恢复" className="my-5 rounded-lg border border-line bg-surface p-4"><p className="font-prose text-read text-ink">先保存当前修改，再将这个历史版本恢复为新版本？恢复后仍能找回当前版本。</p><div className="mt-4 flex flex-wrap gap-2"><Btn variant="primary" loading={busy} disabled={!!blocked} onClick={() => void restore('replace')}>确认恢复为新版本</Btn><Btn disabled={busy} onClick={() => setConfirm(false)}>取消恢复</Btn></div></div>}
          {mode === 'diff' && <><h3 className="mt-8 text-ui-sm font-medium text-ink-2">差异：历史 → 当前</h3><p className="mt-2 text-micro text-ink-3">赭色竖线表示历史内容，绿色竖线表示当前新增；完整正文保留在上方。</p>{changes === null ? <p className="mt-4 text-ui-sm text-ink-3">章节较长，可在上方双栏查看完整正文。</p> : <div className="mt-5 space-y-4">{changes.map((change, i) => <div key={i} className={change.kind === '未变' ? 'text-ink-2' : change.kind === '删除' || change.kind === '修改前' ? 'border-l-2 border-accent bg-accent-soft/60 py-1 pr-2 pl-4 text-ink' : 'border-l-2 border-ok py-1 pl-4 text-ink-3'}><span className="text-micro">{change.kind}</span><pre className="whitespace-pre-wrap break-words font-prose text-ui-lg leading-relaxed">{change.text}</pre></div>)}</div>}</>}
        </>}
      </article>
    </div>}
  </>
  if (embedded) return <StudioPage eyebrow="历史版本" title={workspace.chapters?.find((chapter) => chapter.id === chapterId)?.title || '历史版本'} meta="已保存的正文与当前版本对照" onBack={() => { if (!busy) onClose() }}>{content}</StudioPage>
  return <Dialog title="历史版本" label="历史版本" size="xl" onClose={() => { if (!busy) onClose() }} actions={<Btn disabled={busy} onClick={onClose}>关闭</Btn>}>{content}</Dialog>
}
