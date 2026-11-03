import { useRef, useState } from 'react'
import type { CreativeContent, StoryChangeReceipt, ThinkingMessage } from '@writer-agent/contracts'
import { Btn, Icon, type IconName } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import { ApiProblemError } from '../../services/writerAgent'
import { creativeError, kindLabels, questionStatusLabels } from './labels'

type Change = StoryChangeReceipt['changes'][number]
const noChapterTitles: ReadonlyMap<string, string> = new Map()
const groups = [['add', '新增'], ['set', '修改'], ['explore', '备选 · 不是作品事实'], ['reject', '不再考虑'], ['defer', '以后再说'], ['other', '问题与方向']] as const
const contentOf = (change: Change, before: boolean): CreativeContent | undefined => before ? change.before ?? change.proposalBefore?.result ?? change.proposalBefore?.draft : change.after ?? change.proposalAfter?.result ?? change.proposalAfter?.draft
const kindOf = (change: Change) => change.after?.kind ?? change.before?.kind ?? change.proposalAfter?.kind ?? change.proposalBefore?.kind
function groupOf(change: Change) {
  if (change.intent !== 'decide') return change.intent
  if (kindOf(change) === 'open_question' || kindOf(change) === 'story_intent') return 'other'
  return contentOf(change, true) ? 'set' : 'add'
}
function rows(before: CreativeContent | undefined, after: CreativeContent | undefined, chapterTitles: ReadonlyMap<string, string>) {
  const values = (value?: CreativeContent): Record<string, string> => ({ 名称: value?.name ?? '', 概述: value?.summary ?? '', 别名: value?.aliases.join('、') ?? '', ...Object.fromEntries(value?.fields.map((f) => [f.key, f.value]) ?? []), ...(value?.questionStatus ? { 问题状态: questionStatusLabels[value.questionStatus] } : {}), ...(value?.plan?.chapterId ? { 计划章节: value.plan.chapterId } : {}), ...(value?.plan?.payoffChapterId ? { 回收章节: value.plan.payoffChapterId } : {}) })
  const b = values(before), a = values(after)
  const display = (key: string, value: string) => value && (key === '计划章节' || key === '回收章节') ? chapterTitles.get(value) ?? '已删除章节' : value
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((key) => b[key] !== a[key]).map((key) => ({ key, before: display(key, b[key]), after: display(key, a[key]) }))
}
function ChangeLine({ change, applied, onAsset, chapterTitles }: { change: Change; applied: boolean; onAsset: (id: string) => void; chapterTitles: ReadonlyMap<string, string> }) {
  const before = contentOf(change, true), after = contentOf(change, false)
  const kind = kindOf(change)
  const differences = rows(before, after, chapterTitles).filter((row) => row.key !== '名称' || !!before)
  return <li className="min-w-0 py-1 text-ui-sm leading-relaxed break-words text-ink-2">
    {kind && <span className="text-ink-3">{kindLabels[kind]} · </span>}
    {change.assetId && (applied || change.before) ? <Btn variant="link" className="text-ui-sm font-medium text-ink" onClick={() => onAsset(change.assetId!)}>{change.name}</Btn> : <span className={`font-medium ${change.intent === 'reject' ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink'}`}>{change.name}</span>}
    {differences.map((row) => <div key={row.key} className="mt-0.5"><span className="text-ink-3">{row.key}：</span>{row.before && <><del className="text-ink-3 decoration-ink-4">{row.before}</del><span aria-hidden className="mx-1 text-ink-4">→</span><span className="sr-only">改为</span></>}<ins className="rounded-sm bg-ok-soft px-0.5 text-ink no-underline">{row.after || '（移除）'}</ins></div>)}
  </li>
}

