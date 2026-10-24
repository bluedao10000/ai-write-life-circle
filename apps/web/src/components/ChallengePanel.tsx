import { useState } from 'react'
import type { ChallengeRound } from '../types'
import { Btn, DemoBadge, Empty } from './ui'

const EXAMPLE = '感知能力越强的精神体，欲望通常越低。'
const tagColor: Record<string, string> = { 逻辑漏洞: 'var(--danger)', 反例: 'var(--warn)', 不同立场: 'var(--accent)', 人物合理性: 'var(--warn)', 主题距离: 'var(--ink-2)' }

export default function ChallengePanel({ rounds, onChangeRounds, seed, onChallenge, onSave }: {
  rounds: ChallengeRound[]; onChangeRounds: (r: ChallengeRound[]) => void; seed?: string
  onChallenge: (intent: string, previousRounds: ChallengeRound[]) => Promise<ChallengeRound>
  onSave: (rounds: ChallengeRound[], conclusion: string) => void
}) {
  const [input, setInput] = useState(seed ?? (rounds.length ? '' : EXAMPLE))
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [conclusion, setConclusion] = useState('')

  const submit = async () => {
    if (!input.trim() || thinking) return
    setThinking(true)
    const text = input.trim()
    setError('')
    try {
      const round = await onChallenge(text, rounds)
      onChangeRounds([...rounds, round])
      setInput('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '推演请求失败，请重试。')
    } finally {
      setThinking(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3">
        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--ink-3)' }}>
          推演只做质疑与启发，不生成正文。<span className="ml-auto"><DemoBadge /></span>
        </div>
        {rounds.length === 0 && !thinking && <Empty title="写下一个观点、动机或冲突" desc="Agent 会先复述它的理解，再提出反对意见与开放问题。" />}
        {rounds.map((r, i) => (
          <div key={r.id} className="fade-up space-y-2.5">
            <div className="rounded-lg px-3 py-2 text-[13px]" style={{ background: 'var(--surface-2)' }}>
              <div className="mb-0.5 text-[10.5px]" style={{ color: 'var(--ink-3)' }}>作者意图 · 第 {i + 1} 轮</div>
              <span className="font-prose">{r.intent}</span>
            </div>
            <section>
              <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--ink-3)' }}>Agent 理解</div>
              {r.understanding.map((u) => (
                <div key={u.text} className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
                  <span className="mr-1 rounded px-1 text-[10px]" style={u.speculative ? { background: 'var(--warn-soft)', color: 'var(--warn)' } : { background: 'var(--surface-2)', color: 'var(--ink)' }}>{u.speculative ? '推测' : '复述'}</span>{u.text}
                </div>
              ))}
            </section>
            <section>
              <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--ink-3)' }}>批判性分析</div>
              <div className="space-y-1.5">
                {r.critique.map((c) => (
                  <div key={c.text} className="rounded-md border-l-2 py-0.5 pl-2.5 text-[12.5px] leading-relaxed" style={{ borderColor: tagColor[c.tag], color: 'var(--ink)' }}>
                    <span className="mr-1 text-[10.5px]" style={{ color: tagColor[c.tag] }}>{c.tag}</span>{c.text}
                  </div>
                ))}
              </div>
            </section>
            <section>
              <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--ink-3)' }}>创作启发</div>
              {r.questions.map((q) => (
                <button key={q} type="button" onClick={() => setInput(`关于「${q}」：`)} className="btn ghost block w-full rounded px-1.5 py-1 text-left text-[12.5px]" style={{ color: 'var(--ink-2)' }} title="点击就此继续推演">
                  ？ {q}
                </button>
              ))}
            </section>
          </div>
        ))}
        {thinking && <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--ink-3)' }}><span className="dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />正在推演…</div>}
        {error && <div role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</div>}
        {saving && (
          <div className="fade-up rounded-lg border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
            <div className="mb-1.5 text-[12px]" style={{ color: 'var(--ink-2)' }}>用你自己的话写下讨论结论（将作为候选提案，待正式确认）</div>
            <textarea autoFocus value={conclusion} onChange={(e) => setConclusion(e.target.value)} rows={3} className="font-prose w-full resize-none rounded-md border p-2 text-[13px] outline-none" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}
              placeholder="例如：低欲望是社会规训的结果，需设置一个高感知高欲望的例外人物。" />
            <div className="mt-2 flex justify-end gap-2">
              <Btn small onClick={() => setSaving(false)}>取消</Btn>
              <Btn small variant="primary" disabled={!conclusion.trim()} onClick={() => { onSave(rounds, conclusion.trim()); setSaving(false); setConclusion('') }}>保存为候选提案</Btn>
            </div>
          </div>
        )}
      </div>
      <div className="border-t p-3" style={{ borderColor: 'var(--line)' }}>
        <textarea
          value={input} onChange={(e) => setInput(e.target.value)} rows={2}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
          placeholder={rounds.length ? '回应质疑，或进一步说明…' : '输入你想表达的思想、人物动机或故事冲突'}
          className="font-prose w-full resize-none rounded-lg border px-3 py-2 text-[13px] outline-none focus:border-[var(--ink-3)]" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
        />
        <div className="mt-2 flex items-center gap-2">
          {rounds.length > 0 && <Btn small onClick={() => onChangeRounds([])}>清空</Btn>}
          {rounds.length > 0 && !saving && <Btn small variant="outline" onClick={() => setSaving(true)}>保存为提案</Btn>}
          <Btn small variant="primary" className="ml-auto" disabled={!input.trim() || thinking} onClick={submit}>{rounds.length ? '继续推演' : '开始推演'} ⌘↵</Btn>
        </div>
      </div>
    </div>
  )
}
