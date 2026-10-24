import { useState } from 'react'
import type { Source, StoryConflict } from '../../features/vnext/model'
import { Btn, Choice, Heading, Icon, Proto, Quote } from './ui'

type Res = NonNullable<StoryConflict['resolution']>
const ACTIONS: { id: Res; label: string; means: string }[] = [
  {
    id: 'growth',
    label: '这是人物的成长或认知变化',
    means: '两处都保留。记下一条创作笔记，说明这是沈砚的认知，而不是客观事实。',
  },
  {
    id: 'edit-text',
    label: '我要修改正文',
    means: '回到编辑器的对应段落，由你自己改写。AI 不会修改正文。',
  },
  {
    id: 'edit-canon',
    label: '我要修改设定',
    means: '起草一份定稿变更，列出现有设定、变更与影响，等你确认。',
  },
  {
    id: 'intentional',
    label: '这是有意为之，忽略',
    means: '标记为刻意设计，之后不再就这一处提醒你。',
  },
]

/** 故事冲突（作品内容的矛盾）。与 409 版本冲突完全不同：这里没有数据风险，只有创作判断。 */
export default function StoryConflictView({
  conflict,
  onBack,
  onSource,
  onResolve,
}: {
  conflict: StoryConflict
  onBack: () => void
  onSource: (s: Source) => void
  onResolve: (r: Res) => void
}) {
  const [pick, setPick] = useState<Res | null>(conflict.resolution ?? null)
  return (
    <div className="fade mx-auto w-full max-w-5xl px-6 py-8 sm:px-10">
      <Btn variant="quiet" className="-ml-3" onClick={onBack}>
        <Icon name="back" />
        回到正文原位置
      </Btn>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span className="text-ui-sm text-conflict">故事冲突</span>
        <Proto>原型 · 模拟检测</Proto>
      </div>
      <Heading level={1} className="mt-1">
        {conflict.title}
      </Heading>

      <div className="mt-10 grid gap-10 md:grid-cols-2">
        {[conflict.a, conflict.b].map((s) => (
          <div key={s.label}>
            <Quote tone="conflict" label={s.label} onOpen={() => onSource(s)} state={s.state}>
              {s.quote}
            </Quote>
          </div>
        ))}
      </div>
      {conflict.extra && (
        <div className="mt-8 max-w-xl">
          <Quote label={conflict.extra.label} onOpen={() => onSource(conflict.extra!)}>
            {conflict.extra.quote}
          </Quote>
        </div>
      )}

      <section className="mt-12 max-w-2xl">
        <Heading level={3} className="mb-2">
          <span className="text-ai">AI 分析 · 推断，未经确认</span>
        </Heading>
        <p className="text-ui-lg text-ink-2">{conflict.analysis}</p>
        <div className="mt-4 text-ui-sm text-ink-3">可能的读法</div>
        <ul className="mt-1 space-y-1.5">
          {conflict.readings.map((r, i) => (
            <li key={i} className="border-l-2 border-dashed border-ai pl-3 text-ui text-ink-2">
              {r}
            </li>
          ))}
        </ul>
        <p className="mt-6 font-prose text-ui-lg text-ink">{conflict.question}</p>
      </section>

      <section className="mt-12 max-w-2xl" aria-label="作者判断">
        <Heading level={2}>你的判断</Heading>
        <div role="radiogroup" className="mt-4 space-y-1">
          {ACTIONS.map((a) => (
            <Choice
              key={a.id}
              type="radio"
              name="resolution"
              checked={pick === a.id}
              onChange={() => setPick(a.id)}
              className={`rounded-lg px-3 py-3 ${pick === a.id ? 'bg-surface' : 'hover:bg-surface-2'}`}
            >
              <span className="block text-ui text-ink">{a.label}</span>
              <span className="block text-ui-sm text-ink-3">{a.means}</span>
            </Choice>
          ))}
        </div>
        <div className="mt-6 flex gap-2">
          <Btn variant="primary" disabled={!pick} onClick={() => pick && onResolve(pick)}>
            {pick === 'edit-text' ? '去正文修改' : pick === 'edit-canon' ? '起草定稿变更' : '确定'}
          </Btn>
          <Btn variant="quiet" onClick={onBack}>
            以后再说
          </Btn>
        </div>
      </section>
    </div>
  )
}
