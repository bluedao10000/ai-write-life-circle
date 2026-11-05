import { useCallback, useEffect, useRef, useState } from 'react'
import { BOOK_NAV, type BookSection } from '../../components/vnext/BookView'
import { Btn } from '../../components/vnext/ui'
import { proceduralMemoryApi as api, type ProceduralMemory, type TaskEvidence, type MemoryDecision, type MemoryMerge, type MemorySupersede } from '../../services/api/proceduralMemoryApi'
import MemorySourcePreview from './MemorySourcePreview'
import MemoryExtraction from './MemoryExtraction'
import { ApiProblemError } from '../../services/writerAgent'

type Props = { bookId: string; bookTitle: string; demo?: boolean; onSection: (section: BookSection) => void }
const labels: Record<string, string> = { 'review.execute': '内容审查', 'knowledge.extract': '知识整理', 'creative.organize': '设定整理', 'creative.plan_check': '计划检查' }
const kindLabel = (kind: string) => labels[kind] ?? '写作任务'
const date = (value: string) => new Date(value).toLocaleString('zh-CN')
function independent(sources: TaskEvidence[]) {
  return sources.length >= 2 && sources.every(s => s.kind === sources[0].kind && s.strategyVersion === sources[0].strategyVersion) && new Set(sources.map(s => s.inputHash)).size === sources.length && new Set(sources.map(s => s.taskId)).size === sources.length
}
function failureMessage(error: unknown) {
  if (error instanceof ApiProblemError) {
    if (error.status === 409) return '这条经验已更新，请查看最新状态后再操作。'
    if (error.status === 404 || error.status === 410) return '经验或任务来源已不可用，请刷新后查看。'
    if (error.status === 401 || error.status === 403) return '当前无法访问这部作品，请重新登录后重试。'
    if (error.code === 'MEMORY_EVIDENCE_INSUFFICIENT') return '所选来源必须是同类、同版本且输入不同的至少两个成功任务。'
    if (error.code === 'MEMORY_CONTENT_MISMATCH') return '只能合并内容完全相同的候选，请刷新后查看。'
    if (error.code === 'INVALID_MEMORY_MERGE') return '请选择最多 8 条相同候选，合并后的任务来源不能超过 8 项。'
    if (error.code === 'MEMORY_REPLACEMENT_SAME_CONTENT') return '内容相同的重复经验应使用合并，不需要替代。'
    if (error.code === 'MEMORY_NOT_CONFIRMED' || error.code === 'MEMORY_SOURCE_UNAVAILABLE') return '被替代的经验或来源已经变化，请刷新后重新选择。'
    if (error.code === 'INVALID_MEMORY_SUPERSEDE') return '请选择一条当前有效的已确认经验进行替代。'
    if (error.code === 'MEMORY_STORAGE_LIMIT') return '操作经验存储已达到上限，暂时无法保存。'
    return '操作经验暂时无法保存，请刷新后重试。'
  }
  return error instanceof Error ? error.message : '操作未完成，请重试。'
}
export default function ProceduralMemoryPanel(props: Props) { return <MemoryPanel key={props.bookId} {...props} /> }
function MemoryPanel({ bookId, bookTitle, demo, onSection }: Props) {
  const [items, setItems] = useState<ProceduralMemory[]>([])
  const [sources, setSources] = useState<TaskEvidence[]>([])
  const [content, setContent] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [replacementTargets, setReplacementTargets] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(!demo)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const alive = useRef(false)
  const request = useRef<AbortController | null>(null)
  const keys = useRef(new Map<string, string>())
  const locked = useRef(false)
  const refresh = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    try {
      const [records, evidence] = await Promise.all([api.list(bookId, controller.signal), api.evidence(bookId, controller.signal)])
      if (!controller.signal.aborted) { setItems(records); setSources(evidence) }
    } catch (error) { if (!controller.signal.aborted) throw error }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }, [bookId])
  useEffect(() => {
    alive.current = true
    if (!demo) void refresh().catch(e => { if (alive.current && !request.current?.signal.aborted) setError(e instanceof Error ? e.message : '暂时无法加载操作经验。') })
    return () => { alive.current = false; request.current?.abort() }
  }, [demo, refresh])
  async function mutate(id?: string, decision?: MemoryDecision, merge?: MemoryMerge, supersede?: MemorySupersede) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(''); setNotice('')
    const input = supersede ?? merge ?? decision ?? { content: content.trim(), taskIds: [...selected].sort() }
    const operation = JSON.stringify([supersede ? 'supersede' : merge ? 'merge' : 'save', id, input])
    const key = keys.current.get(operation) ?? crypto.randomUUID()
    keys.current.set(operation, key)
    try {
      if (id && supersede) await api.supersede(bookId, id, supersede, key)
      else if (id && merge) await api.merge(bookId, id, merge, key)
      else if (id && decision) await api.decide(bookId, id, decision, key)
      else await api.create(bookId, { content: content.trim(), taskIds: [...selected].sort() }, key)
      if (!alive.current) return
      keys.current.delete(operation)
      if (!id) { setContent(''); setSelected([]) }
      if (id && supersede) setReplacementTargets(current => { const next = { ...current }; delete next[id]; return next })
      setNotice(supersede ? '新经验已确认，所选旧经验已退役。' : merge ? '重复候选已合并，仍需你确认后才供 AI 参考。' : !id ? '候选已保存，确认后可供 AI 参考。' : decision?.action === 'delete' ? '经验已删除。' : decision?.action === 'confirm' ? '经验已确认。' : '经验已撤回。')
      await refresh()
    } catch (e) {
      if (!alive.current) return
      setError(failureMessage(e))
      if (e instanceof ApiProblemError && (e.status === 409 || e.status === 410)) {
        try { await refresh() } catch { if (alive.current) setError('无法刷新最新状态，请稍后重试。') }
      }
    } finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  const duplicateGroups = new Map<string, ProceduralMemory[]>()
  for (const item of items) {
    if (!item.content || item.status !== 'candidate' || item.unavailableReason === 'expired' || item.unavailableReason === 'source_unavailable') continue
    const group = duplicateGroups.get(item.content) ?? []
    group.push(item)
    duplicateGroups.set(item.content, group)
  }
  const merges = new Map<string, MemoryMerge>()
  for (const group of duplicateGroups.values()) {
    const chosen: ProceduralMemory[] = []
    const taskIds = new Set<string>()
    const extractionRuns=new Set<string>()
    for (const item of group) {
      const combined = new Set([...taskIds, ...(item.provenance ?? []).map(s => s.taskId)])
      const combinedRuns=new Set([...extractionRuns,...(item.extractions??[]).map(source=>source.runId)])
      if (combined.size > 8 || combinedRuns.size>8 || chosen.length >= 8) continue
      combinedRuns.forEach(id=>extractionRuns.add(id))
      chosen.push(item)
      combined.forEach(id => taskIds.add(id))
    }
    if (chosen.length > 1) merges.set(chosen[0].id, { baseVersion: chosen[0].version, sources: chosen.slice(1).map(item => ({ id: item.id, baseVersion: item.version })) })
  }
  const tooLong = new TextEncoder().encode(content.trim()).length > 4000
  const valid = content.trim().length > 0 && !tooLong && selected.length > 0 && selected.every(id => sources.some(s => s.taskId === id))
  const activeConfirmed = items.filter(item => item.status === 'confirmed' && item.available)
  return <section className="scroll h-full overflow-auto px-5 py-6 md:px-8" aria-label="操作经验">
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-3">
        <p className="text-ui-sm text-ink-3">{bookTitle} / 书</p>
        <select aria-label="书的分区" className="rounded border border-line-soft bg-paper p-2 md:hidden" value="experience" onChange={e => onSection(e.target.value as BookSection)}>{BOOK_NAV.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select>
        <h1 className="text-xl font-medium text-ink">操作经验</h1>
        <p className="text-ui text-ink-2">从已完成的任务中总结可复用的写作方法。经你确认后，AI 可在本作品中参考；经验不会成为正式设定。</p>
      </header>
      {demo ? <p className="text-ui text-ink-3">连接作品后，可以查看任务来源并管理操作经验。</p> : <>
        <Btn disabled={busy || loading} onClick={() => { setError(''); void refresh().catch(e => { if (alive.current) setError(e instanceof Error ? e.message : '加载失败。') }) }}>刷新</Btn>
        {loading && <p role="status">正在加载操作经验…</p>}
        {error && <p role="alert" className="text-ui text-warn">{error}</p>}
        {notice && <p role="status" className="text-ui text-ink-2">{notice}</p>}
        <form className="space-y-4 rounded-xl border border-line-soft p-4" onSubmit={e => { e.preventDefault(); if (valid && !loading) void mutate() }}>
          <h2 className="font-medium">总结经验</h2>
          <label className="block text-ui">经验内容<textarea aria-label="经验内容" className="mt-2 min-h-28 w-full rounded border border-line-soft bg-transparent p-3" value={content} disabled={busy} onChange={e => setContent(e.target.value)} /></label>
          <p className="text-ui-sm text-ink-3">请描述适用情境和有效做法。中文建议不超过 1,300 字。</p>
          {tooLong && <p role="alert" className="text-ui-sm text-warn">经验内容过长，请精简后保存。</p>}
          <fieldset disabled={busy || loading} className="space-y-2">
            <legend className="mb-2 text-ui">任务来源（最多 8 项）</legend>
            {!loading && sources.length === 0 && <p className="text-ui-sm text-ink-3">还没有可用的已完成任务。完成内容审查、知识整理或创作任务后再来总结。</p>}
            <div className="max-h-56 space-y-2 overflow-auto">{sources.map(s => <div key={s.taskId} className="space-y-1"><label className="flex items-start gap-2 text-ui-sm"><input type="checkbox" checked={selected.includes(s.taskId)} disabled={!selected.includes(s.taskId) && selected.length >= 8} onChange={e => setSelected(ids => e.target.checked ? [...ids, s.taskId] : ids.filter(id => id !== s.taskId))} /><span>{kindLabel(s.kind)} · {date(s.completedAt)}<span className="block text-micro break-all text-ink-3">任务 {s.taskId} · 方法 {s.strategyVersion}</span></span></label><MemorySourcePreview bookId={bookId} taskId={s.taskId} /></div>)}</div>
          </fieldset>
          <p className="text-ui-sm text-ink-3">显示最近 100 个已完成任务。确认经验需要同类、同版本且输入不同的至少两个成功任务。</p>
          <Btn type="submit" disabled={!valid || busy || loading}>保存候选</Btn>
        </form>
        <MemoryExtraction bookId={bookId} taskIds={selected} onSaved={refresh}/>
        <div className="space-y-4">
          {!loading && items.filter(x => x.status !== 'deleted').length === 0 && <p className="text-ui text-ink-3">还没有操作经验。</p>}
          {items.filter(x => x.status !== 'deleted').map(item => <article key={item.id} className="space-y-3 rounded-xl border border-line-soft p-4" aria-label={item.content}>
            <p className="whitespace-pre-wrap text-ui">{item.content}</p>
            {!!item.extractions?.length&&<p className="text-ui-sm text-ink-3">AI 提取 · {Array.from(new Set(item.extractions.map(source=>source.model))).join("、")}</p>}
            <p className="text-ui-sm text-ink-3">{item.available ? '已确认 · 可供 AI 参考' : item.unavailableReason === 'superseded' ? '已由新经验替代' : item.unavailableReason === 'expired' ? '已过期' : item.unavailableReason === 'source_unavailable' ? '来源已不可用' : item.status === 'rejected' ? '已撤回' : '待确认'}{item.expiresAt ? ` · 有效期至 ${date(item.expiresAt)}` : ''}</p>
            <details><summary className="cursor-pointer text-ui-sm">查看任务来源（{item.provenance?.length ?? 0}）</summary><ul className="mt-2 space-y-2 text-ui-sm text-ink-3">{item.provenance?.map(s => <li key={s.taskId}>{kindLabel(s.kind)} · {date(s.completedAt)}<br />任务 {s.taskId} · 方法 {s.strategyVersion}<MemorySourcePreview bookId={bookId} taskId={s.taskId} /></li>)}</ul></details>
            {item.status === 'candidate' && !independent(item.provenance ?? []) && <p className="text-ui-sm text-ink-3">来源尚不足以确认，需要同类、同版本且输入不同的至少两个成功任务。</p>}
            {merges.has(item.id) && <p className="text-ui-sm text-ink-3">发现 {merges.get(item.id)!.sources.length + 1} 条相同候选。合并会汇总任务来源、保留最早有效期，并撤回重复项。</p>}
            {item.status === 'candidate' && independent(item.provenance ?? []) && activeConfirmed.some(old => old.id !== item.id && old.content !== item.content) && <div className="space-y-2 rounded-lg border border-line-soft p-3">
              <label className="block text-ui-sm">替代现有经验
                <select aria-label="替代现有经验" className="mt-2 w-full rounded border border-line-soft bg-paper p-2" disabled={busy || item.unavailableReason === 'expired' || item.unavailableReason === 'source_unavailable'} value={replacementTargets[item.id] ?? ''} onChange={event => setReplacementTargets(current => ({ ...current, [item.id]: event.target.value }))}>
                  <option value="">选择一条将被退役的已确认经验</option>
                  {activeConfirmed.filter(old => old.id !== item.id && old.content !== item.content).map(old => <option key={old.id} value={old.id}>{old.content}</option>)}
                </select>
              </label>
              <p className="text-ui-sm text-ink-3">替代会同时确认新经验并退役所选旧经验；两条记录及其来源关系都会保留。</p>
              <Btn disabled={busy || !replacementTargets[item.id]} onClick={() => {
                const old = activeConfirmed.find(candidate => candidate.id === replacementTargets[item.id])
                if (old) void mutate(item.id, undefined, undefined, { baseVersion: item.version, replaces: [{ id: old.id, baseVersion: old.version }] })
              }}>替代并启用</Btn>
            </div>}
            <div className="flex flex-wrap gap-3">
              {merges.has(item.id) && <Btn disabled={busy || loading} onClick={() => void mutate(item.id, undefined, merges.get(item.id))}>合并重复候选</Btn>}
              {item.status === 'candidate' && <Btn disabled={busy || loading || !independent(item.provenance ?? []) || item.unavailableReason === 'expired' || item.unavailableReason === 'source_unavailable'} onClick={() => void mutate(item.id, { baseVersion: item.version, action: 'confirm' })}>确认经验</Btn>}
              {(item.status === 'candidate' || item.status === 'confirmed') && <Btn disabled={busy || loading} onClick={() => void mutate(item.id, { baseVersion: item.version, action: 'reject' })}>撤回</Btn>}
              <Btn disabled={busy || loading} onClick={() => void mutate(item.id, { baseVersion: item.version, action: 'delete' })}>删除</Btn>
            </div>
          </article>)}
        </div>
      </>}
    </div>
  </section>
}
