import { useEffect, useRef, useState } from 'react'
import type { CreativeAsset, CreativeProposal, StoryChangeReceipt, StoryContext } from '@writer-agent/contracts'
import { Btn, Icon, IconBtn } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import { assetStatusLabels, creativeError, kindLabels, questionStatusLabels } from './labels'
import { Facets } from './kit'

function AssetSnapshot({ asset }: { asset?: CreativeAsset }) {
  if (!asset) return <p className="text-ui-sm text-ink-3">无</p>
  return <div className="min-w-0 space-y-2 break-words text-ui-sm">
    <p className="font-medium text-ink">{asset.name}</p>
    <p className="text-micro text-ink-3">{asset.kind === 'open_question' ? '问题' : kindLabels[asset.kind]} · {asset.kind === 'open_question' ? `${asset.status === 'accepted' ? '' : `${assetStatusLabels[asset.status]} · `}${questionStatusLabels[asset.questionStatus ?? 'pending']}` : asset.status === 'accepted' ? '已确认' : assetStatusLabels[asset.status]}</p>
    {asset.aliases.length > 0 && <p>别名：{asset.aliases.join('、')}</p>}
    {asset.summary && <p className="whitespace-pre-wrap">{asset.summary}</p>}
    <Facets fields={asset.fields} />
    {asset.plan?.chapterId && <p>计划章节：{asset.plan.chapterId}</p>}
    {asset.plan?.payoffChapterId && <p>回收章节：{asset.plan.payoffChapterId}</p>}
  </div>
}

const intentLabels = { decide: '已记入设定', explore: '已保留为候选', reject: '已搁置', defer: '已暂缓' } as const

export function StoryReceipt({ bookId, receipt, onUndone }: { bookId: string; receipt: StoryChangeReceipt; onUndone: (receipt: StoryChangeReceipt) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const key = useRef<string | null>(null)
  const undo = async () => {
    if (busy) return
    key.current ??= crypto.randomUUID()
    setBusy(true)
    setError('')
    try {
      onUndone(await creativeApi.undoChange(bookId, receipt.changeId, key.current))
    } catch (e) {
      setError(creativeError(e))
    } finally {
      setBusy(false)
    }
  }
  return <section aria-label="本轮故事记录" className="mt-4 rounded-lg border border-line-soft px-3.5 py-3 text-ui-sm">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-ink-2">{receipt.status === 'undone' ? '已撤销这次记录' : '故事记录已保存'}</span>
      {receipt.status === 'applied' && <Btn size="sm" className="ml-auto" disabled={busy} onClick={() => void undo()}><Icon name="undo" className="h-3.5 w-3.5" />{busy ? '正在撤销…' : '撤销这次记录'}</Btn>}
    </div>
    <ul className="mt-1 space-y-1 text-ink-3">{receipt.changes.map((change, i) => <li key={i}>{intentLabels[change.intent]} · {change.name}</li>)}</ul>
    <details className="mt-2">
      <summary className="cursor-pointer text-ink-2">查看变更</summary>
      <div className="mt-3 space-y-4">{receipt.changes.map((change, i) => <div key={i}>
        <p className="mb-2 font-medium">{change.name}</p>
        {change.before || change.after ? <div className="grid grid-cols-2 gap-3">
          <div><p className="mb-2 text-micro text-ink-3">变更前</p><AssetSnapshot asset={change.before} /></div>
          <div className="border-l border-line-soft pl-3"><p className="mb-2 text-micro text-ink-3">变更后</p><AssetSnapshot asset={change.after} /></div>
        </div> : <p className="text-ink-3">{intentLabels[change.intent]}</p>}
      </div>)}</div>
    </details>
    {error && <p role="alert" className="mt-2 text-warn">{error}</p>}
  </section>
}

function StoryAssets({ title, assets }: { title: string; assets: CreativeAsset[] }) {
  if (!assets.length) return null
  return <section className="space-y-2"><h3 className="text-ui font-medium text-ink">{title}</h3><ul className="space-y-2">{assets.map((asset) => <li key={asset.assetId} className="rounded-lg border border-line-soft p-3"><AssetSnapshot asset={asset} /></li>)}</ul></section>
}

function StoryOptions({ title, proposals, onOpen }: { title: string; proposals: CreativeProposal[]; onOpen: (proposal: CreativeProposal) => void }) {
  if (!proposals.length) return null
  return <section className="space-y-2"><h3 className="text-ui font-medium text-ink">{title}</h3><ul className="space-y-2">{proposals.map((proposal) => <li key={proposal.proposalId} className="rounded-lg border border-line-soft p-3">
    <Btn variant="link" onClick={() => onOpen(proposal)}>{proposal.result?.name ?? proposal.draft?.name ?? proposal.targetName}</Btn>
    <p className="mt-1 text-ui-sm text-ink-3">{proposal.result?.summary || proposal.reason}</p>
  </li>)}</ul></section>
}

export function StoryDrawer({ context, error, recording, recordingBusy, onRecording, onClose, onProposal }: {
  context: StoryContext | null
  error: string
  recording: boolean
  recordingBusy: boolean
  onRecording: (value: boolean) => void
  onClose: () => void
  onProposal: (proposal: CreativeProposal) => void
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return <>
    <div className="fade fixed inset-0 z-50 bg-scrim" aria-hidden onClick={onClose} />
    <aside aria-label="当前故事" className="slide-r fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line-soft bg-surface shadow-soft sm:max-w-drawer">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line-soft pr-2 pl-5"><h2 className="text-ui font-medium">当前故事</h2><IconBtn icon="x" label="关闭当前故事" onClick={onClose} className="ml-auto" /></div>
      <div className="scroll min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        <div className="rounded-lg border border-line-soft bg-paper p-3">
          <label className="flex items-center gap-2 text-ui"><input type="checkbox" role="switch" aria-label="随聊记录设定" checked={recording} disabled={recordingBusy || !context} onChange={(event) => onRecording(event.target.checked)} className="accent-current" />随聊记录设定</label>
          <p className="mt-2 text-ui-sm text-ink-3">开启后，AI 可读取本作品设定，并记录你在对话中明确作出的决定；尝试中的想法保留为候选。每次记录都能查看和撤销。关闭后已有记录保留。</p>
        </div>
        {error && <p role="alert" className="text-ui-sm text-warn">{error}</p>}
        {!context && !error && <p role="status" className="text-ui-sm text-ink-3">正在读取故事…</p>}
        {context?.focus && <section className="space-y-2"><h3 className="text-ui font-medium">这次讨论</h3><p className="text-ui text-ink-2">{context.focus.goal}</p>{context.focus.suggestedNextStep && <p className="text-ui-sm text-ink-3">接下来：{context.focus.suggestedNextStep}</p>}</section>}
        {context && <>
          <StoryAssets title="作品方向" assets={context.intent} />
          <StoryAssets title="相关已定设定" assets={context.confirmed} />
          <StoryOptions title="候选方向" proposals={context.alternatives} onOpen={onProposal} />
          <StoryOptions title="已搁置的方向" proposals={context.rejected} onOpen={onProposal} />
          <StoryAssets title="待讨论与已处理的问题" assets={context.questions} />
          {context.truncated && <p className="text-ui-sm text-ink-3">这里只展示相关内容，可到设定页查看全部。</p>}
          {!context.truncated && !context.focus && !context.intent.length && !context.confirmed.length && !context.alternatives.length && !context.rejected.length && !context.questions.length && <p className="text-ui-sm text-ink-3">从一个想法开始聊，逐步确定故事方向、人物和还待解决的问题。</p>}
        </>}
      </div>
    </aside>
  </>
}
