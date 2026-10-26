import { useState } from 'react'
import type { ReviewType } from '@writer-agent/contracts'
import { Btn, Dialog, Icon } from '../../components/vnext/ui'
import { ConsentFacts, ConsentList, ConsentTitle } from '../../components/vnext/ConsentFacts'
import type { useReviewController } from './useReviewController'
type Props = { review: ReturnType<typeof useReviewController>; onStarted: () => void }
export function ReviewConsentDialog(props: Props) {
  return props.review.plan ? <ReviewConsentContent key={props.review.consentSessionId} {...props} /> : null
}
function ReviewConsentContent({ review, onStarted }: Props) {
  const [acceptedHash, setAcceptedHash] = useState('')
  const plan = review.plan
  if (!plan) return null
  const waiting = !!review.busy
  const toggle = (type: ReviewType) => {
    const next = review.types.includes(type) ? review.types.filter((value) => value !== type) : [...review.types, type]
    void review.prepare(next)
  }
  return <Dialog size="lg" title={<ConsentTitle>确认本次审查范围</ConsentTitle>} label="确认审查与模型数据发送" onClose={review.closePlan}
    footnote="确认后才会发送，不会修改正文"
    actions={<>
    <Btn variant="outline" disabled={review.busy === 'start'} onClick={review.closePlan}>取消</Btn>
    <Btn disabled={waiting} onClick={() => void review.prepare()}>重新预览</Btn>
    <Btn variant="primary" disabled={waiting || acceptedHash !== plan.planHash} onClick={() => void review.start().then((started) => { if (started) onStarted() })}>确认并发送审查</Btn>
  </>}>
    <div className="space-y-4">
      <fieldset className="flex flex-wrap gap-x-5 gap-y-2"><legend className="mb-2 text-ui-sm font-medium text-ink-3">审查类型</legend>
        {([['character_consistency','人物事实一致性'],['timeline_consistency','时间线一致性']] as const).map(([type,label]) => <label key={type} className="flex cursor-pointer items-center gap-2 text-ink"><input type="checkbox" className="accent-current" checked={review.types.includes(type)} disabled={waiting} onChange={() => toggle(type)} />{label}</label>)}
      </fieldset>
      <ConsentFacts rows={[
        ['模型', plan.model.model],
        ['接收方', new URL(plan.model.endpoint).hostname],
        ['执行', plan.model.execution === 'local' ? '服务器本机模型服务' : '外部模型服务'],
        ['规模', `约 ${(plan.contextBytes / 1024).toFixed(1)} KB 文本与审查指令`],
      ]} />
      <section><h3 className="text-ui-sm font-medium text-ink-3">将发送的资料</h3><p className="mt-1 text-ui-sm text-ink-3">仅审查以下实际范围，不代表已覆盖整本书。</p>
        <ul className="mt-2 divide-y divide-line-soft rounded-lg border border-line text-ui-sm">{plan.sources.map((source) => <li key={source.sourceId} className="flex items-start gap-2 px-3.5 py-2"><Icon name="check" className="mt-0.5 text-ok" /><div className="min-w-0"><div className="text-ink">{source.kind === 'target' ? '本章已保存全文' : source.kind === 'historical_chapter' ? '历史章节片段' : '已确认知识片段'}：{source.title}</div><div className="break-all text-micro text-ink-3">{source.path}</div></div></li>)}</ul>
        {(plan.excludedKnowledgeCount > 0 || plan.skippedSourceCount > 0) && <p className="mt-2 text-micro text-ink-3">{plan.excludedKnowledgeCount > 0 ? `${plan.excludedKnowledgeCount} 份状态或来源不足的知识未作为确认事实。` : ''}{plan.skippedSourceCount > 0 ? '部分历史资料超出本次范围，未覆盖整本书。' : ''}</p>}
      </section>
      <ConsentList title="不会做" kind="never" items={['修改正文、已确认的设定或发布内容', '在你不知情时更换 AI 服务']} />
      <p className="text-ui-sm">每次确认将创建新的审查记录，已有记录与反馈会保留。仅用于本次连续性审查。原文和设定由作者控制；后续正文或来源变化会使结果过期。</p>
      <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-surface-2 px-3.5 py-2.5 text-ink"><input className="mt-1 accent-current" type="checkbox" checked={acceptedHash === plan.planHash} disabled={waiting} onChange={(event) => setAcceptedHash(event.target.checked ? plan.planHash : '')} /><span>我同意将上述范围的数据发送给此模型服务进行本次审查。</span></label>
      {review.error && <p role="alert" className="text-warn">{review.error}</p>}
    </div>
  </Dialog>
}
