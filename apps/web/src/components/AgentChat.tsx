import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, Evidence } from '../types'
import { Btn, DemoBadge, Empty, EvidenceItem } from './ui'

const CMDS = [
  { c: '/review', d: '对当前章节运行连续性审查' },
  { c: '/inspire', d: '获得开放式启发问题（不生成正文）' },
  { c: '/challenge', d: '将观点带入创作推演' },
]

export default function AgentChat({ messages, selection, clearSelection, onEvidence, onCommand, onSend, onSave }: {
  messages: ChatMessage[]; selection: string; clearSelection: () => void
  onEvidence: (e: Evidence) => void; onCommand: (cmd: 'review' | 'challenge', arg: string) => void; onSave: (m: ChatMessage) => void
  onSend: (text: string, quote?: string) => Promise<void>
}) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, busy])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    if (text.startsWith('/review')) { onCommand('review', ''); setInput(''); return }
    if (text.startsWith('/challenge')) { onCommand('challenge', text.replace('/challenge', '').trim()); setInput(''); return }
    const quote = selection || undefined
    setInput('')
    clearSelection()
    setBusy(true)
    setError('')
    try {
      await onSend(text, quote)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '消息发送失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  const showCmds = input.startsWith('/') && !input.includes(' ')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3 text-[13px]">
        {messages.length === 0 && <Empty title="和 Agent 讨论你的作品" desc="选中正文后提问，Agent 会结合知识库回答并附上依据。输入 / 查看快捷指令。" />}
        {messages.map((m) =>
          m.role === 'author' ? (
            <div key={m.id} className="ml-8 rounded-lg px-3 py-2" style={{ background: 'var(--surface-2)' }}>
              {m.quote && <div className="font-prose mb-1 border-l-2 pl-2 text-[12px]" style={{ borderColor: 'var(--ink-3)', color: 'var(--ink-3)' }}>{m.quote.slice(0, 60)}{m.quote.length > 60 && '…'}</div>}
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="fade-up">
              <div className="mb-1 flex items-center gap-2 text-[11px]" style={{ color: 'var(--ink-3)' }}>Agent {m.demo && <DemoBadge />}</div>
              <div className="whitespace-pre-line leading-relaxed" style={{ color: 'var(--ink-2)' }}>{m.text}</div>
              {m.cites && <div className="mt-2 space-y-1.5">{m.cites.map((c) => <EvidenceItem key={c.label} e={c} onOpen={onEvidence} />)}</div>}
              <div className="mt-1.5">
                {m.savedAs ? <span className="text-[11px]" style={{ color: 'var(--ok)' }}>已保存为提案 {m.savedAs}</span> : <Btn small onClick={() => onSave(m)}>保存为提案</Btn>}
              </div>
            </div>
          ),
        )}
        {busy && <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--ink-3)' }}><span className="dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />正在查阅知识库…</div>}
        {error && <div role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</div>}
        <div ref={end} />
      </div>
      <div className="relative border-t p-3" style={{ borderColor: 'var(--line)' }}>
        {showCmds && (
          <div className="absolute right-3 bottom-full left-3 mb-1 rounded-lg border p-1" style={{ background: 'var(--surface)', borderColor: 'var(--line)', boxShadow: 'var(--shadow)' }}>
            {CMDS.filter((c) => c.c.startsWith(input)).map((c) => (
              <button key={c.c} type="button" onClick={() => setInput(c.c + ' ')} className="btn ghost flex w-full gap-3 rounded px-2 py-1.5 text-left text-[12.5px]">
                <span className="font-mono" style={{ color: 'var(--accent)' }}>{c.c}</span><span style={{ color: 'var(--ink-3)' }}>{c.d}</span>
              </button>
            ))}
          </div>
        )}
        {selection && (
          <div className="mb-2 flex items-center gap-2 rounded-md px-2 py-1 text-[11.5px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            <span className="min-w-0 flex-1 truncate">引用选中：{selection}</span>
            <button type="button" onClick={clearSelection} aria-label="取消引用">×</button>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          <textarea
            value={input} onChange={(e) => setInput(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
            placeholder="问问 Agent，或输入 / 调用指令"
            className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] outline-none" aria-label="发送给 Agent"
          />
          <Btn small variant="primary" disabled={!input.trim() || busy} onClick={send}>发送</Btn>
        </div>
      </div>
    </div>
  )
}
