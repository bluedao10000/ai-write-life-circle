import type { MemoryView } from '@writer-agent/contracts'
import { Btn, Dot } from '../../components/vnext/ui'
import { backfillProgress } from './KnowledgeStatus'

type Tone = 'quiet' | 'ai' | 'warn' | 'danger' | 'ok'

/** Pure so it can be tested without rendering: what the chip says and how it is coloured. */
export function chipState(view: MemoryView): { text: string; tone: Tone } {
  if (!view.settings.enabled) return { text: '未开启', tone: 'quiet' }
  if (view.settings.paused) return { text: '已暂停', tone: 'warn' }
  if (view.workerStatus && view.workerStatus !== 'online' && (view.pending > 0 || view.running > 0))
    return { text: '离线', tone: 'warn' }
  if (view.failed > 0) return { text: '有失败', tone: 'danger' }
  if (view.running > 0 || view.pending > 0) {
    const progress = backfillProgress(view)
    return { text: progress ? `${progress.percent}%` : '整理中', tone: 'ai' }
  }
  return { text: '已同步', tone: 'ok' }
}

export default function KnowledgeChip({
  view,
  onOpen,
}: {
  view: MemoryView
  onOpen: () => void
}) {
  const state = chipState(view)
  return (
    <Btn
      size="sm"
      onClick={onOpen}
      title="作品知识维护"
      ariaLabel={`知识维护：${state.text}`}
    >
      <Dot tone={state.tone} />
      <span className="hidden lg:inline">知识</span>
      <span className="font-mono-num hidden text-ink-3 sm:inline">{state.text}</span>
    </Btn>
  )
}
