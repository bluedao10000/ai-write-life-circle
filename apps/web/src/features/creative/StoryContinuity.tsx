import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CreativeAsset, CreativeProposal, DiscussionFocus, StoryChangeReceipt, StoryContext, ThinkingMessage } from '@writer-agent/contracts'
import { Btn, Icon, IconBtn, Row, Skeleton, TextArea, type IconName } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import { creativeError, kindLabels } from './labels'
import { Disclosure } from './kit'
export { StoryReceipt, StoryRecordingStatus } from './StoryReceipt'

export const STORY_STARTERS: { icon: IconName; label: string; fill: string }[] = [
  { icon: 'users', label: '一个人物', fill: '主角叫' },
  { icon: 'flag', label: '一个冲突', fill: '故事的核心冲突是：' },
  { icon: 'think', label: '一句故事想法', fill: '故事概念：' },
]
function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <section className="border-b border-line-soft px-5 py-4 last:border-b-0"><div className="mb-2 flex items-center gap-2"><h3 className="text-micro font-medium tracking-wide text-ink-3">{title}</h3>{count !== undefined && <span className="tabular-nums text-micro text-ink-4">{count}</span>}</div>{children}</section>
}
function Acts({ children }: { children: ReactNode }) { return <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">{children}</div> }
function Act({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <Btn variant="link" className="text-ui-sm text-ink-3 max-md:min-h-11" onClick={onClick}>{children}</Btn> }
function Here() { return <span className="shrink-0 rounded-sm bg-surface-2 px-1 text-micro text-ink-3">本次</span> }

export function StoryDrawer(p: {
  mode: 'dock' | 'drawer' | 'sheet'
  bookId: string
  workTitle: string
  sessionId?: string
  messages: ThinkingMessage[]
  receipts: StoryChangeReceipt[]
  context: StoryContext | null
  error: string
  unknown: boolean
  recording: boolean
  recordingBusy: boolean
  organized: number
  covered?: boolean
  onRecording: (value: boolean) => void
  onRead: () => void
  onClose: () => void
  onFill: (text: string) => void
  onAsset: (id: string) => void
  onMessage: (sessionId: string, messageId: string) => void
  onReview: () => void
  onBook: () => void
  onFocusSaved: (focus: DiscussionFocus) => void
}) {
  const { context, messages, sessionId, onClose } = p
  const [all, setAll] = useState(false)
  const [assets, setAssets] = useState<CreativeAsset[] | null>(null)
  const [assetError, setAssetError] = useState('')
  const [assetTick, setAssetTick] = useState(0)
  const [edit, setEdit] = useState<'goal' | 'next' | null>(null)
  const [text, setText] = useState('')
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const saveKey = useRef<{ input: string; key: string } | null>(null)
  const active = useRef(true)
  const panelRef = useRef<HTMLElement>(null)
  const covered = useRef(p.covered)
  covered.current = p.covered
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    if (p.mode === 'dock') return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    panel?.querySelector<HTMLElement>('[aria-label="关闭当前故事"]')?.focus()
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || covered.current) return
      const items = [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])]
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', onTab)
    return () => { window.removeEventListener('keydown', onTab); if (previous?.isConnected) previous.focus() }
  }, [p.mode])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || covered.current) return
      if (edit) setEdit(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [edit, onClose])
  useEffect(() => {
    if (!all) return
    const abort = new AbortController()
    setAssetError(''); setAssets(null)
    void (async () => {
      try {
        const items: CreativeAsset[] = []
        let cursor: number | undefined
        do {
          const page = await creativeApi.assets(p.bookId, { status: 'accepted', limit: 100, ...(cursor !== undefined ? { cursor } : {}) }, abort.signal)
          if (abort.signal.aborted) return
          items.push(...page.items.filter((item) => item.kind !== 'story_intent' && item.kind !== 'open_question'))
          cursor = page.nextCursor ?? undefined
        } while (cursor !== undefined)
        setAssets(items)
      } catch (error) { if (!abort.signal.aborted) setAssetError(creativeError(error)) }
    })()
    return () => abort.abort()
  }, [all, p.bookId, context?.stateVersion, assetTick])
  const focus = context?.focus
  const authored = messages.some((message) => message.role === 'user')
  const saveEdit = async () => {
    if (!sessionId || !edit || saving) return
    const input = { sessionId, goal: edit === 'goal' ? text.trim() : focus?.goal ?? '', assetIds: focus?.assetIds ?? [], questionIds: focus?.questionIds ?? [], suggestedNextStep: edit === 'next' ? text.trim() : focus?.suggestedNextStep ?? '', baseVersion: focus?.version ?? 0 }
    const serialized = JSON.stringify(input)
    if (saveKey.current?.input !== serialized) saveKey.current = { input: serialized, key: crypto.randomUUID() }
    setSaving(true); setEditError('')
    try {
      const saved = await creativeApi.saveDiscussionFocus(p.bookId, input, saveKey.current.key)
      if (active.current) { p.onFocusSaved(saved); setEdit(null); saveKey.current = null }
    } catch (error) { if (active.current) setEditError(creativeError(error)) }
    finally { if (active.current) setSaving(false) }
  }
  const editor = (label: string) => <div className="mt-1"><TextArea label={label} value={text} onChange={setText} rows={2} maxLength={500} autoFocus onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void saveEdit() } }} /><div className="mt-1.5 flex gap-1"><Btn size="sm" variant="primary" disabled={saving} onClick={() => void saveEdit()} className="max-md:min-h-11">{saving ? '保存中…' : '保存'}</Btn><Btn size="sm" disabled={saving} onClick={() => setEdit(null)} className="max-md:min-h-11">取消</Btn></div>{editError && <p role="alert" className="mt-1 text-ui-sm text-warn">{editError}</p>}</div>
  const startEdit = (field: 'goal' | 'next') => { setEdit(field); setEditError(''); setText(field === 'goal' ? focus?.goal ?? '' : focus?.suggestedNextStep ?? '') }
  const starters = <div className="mt-2 flex flex-wrap gap-1.5">{STORY_STARTERS.map((starter) => <Btn key={starter.label} size="sm" variant="outline" onClick={() => p.onFill(starter.fill)} className="rounded-full text-ink-2 max-md:min-h-11"><Icon name={starter.icon} className="h-3.5 w-3.5 text-ink-3" />{starter.label}</Btn>)}</div>
  const hereIds = new Set(p.receipts.flatMap((receipt) => receipt.changes.flatMap((item) => [item.assetId, item.proposalId].filter(Boolean))))
  const rel = context?.confirmed ?? []
  const adopted = rel.filter((item) => item.kind === 'plot_line')
  const shown = all ? assets ?? [] : rel.slice(0, 4)
  const asset = (item: CreativeAsset) => <li key={item.assetId} className="py-2"><div className="flex items-start gap-2"><Btn variant="link" className="text-left text-ui font-medium text-ink" onClick={() => p.onAsset(item.assetId)}>{item.name}</Btn><span className="mt-0.5 shrink-0 text-micro text-ink-3">{kindLabels[item.kind]}</span>{hereIds.has(item.assetId) && <Here />}</div>{item.summary && <p className="mt-0.5 line-clamp-2 text-ui-sm break-words text-ink-2">{item.summary}</p>}<Acts><Act onClick={() => p.onFill(`继续聊${item.name}`)}>继续讨论</Act><Act onClick={() => p.onFill(`关于「${item.name}」，我想调整：`)}>调整这条设定</Act></Acts></li>
  const option = (item: CreativeProposal, rejected: boolean) => {
    const name = item.result?.name ?? item.draft?.name ?? item.targetName ?? '这个方向'
    return <li key={item.proposalId} className="py-2"><div className="flex items-start gap-2"><span className={`min-w-0 flex-1 text-ui break-words ${rejected ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink'}`}>{name}</span>{hereIds.has(item.proposalId) && <Here />}</div>{item.result?.summary && <p className="mt-0.5 text-ui-sm text-ink-3">{item.result.summary}</p>}<Acts>{rejected ? <Act onClick={() => p.onFill(`重新考虑「${name}」这个方向。`)}>重新考虑</Act> : <><Act onClick={() => p.onFill(`就用「${name}」这个方向。`)}>采用</Act><Act onClick={() => p.onFill(`不要「${name}」这条线。`)}>放弃</Act><Act onClick={() => p.onFill(`接着聊「${name}」：`)}>继续讨论</Act></>}</Acts></li>
  }
  const questions = context?.questions ?? []
  const pending = questions.filter((item) => !item.questionStatus || item.questionStatus === 'pending')
  const deferred = questions.filter((item) => item.questionStatus === 'deferred')
  const resolved = questions.filter((item) => item.questionStatus === 'resolved')
  const question = (item: CreativeAsset) => <li key={item.assetId} className="py-2"><div className="flex items-start gap-2"><span className="min-w-0 flex-1 text-ui break-words text-ink">{item.name}</span>{hereIds.has(item.assetId) && <Here />}</div>{item.summary && <p className="mt-0.5 text-ui-sm text-ink-2">{item.summary}</p>}<Acts>{item.questionStatus === 'resolved' ? <Act onClick={() => p.onFill(`「${item.name}」的答案：`)}>修改答案</Act> : item.questionStatus === 'deferred' ? <Act onClick={() => p.onFill(`继续聊「${item.name}」`)}>继续讨论</Act> : <><Act onClick={() => p.onFill(`「${item.name}」的答案：`)}>回答</Act><Act onClick={() => p.onFill(`「${item.name}」以后再说。`)}>以后再说</Act></>}</Acts></li>
  const panel = <>
    <div className="flex shrink-0 items-center gap-1 border-b border-line-soft py-2 pr-2 pl-5"><div className="min-w-0 flex-1"><h2 className="text-ui font-medium text-ink">当前故事</h2><div className="truncate text-micro text-ink-3">{p.workTitle}</div></div><IconBtn icon="refresh" label="重新读取当前故事" onClick={p.onRead} className="max-md:min-h-11 max-md:min-w-11" /><IconBtn icon="x" label="关闭当前故事" onClick={p.onClose} className="max-md:min-h-11 max-md:min-w-11" /></div>
    <div className="shrink-0 border-b border-line-soft px-3 py-1.5"><button type="button" role="switch" aria-checked={p.recording} aria-label="随聊记录设定" disabled={p.recordingBusy || !context} onClick={() => p.onRecording(!p.recording)} className="btn flex min-h-9 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left disabled:opacity-40 max-md:min-h-11"><span aria-hidden className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${p.recording ? 'bg-ok' : 'bg-line'}`}><span className={`absolute left-0.5 h-3 w-3 rounded-full bg-page shadow-soft transition-transform ${p.recording ? 'translate-x-3' : ''}`} /></span><span className="text-ui text-ink">随聊记录设定</span><span className="ml-auto text-micro text-ink-3">{p.recording ? '记录中' : '已暂停'}</span></button>{!p.recording && <p className="px-2 pb-1.5 text-ui-sm text-ink-3">已有设定和记录都保留。开启后可读取本作品设定，明确的决定会随聊记下；关闭时可在原话下手动记下。</p>}</div>
    <div className="scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-safe">
      {p.error && <div role="alert" className="m-4 rounded-lg border border-line-soft bg-warn-soft px-4 py-3 text-ui-sm text-ink-2"><p>{p.error}</p><Btn variant="link" className="mt-1 text-ui-sm" onClick={p.onRead}>重新读取</Btn></div>}
      {p.unknown && <div role="status" className="m-4 rounded-lg bg-warn-soft px-4 py-3 text-ui-sm text-ink-2">有一次保存没有收到确认，下面的内容可能不是最新的。<Btn variant="link" className="ml-1 text-ui-sm" onClick={p.onRead}>重新读取</Btn></div>}
      {!context && !p.error ? <div aria-busy="true" aria-label="正在读取当前故事" className="space-y-6 px-5 py-5"><Skeleton lines={3} /><Skeleton lines={4} /></div> : context && <>
        <Section title="故事方向">{context.intent.length ? <dl className="space-y-2.5">{context.intent.map((item) => <div key={item.assetId}><dt className="flex items-center gap-2 text-micro text-ink-3">{item.name}{hereIds.has(item.assetId) && <Here />}</dt><dd className="mt-0.5 font-prose text-read break-words text-ink">{item.summary}</dd>{item.fields.map((field) => <div key={field.key} className="mt-2"><span className="text-micro text-ink-3">{field.key}</span><p className="text-ui text-ink">{field.value}</p></div>)}<Acts><Act onClick={() => p.onFill(`关于「${item.name}」，我想调整：`)}>调整</Act></Acts></div>)}</dl> : <><p className="text-ui-sm text-ink-3">还没有写下故事方向。可以从这里开始：</p>{starters}</>}</Section>
        <Section title="本次讨论">{!sessionId || (!authored && !focus) ? <><p className="text-ui-sm text-ink-3">这次想推进什么？说一个目标就好。</p>{starters}</> : <div className="space-y-3"><div><div className="text-micro text-ink-3">焦点</div>{edit === 'goal' ? editor('本次讨论的焦点') : <><p className="mt-0.5 text-ui break-words text-ink">{focus?.goal || '还没有写下这次讨论的焦点。'}</p><Acts><Act onClick={() => startEdit('goal')}>编辑焦点</Act></Acts></>}</div><div><div className="text-micro text-ink-3">下一步</div>{edit === 'next' ? editor('下一步') : focus?.suggestedNextStep ? <><p className="mt-0.5 text-ui break-words text-ink">{focus.suggestedNextStep}</p><Acts><Act onClick={() => p.onFill(`关于「${focus.suggestedNextStep!.replace(/[？?]$/, '')}」：`)}>继续讨论</Act><Act onClick={() => startEdit('next')}>改写</Act></Acts></> : <Acts><Act onClick={() => startEdit('next')}>写下一步</Act></Acts>}</div>{p.receipts.length > 0 && <div><div className="text-micro text-ink-3">这次讨论的记录</div><ul className="mt-1">{p.receipts.map((receipt) => <li key={receipt.changeId}><Row onClick={() => p.onMessage(receipt.sessionId, receipt.messageId)} className="-mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm max-md:py-2.5"><Icon name={receipt.status === 'applied' ? 'check' : receipt.status === 'undone' ? 'undo' : 'dot'} className="mt-0.5 h-3 w-3 text-ink-3" /><span className="min-w-0 flex-1"><span className="line-clamp-1 text-ink-2">{messages.find((message) => message.id === receipt.messageId)?.text || receipt.changes.map((change) => change.name).join('、')}</span><span className="text-ink-3">{{ applied: '已记下', undone: '已撤销', offered: '未记下' }[receipt.status]} · {receipt.changes.length} 项</span></span></Row></li>)}</ul></div>}{p.organized > 0 && <Btn variant="link" className="text-ui-sm max-md:min-h-11" onClick={p.onReview}><Icon name="layers" className="h-3 w-3" />本次整理 · {p.organized} 项候选</Btn>}</div>}</Section>
        <Section title="已确认设定" count={all && assets ? assets.length : rel.length}>{all && !assets && !assetError ? <Skeleton lines={3} /> : shown.length ? all ? Object.keys(kindLabels).map((kind) => { const list = shown.filter((item) => item.kind === kind); return list.length > 0 && <div key={kind} className="mb-2"><div className="pt-1 text-micro text-ink-4">{kindLabels[kind as keyof typeof kindLabels]}</div><ul className="divide-y divide-line-soft">{list.map(asset)}</ul></div> }) : <ul className="divide-y divide-line-soft">{shown.map(asset)}</ul> : <p className="text-ui-sm text-ink-3">这里还没有相关的已确认设定。</p>}{assetError && <p role="alert" className="text-ui-sm text-warn">{assetError}<Act onClick={() => setAssetTick((value) => value + 1)}>重新读取</Act></p>}<Btn variant="link" className="mt-1 text-ui-sm max-md:min-h-11" pressed={all} onClick={() => setAll(!all)}>{all ? '只看相关的' : '按类型查看全部设定'}</Btn></Section>
        <Section title="备选方向" count={context.alternatives.length + adopted.length || undefined}>{adopted.length > 0 && <ul className="divide-y divide-line-soft">{adopted.map((item) => <li key={item.assetId} className="py-2"><div className="flex items-start gap-2"><span className="min-w-0 flex-1 text-ui text-ink">{item.name}</span>{hereIds.has(item.assetId) && <Here />}</div><Acts><span className="text-ui-sm text-ok">已采纳</span><Act onClick={() => p.onFill(`不要「${item.name}」这条线。`)}>放弃</Act><Act onClick={() => p.onFill(`接着聊「${item.name}」：`)}>继续讨论</Act></Acts></li>)}</ul>}{context.alternatives.length ? <ul className="divide-y divide-line-soft">{context.alternatives.map((item) => option(item, false))}</ul> : !adopted.length && <p className="text-ui-sm text-ink-3">尚未确定的方向会放在这里，它们不是作品事实。</p>}{context.rejected.length > 0 && <Disclosure label={`已放弃 · ${context.rejected.length}`} className="mt-2"><ul className="divide-y divide-line-soft">{context.rejected.map((item) => option(item, true))}</ul></Disclosure>}</Section>
        <Section title="问题" count={pending.length + deferred.length || undefined}>{!questions.length && <p className="text-ui-sm text-ink-3">还没想好的问题会记在这里。</p>}{pending.length > 0 && <><div className="text-micro text-ink-4">待解决</div><ul className="divide-y divide-line-soft">{pending.map(question)}</ul></>}{deferred.length > 0 && <><div className="mt-2 text-micro text-ink-4">以后再说</div><ul className="divide-y divide-line-soft">{deferred.map(question)}</ul></>}{resolved.length > 0 && <Disclosure label={`已解决 · ${resolved.length}`} className="mt-2"><ul className="divide-y divide-line-soft">{resolved.map(question)}</ul></Disclosure>}</Section>
        <div className="px-5 py-4">{context.truncated && <p className="mb-2 text-ui-sm text-ink-3">这里只展示相关内容，可到设定页查看全部。</p>}<Btn variant="link" className="text-ui-sm max-md:min-h-11" onClick={p.onBook}>在「书」中查看全部设定<Icon name="chevron" className="h-3 w-3" /></Btn></div>
      </>}
    </div>
  </>
  if (p.mode === 'dock') return <aside aria-label="当前故事" className="slide-r flex w-(--container-drawer) shrink-0 flex-col border-l border-line-soft bg-paper">{panel}</aside>
  return <><div className="fade fixed inset-0 z-40 bg-scrim" aria-hidden onClick={p.onClose} />{p.mode === 'drawer' ? <aside ref={panelRef} role="dialog" aria-modal="true" aria-label="当前故事" className="slide-r fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line-soft bg-surface shadow-soft sm:max-w-drawer">{panel}</aside> : <section ref={panelRef} role="dialog" aria-modal="true" aria-label="当前故事" className="fade-up fixed inset-x-0 top-16 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-xl border-t border-line bg-surface shadow-soft"><div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" />{panel}</section>}</>
}
