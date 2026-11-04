import { useEffect, useRef, useState } from 'react'
import { Btn } from '../../components/vnext/ui'
import { proceduralMemoryApi as api, type MemoryOutcome } from '../../services/api/proceduralMemoryApi'
import { ApiProblemError } from '../../services/writerAgent'

const kinds: Record<string, string> = { knowledge_observation: '知识观察', review_finding: '审查发现', creative_proposal: '创作提案', plan_assessment: '计划核对' }
const statuses: Record<string, string> = { current: '当前有效', proposed: '待确认', accepted: '已接受', rejected: '已拒绝', superseded: '已替代', expired: '已过期', stale: '来源或版本已变化', disputed: '作者提出异议', open: '待决定', decided: '已决定' }
const epistemics: Record<string, string> = { observation: '原文观察', inference: '推断', claim: '角色陈述', author_decision: '作者决定', author_hypothesis: '作者假设', author_question: '作者问题', author_rejection: '作者否定', ai_suggestion: '助手建议', fulfilled: '原文符合计划', diverged: '原文与计划不同', not_yet: '尚未写到', unclear: '证据不明确' }
const feedback: Record<string, string> = { useful: '作者认为有帮助', false_positive: '作者标记误报', intentional: '作者确认是有意安排', update_plan: '作者选择调整计划', adjust_future: '作者选择调整后续情节', dismiss: '作者选择不处理', ignored: '作者选择忽略', accept: '作者接受', accept_edited: '作者修改后接受', reject: '作者拒绝' }
export default function MemoryOutcomePreview({ bookId, taskId }: { bookId: string; taskId: string }) {
  const [outcome, setOutcome] = useState<MemoryOutcome | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort() }, [bookId, taskId])
  async function open() {
    request.current?.abort()
    if (outcome) { setOutcome(null); return }
    const controller = new AbortController()
    request.current = controller
    setLoading(true); setError('')
    try {
      const result = await api.outcome(bookId, taskId, controller.signal)
      if (!controller.signal.aborted) setOutcome(result)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof ApiProblemError && (error.status === 404 || error.status === 410) ? '来源或结果记录已不可用。' : '暂时无法读取结果，请重试。')
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }
  return <div className="space-y-2">
    <Btn disabled={loading} onClick={() => void open()}>{loading ? '正在读取结果…' : outcome ? '收起关联结果' : '查看关联结果'}</Btn>
    {error && <p role="alert" className="text-warn">{error}</p>}
    {outcome && <div role="region" aria-label="任务关联结果" className="space-y-3 border-t border-line-soft pt-3">
      <p className="text-ink-3">{outcome.basis === 'revision_observations' ? '与该原文版本关联的知识观察。' : '该任务的业务结果与当前审核状态。'}</p>
      {outcome.items.length === 0 && <p className="text-ink-3">未保留可展示的关联结果。</p>}
      {outcome.items.map(item => <div key={item.id} className="space-y-1">
        <p className="text-ink-3">{kinds[item.kind]} · {statuses[item.status] ?? '待核对'}</p>
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
        {item.epistemic && <p className="text-ink-3">{epistemics[item.epistemic] ?? '待核对'}</p>}
        {item.feedback && <p className="text-ink-2">{feedback[item.feedback] ?? '作者已作出反馈'}</p>}
      </div>)}
      {outcome.truncated && <p role="status" className="text-ink-3">结果较多或较长，此处仅显示部分内容。</p>}
    </div>}
  </div>
}
