import { useEffect, useRef, useState } from 'react'
import type { Session, ThinkBlock } from '../../features/vnext/model'
import type { PrototypeThinkingAgent } from '../../services/prototypeThinking'
import { Btn, Heading, Proto, Quote, TextArea } from './ui'

const STAGES = ['理解', '挑战', '启发', '结论'] as const
function stageOf(b: ThinkBlock[]) {
  if (b.some((x) => x.kind === 'conclusion')) return 3
  if (b.some((x) => x.kind === 'research')) return 2
  if (b.some((x) => x.kind === 'challenge')) return 1
  return 0
}

export default function ThinkingSession({
  session,
  seedQuote,
  wide,
  onStart,
  onBlocks,
  onConclude,
  onOpenNote,
  agent,
  composer,
  setComposer,
}: {
  agent: PrototypeThinkingAgent
  composer: { draft: string; mode: 'idle' | 'correct' | 'conclude' }
  setComposer: (value: { draft: string; mode: 'idle' | 'correct' | 'conclude' }) => void
  session: Session | null
  seedQuote?: string
  wide?: boolean
  onStart: (idea: string, quote?: string) => void
  onBlocks: (b: ThinkBlock[]) => void
  onConclude: (text: string) => Promise<string>
  onOpenNote: (id: string) => void
}) {
  const [error, setError] = useState('')
  const { draft, mode } = composer
  const setDraft = (draft: string) => setComposer({ ...composer, draft })
  const setMode = (mode: typeof composer.mode) => setComposer({ ...composer, mode })
  const { challenge, research, revise } = agent
  const [busy, setBusy] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const blocks = session?.blocks ?? []
  const stage = stageOf(blocks)
  const idea = blocks.find((b) => b.kind === 'idea') as
    | Extract<ThinkBlock, { kind: 'idea' }>
    | undefined
  const last = blocks[blocks.length - 1]

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [blocks.length, busy, mode])
  function run(_label: string, next: () => ThinkBlock[]) {
    onBlocks(next())
  }

  if (!session)
    return (
      <div className={`fade ${wide ? 'mx-auto max-w-page py-10' : 'px-5 py-2'}`}>
        <p className="text-ui text-ink-2">
          把一个想法说出来。AI
          会先复述它的理解，等你纠正；然后提出挑战，介绍别的作品如何处理类似问题。
          <span className="text-ink">结论由你自己写。</span>
        </p>
        {seedQuote && (
          <div className="mt-4">
            <Quote label="你选中的原文">{seedQuote}</Quote>
          </div>
        )}
        <div className="mt-5 rounded-lg bg-surface p-3">
          <TextArea
            label="你的想法"
            prose
            rows={wide ? 4 : 3}
            value={draft}
            onChange={setDraft}
            autoFocus
            placeholder="我想表达的是……"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn
            variant="primary"
            disabled={!draft.trim()}
            onClick={() => {
              onStart(draft.trim(), seedQuote)
              setDraft('')
            }}
          >
            开始思考
          </Btn>
          <Btn
            size="sm"
            variant="quiet"
            onClick={() =>
              setDraft('我想让母亲的冷淡读起来不是冷漠，而是十年等待磨出来的自我保护。')
            }
          >
            用一个示例想法
          </Btn>
        </div>
        <p className="mt-6 text-micro text-ink-3">
          AI 不会为你写正文段落，也不会把讨论结果直接变成设定。
        </p>
      </div>
    )

  return (
    <div className={wide ? 'mx-auto max-w-page py-8' : 'px-5'}>
      <ol aria-label="思考进程" className="mb-6 flex items-center gap-1 text-micro">
        {STAGES.map((s, i) => (
          <li key={s} className="flex items-center gap-1">
            <span
              className={
                i === stage ? 'font-medium text-ink' : i < stage ? 'text-ink-2' : 'text-ink-3'
              }
            >
              {s}
            </span>
            {i < STAGES.length - 1 && <span className="mx-1 h-px w-4 bg-line" aria-hidden />}
          </li>
        ))}
        <span className="ml-auto">
          <Proto />
        </span>
      </ol>

      <div className="space-y-7">
        {blocks.map((b, i) => (
          <Block key={i} b={b} onOpenNote={onOpenNote} />
        ))}
        {busy && (
          <p role="status" className="flex items-center gap-2 text-ui-sm text-ink-3">
            <span className="dot h-1.5 w-1.5 rounded-full bg-ai" />
            {busy}（模拟）
          </p>
        )}
      </div>

      {!busy && stage < 3 && (
        <div className="mt-7">
          {mode === 'correct' || mode === 'conclude' ? (
            <div className="rounded-lg bg-surface p-3">
              <TextArea
                label={mode === 'correct' ? '纠正 AI 的理解' : '你的结论'}
                prose
                autoFocus
                rows={3}
                value={draft}
                onChange={setDraft}
                placeholder={
                  mode === 'correct'
                    ? '不完全是。我想说的是……'
                    : '用你自己的话，写下这次想清楚的东西。'
                }
              />
              <div className="mt-2 flex justify-end gap-2">
                <Btn
                  size="sm"
                  onClick={() => {
                    setComposer({ mode: 'idle', draft: '' })
                  }}
                >
                  取消
                </Btn>
                <Btn
                  size="sm"
                  variant="primary"
                  disabled={!draft.trim()}
                  onClick={async () => {
                    const t = draft.trim()
                    if (mode === 'correct') {
                      const prev = [...blocks]
                        .reverse()
                        .find((x) => x.kind === 'understand') as Extract<
                        ThinkBlock,
                        { kind: 'understand' }
                      >
                      setMode('idle')
                      onBlocks([...blocks, { kind: 'correct', text: t }])
                      run('正在按你的修正重新理解', () => [
                        ...blocks,
                        { kind: 'correct', text: t },
                        revise(prev, t),
                      ])
                    } else {
                      setBusy('保存笔记中')
                      try {
                        const noteId = await onConclude(t)
                        setComposer({ mode: 'idle', draft: '' })
                        onBlocks([...blocks, { kind: 'conclusion', text: t, noteId }])
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : '保存失败，结论仍保留')
                      } finally {
                        setBusy(null)
                      }
                    }
                  }}
                >
                  {mode === 'correct' ? '提交修正' : '存为创作笔记'}
                </Btn>
              </div>
              {mode === 'conclude' && (
                <p className="mt-2 text-micro text-ink-3">
                  结论会成为创作笔记，不会自动写入设定。之后可以从笔记提出定稿变更。
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {last?.kind === 'understand' && stage === 0 && (
                <>
                  <Btn
                    variant="outline"
                    onClick={() =>
                      run('正在寻找漏洞和反例', () => [...blocks, challenge(idea?.text ?? '')])
                    }
                  >
                    理解对了，挑战它
                  </Btn>
                  <Btn variant="quiet" onClick={() => setMode('correct')}>
                    不对，我来纠正
                  </Btn>
                </>
              )}
              {stage === 1 && (
                <Btn
                  variant="outline"
                  onClick={() => run('正在查找有出处的作品', () => [...blocks, research()])}
                >
                  看看别的作品怎么处理
                </Btn>
              )}
              {stage >= 1 && (
                <Btn variant="quiet" onClick={() => setMode('conclude')}>
                  写下我的结论
                </Btn>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div ref={end} className="h-10" />
    </div>
  )
}

function Block({ b, onOpenNote }: { b: ThinkBlock; onOpenNote: (id: string) => void }) {
  if (b.kind === 'idea')
    return (
      <section>
        <Heading level={3} className="mb-1.5">
          你的想法
        </Heading>
        {b.quote && (
          <div className="mb-2">
            <Quote>{b.quote}</Quote>
          </div>
        )}
        <p className="font-prose text-ui-lg text-ink">{b.text}</p>
      </section>
    )
  if (b.kind === 'correct')
    return (
      <section>
        <Heading level={3} className="mb-1.5">
          你的纠正
        </Heading>
        <p className="font-prose text-ui-lg text-ink">{b.text}</p>
      </section>
    )
  if (b.kind === 'understand')
    return (
      <section>
        <Heading level={3} className="mb-2">
          <span className="text-ai">{b.revised ? '我重新理解为' : '我理解你想表达的是'}</span>
        </Heading>
        <ul className="space-y-2">
          {b.items.map((it, i) => (
            <li
              key={i}
              className={`pl-3 text-ui ${it.inferred ? 'border-l-2 border-dashed border-ai text-ink-2' : 'border-l-2 border-ai text-ink'}`}
            >
              {it.text}
              {it.inferred && <span className="ml-1.5 text-micro text-ai">推断</span>}
            </li>
          ))}
        </ul>
      </section>
    )
  if (b.kind === 'challenge')
    return (
      <section>
        <Heading level={3} className="mb-2">
          挑战 · 不是答案
        </Heading>
        <ul className="space-y-3">
          {b.items.map((it, i) => (
            <li key={i} className="grid grid-cols-[4.5rem_1fr] gap-2 text-ui">
              <span className="text-ui-sm text-conflict">{it.tag}</span>
              <span className="text-ink">{it.text}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-1">
          {b.questions.map((q, i) => (
            <p key={i} className="font-prose text-ui-lg text-ink">
              {q}
            </p>
          ))}
        </div>
      </section>
    )
  if (b.kind === 'research')
    return (
      <section>
        <Heading level={3} className="mb-2">
          别的作品怎么处理 · 只分析机制，不提供可复制的段落
        </Heading>
        <ul className="space-y-5">
          {b.items.map((it, i) => (
            <li key={i}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ui font-medium text-ink">{it.work}</span>
                {it.verified ? (
                  <span className="text-micro text-ok">出处已核对（原型模拟）</span>
                ) : (
                  <span className="text-micro text-warn">未核验 · 请勿直接引用</span>
                )}
              </div>
              <p className="mt-1 text-ui text-ink-2">{it.mechanism}</p>
              {it.cite && (
                <div className="mt-2">
                  <Quote>{it.cite}</Quote>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    )
  return (
    <section className="rounded-lg bg-surface-2 px-4 py-3">
      <Heading level={3} className="mb-1">
        你的结论 · 已存为创作笔记
      </Heading>
      <p className="font-prose text-ui-lg text-ink">{b.text}</p>
      <Btn variant="link" className="mt-1 text-ui-sm" onClick={() => onOpenNote(b.noteId)}>
        在“书 · 笔记”中查看
      </Btn>
    </section>
  )
}