export function StoryReceipt({ bookId, receipt, onChanged, onReread, onAsset, onStory, chapterTitles = noChapterTitles }: { bookId: string; receipt: StoryChangeReceipt; onChanged: (receipt: StoryChangeReceipt) => void; onReread: () => void; onAsset: (id: string) => void; onStory: () => void; chapterTitles?: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'apply' | 'undo' | 'read' | null>(null)
  const [error, setError] = useState('')
  const [unknown, setUnknown] = useState(false)
  const [conflict, setConflict] = useState(false)
  const keys = useRef<Partial<Record<'apply' | 'undo', string>>>({})
  const change = async (action: 'apply' | 'undo') => {
    if (busy) return
    keys.current[action] ??= crypto.randomUUID()
    setBusy(action); setError('')
    try {
      const updated = action === 'undo' ? await creativeApi.undoChange(bookId, receipt.changeId, keys.current[action]!) : await creativeApi.applyChange(bookId, receipt.changeId, keys.current[action]!)
      keys.current = {}; onChanged(updated)
    } catch (e) {
      setOpen(true)
      if (e instanceof ApiProblemError && e.status < 500) { setError(creativeError(e)); setConflict(['STORY_UNDO_CONFLICT', 'STORY_APPLY_CONFLICT', 'STORY_CHANGE_CONFLICT', 'STORY_SOURCE_DELETED'].includes(e.code)) }
      else { setUnknown(true); setError('操作结果尚未确认，请重新读取故事记录。') }
    } finally { setBusy(null) }
  }
  const reread = async () => {
    setBusy('read'); setError('')
    try {
      const list = await creativeApi.changes(bookId, receipt.sessionId)
      const updated = list.items.find((item) => item.changeId === receipt.changeId)
      if (updated) { onChanged(updated); setUnknown(false); setConflict(false) }
      else setError('尚未找到这次记录，请稍后重新读取。')
      onReread()
    } catch (e) { setError(creativeError(e)) } finally { setBusy(null) }
  }
  const n = receipt.changes.length
  const undoable = receipt.status === 'applied' && receipt.undoable !== false && !conflict
  const superseded = conflict || (receipt.status === 'applied' && !undoable)
  const icon: IconName = busy ? 'refresh' : unknown ? 'alert' : receipt.status === 'offered' ? 'pause' : receipt.status === 'undone' ? 'undo' : 'check'
  const label = busy === 'read' ? '正在重新读取，确认记录状态…' : busy === 'undo' ? '正在撤销…' : busy === 'apply' ? `正在记下 ${n} 项变化…` : unknown ? '不确定这些变化是否已记下' : receipt.status === 'offered' ? `有 ${n} 项变化可以记下` : receipt.status === 'undone' ? `已撤销 ${n} 项变化` : `已记下 ${n} 项变化`
  const firstAsset = receipt.changes.find((item) => item.assetId && (receipt.status === 'applied' || item.before))?.assetId
  const actionClass = 'text-ui-sm text-ink-2 max-md:min-h-11'
  const action = (label: string, run: () => void) => <><span aria-hidden className="text-ink-4">·</span><Btn variant="link" className={actionClass} onClick={run}>{label}</Btn></>
  return <section aria-label="本轮故事记录" className="mt-1.5 flex w-full max-w-5/6 flex-col items-end">
    <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-ui-sm"><Icon name={icon} className={`h-3 w-3 ${unknown ? 'text-warn' : 'text-ink-3'}`} /><span className="text-ink-3">{label}</span>{!busy && <>
      {action(open ? '收起' : '查看', () => setOpen(!open))}
      {unknown ? action('重新读取', () => void reread()) : !conflict && <>{undoable && action('撤销', () => void change('undo'))}{receipt.status === 'offered' && action('记下', () => void change('apply'))}{receipt.status === 'undone' && action('重新记下', () => void change('apply'))}</>}
    </>}</div>
    {open && !busy && <div className="fade mt-2 w-full rounded-lg border border-line-soft bg-surface px-3.5 py-3 text-left">
      {groups.map(([group, name]) => { const list = receipt.changes.filter((item) => groupOf(item) === group); return list.length > 0 && <section key={group} className="mb-2 last:mb-0"><h4 className="text-micro font-medium text-ink-3">{name}</h4><ul className="divide-y divide-line-soft">{list.map((item, index) => <ChangeLine key={index} change={item} applied={receipt.status === 'applied'} onAsset={onAsset} chapterTitles={chapterTitles} />)}</ul></section> })}
      <div className="mt-2 border-t border-line-soft pt-2 text-ui-sm text-ink-3">
        {error && <p role="alert" className="mb-1 text-warn">{error}</p>}
        {superseded && <p>{receipt.status === 'applied' ? '这条设定后来有了新的修改，无法直接撤销。' : '请对照当前故事，决定接下来如何调整。'}<Btn variant="link" className="ml-1 text-ui-sm max-md:min-h-11" onClick={() => firstAsset ? onAsset(firstAsset) : onStory()}>查看当前状态</Btn></p>}
        {!unknown && undoable && <p>撤销会恢复这条消息之前的内容；新建的设定会被移除。</p>}
        {!unknown && receipt.status === 'offered' && <p>这 {n} 项变化还没有写进故事，点“记下”会一起保存。</p>}
        {!unknown && receipt.status === 'undone' && <p>已恢复到记录之前的状态。</p>}
        {unknown && <p>请求没有收到确认，可能已经写入。重新读取后再决定下一步。</p>}
        {!superseded && <Btn variant="link" className="mt-1 text-ui-sm max-md:min-h-11" onClick={onStory}>在当前故事中查看</Btn>}
      </div>
    </div>}
  </section>
}

export function StoryRecordingStatus({ status, onRead, onRetry, onContinue }: { status: NonNullable<ThinkingMessage['storyRecording']>; onRead: () => void; onRetry?: () => void; onContinue?: () => void }) {
  const saving = status.status === 'saving'
  const failed = status.status === 'failed'
  const label = saving ? `正在记下 ${status.changeCount} 项变化…` : failed ? `没能记下 ${status.changeCount} 项变化` : '需要重新读取，确认这些变化是否已记下'
  return <div role="status" className={`mt-1.5 flex max-w-5/6 flex-wrap items-center justify-end gap-2 text-ui-sm ${failed ? 'text-danger' : 'text-ink-3'}`}><Icon name={saving ? 'dot' : 'alert'} className="h-3 w-3" /><span>{label}</span>{!saving && <Btn variant="link" className="text-ui-sm max-md:min-h-11" onClick={onRead}>重新读取</Btn>}{failed && onRetry ? <Btn variant="link" className="text-ui-sm max-md:min-h-11" onClick={onRetry}>继续处理并回复</Btn> : !saving && onContinue && <Btn variant="link" className="text-ui-sm max-md:min-h-11" onClick={onContinue}>{failed ? '调整后继续讨论' : '继续讨论这次记录'}</Btn>}</div>
}
