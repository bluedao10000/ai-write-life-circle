// 灵感 conversation pieces: reply typography, author bubble, generating and
// failure states. Visuals follow Figma Make (idea/Chat.tsx); content, status
// and recovery come only from the real ThinkingSession.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import type { ThinkingMessage, ThinkingRecovery, ThinkingRun, ThinkingSource } from '@writer-agent/contracts'
import { Btn, Icon, Quote, TextArea } from '../../components/vnext/ui'
import { thinkingError } from '../thinking/errors'
import ToolTimeline, { labelOf } from '../thinking/ToolTimeline'
import type { ToolStep } from '../thinking/toolActivity'

const md: Components = {
  blockquote: ({ children }) => (
    <div className="py-1">
      <Quote>{children}</Quote>
    </div>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="text-ink-3">{alt ? `［图片：${alt}］` : '［图片］'}</span>,
}

/** Model Markdown in the Figma Rich measure: headings, quotes, lists, emphasis; raw HTML is never rendered. */
export function Rich({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`chat-rich font-prose text-read break-words text-ink [&_p]:whitespace-pre-wrap ${streaming ? 'is-streaming' : ''}`}>
      <ReactMarkdown components={md} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** Inline [[source:ID]] markers become numbered references to verified quotes. */
export function readable(m: ThinkingMessage) {
  return m.text.replace(/\[\[source:([^\]]+)\]\]/g, (_all, id: string) => {
    const index = m.sources.findIndex((src) => src.sourceId === id)
    return index >= 0 ? `［原文 ${index + 1}］` : m.status === 'running' ? '［引文待核验］' : '［未核验引用］'
  })
}
/** Copy and 创作笔记 take plain prose without Markdown markers. */
export const plain = (t: string) => t.replace(/^#{1,6} /gm, '').replace(/^> ?/gm, '').replace(/\*\*/g, '').replace(/`/g, '')

export function AuthorMsg({ m, fresh, note }: { m: Pick<ThinkingMessage, 'text'>; fresh: boolean; note?: ReactNode }) {
  return (
    <div className={`group flex flex-col items-end ${fresh ? 'msg-in' : ''}`}>
      <div className="max-w-5/6 rounded-2xl bg-surface-2 px-4 py-2.5 text-ui-lg whitespace-pre-wrap break-words text-ink">{m.text}</div>
      {note}
    </div>
  )
}

export function Pending({ tool, steps }: { tool: string; steps: ToolStep[] }) {
  const [details, setDetails] = useState(false)
  // Only real events: a tool that is running, or discussion memory being organized.
  const label = !tool ? '正在思考…' : /[\u4e00-\u9fff]/.test(tool) ? tool.replace(/。$/, '…') : `正在参考作品资料：${labelOf(tool)}…`
  return (
    <div className="msg-in">
      <div role="status" aria-live="polite" className="flex items-center gap-3 py-1 text-ui text-ink-3">
        <span aria-hidden className="dots flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-1.5 w-1.5 rounded-full bg-ink-4" />
          ))}
        </span>
        <span key={label} className="fade">
          {label}
        </span>
      </div>
      {steps.length > 0 && (
        <div className="mt-1 -ml-2">
          <Btn size="sm" pressed={details} onClick={() => setDetails(!details)} className="text-ink-3 max-md:min-h-11">
            {details ? '收起执行详情' : '查看执行详情'}
            <Icon name="chevronDown" className={`h-3 w-3 transition-transform duration-200 ease-calm ${details ? 'rotate-180' : ''}`} />
          </Btn>
          {details && (
            <div className="fade mt-2 ml-2">
              <ToolTimeline steps={steps} activeTool={tool} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const authorize = new Set(['AUTHORIZATION_REQUIRED', 'AUTHORIZATION_REVOKED', 'SCOPE_FORBIDDEN'])

/**
 * A reply that did not finish: say so plainly, keep the question, offer the one
 * recovery the server allows. 重新尝试 resumes the same run (same message, no
 * duplicate question) and is the author's explicit consent to another paid call;
 * otherwise the question returns to the composer as a new message.
 */
export function Failure({ m, run, busy, recent, onResume, onAsk, onScopes, onNewTopic }: {
  m: ThinkingMessage
  /** The session's current run when it belongs to this reply. */
  run?: ThinkingRun
  busy: boolean
  /** Recent visible discussion, offered as editable continuation context. */
  recent: string
  onResume: (input: ThinkingRecovery) => void
  onAsk: () => void
  onScopes: () => void
  onNewTopic: () => void
}) {
  const [more, setMore] = useState(false)
  const [context, setContext] = useState<string | null>(null)
  const stopped = m.status === 'cancelled'
  const code = m.errorCode ?? (stopped ? 'CANCELLED' : 'SESSION_INTERRUPTED')
  const failure = run?.failure
  const resumable = !!run && !!failure?.retryable && run.resumable && ['failed', 'interrupted'].includes(run.status)
  const needsContext = failure?.userAction === 'provide_context'
  const title = stopped ? '已停止回复。' : m.text.trim() ? '这次回复没有完整生成，已收到的内容已保留。' : '这次回复未能完成，你的问题已保存。'
  // The code-specific explanation is the most precise; the run's category text covers unknown codes.
  const specific = thinkingError(code)
  const explanation = specific === thinkingError() && failure?.message ? failure.message : specific
  const resume = (continuationContext?: string) => onResume({ runId: run!.runId, confirmAdditionalCost: true, ...(continuationContext ? { continuationContext } : {}) })
  return (
    <div className="msg-in mt-5 border-l-2 border-line pl-4">
      <p className="text-ui text-ink-2">{title}</p>
      {!stopped && <p className="mt-1 text-ui-sm text-ink-3">{explanation}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
        {resumable && !needsContext && (
          <Btn size="sm" variant="outline" disabled={busy} onClick={() => resume()} className="max-md:min-h-11">
            <Icon name="refresh" className="h-3 w-3" />
            {run!.status === 'interrupted' ? '继续回复' : '重新尝试'}
          </Btn>
        )}
        {resumable && needsContext && context === null && (
          <Btn size="sm" variant="outline" disabled={busy} onClick={() => setContext(recent)} className="max-md:min-h-11">
            <Icon name="refresh" className="h-3 w-3" />
            带着续谈要点继续
          </Btn>
        )}
        {!resumable && (
          <Btn size="sm" variant="outline" disabled={busy} onClick={onAsk} className="max-md:min-h-11">
            <Icon name="refresh" className="h-3 w-3" />
            重新提问
          </Btn>
        )}
        {authorize.has(code) || failure?.code === 'AUTHORIZATION_REQUIRED' ? (
          <Btn size="sm" disabled={busy} onClick={onScopes} className="max-md:min-h-11">
            检查 AI 资料范围
          </Btn>
        ) : null}
        {failure?.userAction === 'new_session' && (
          <Btn size="sm" disabled={busy} onClick={onNewTopic} className="max-md:min-h-11">
            新开话题
          </Btn>
        )}
        {!stopped && (
          <Btn size="sm" pressed={more} onClick={() => setMore(!more)} className="max-md:min-h-11">
            {more ? '收起详情' : '查看详情'}
          </Btn>
        )}
      </div>
      {resumable && context !== null && (
        <div className="fade mt-3 space-y-2">
          <p className="text-ui-sm text-ink-3">讨论较长，模型会用这份要点代替较早的上下文继续；完整历史仍然保留。请保留已定事项、重要引用和尚未确定的假设。</p>
          <TextArea label="续谈要点" rows={5} value={context} onChange={setContext} maxLength={12000} className="rounded-md border border-line bg-paper px-3 py-2 text-ui" />
          <div className="flex flex-wrap gap-1">
            <Btn size="sm" variant="primary" disabled={busy || !context.trim()} onClick={() => resume(context.trim())}>
              继续回复
            </Btn>
            <Btn size="sm" onClick={() => setContext(null)}>
              取消
            </Btn>
          </div>
        </div>
      )}
      {resumable && <p className="mt-2 text-micro text-ink-3">重新尝试会再次请求原模型，按实际用量计入 AI 点数{failure?.mayHaveIncurredCost ? '；上次请求可能已计入' : ''}。</p>}
      {run && !run.resumable && !stopped && run.status !== 'completed' && <p className="mt-2 text-micro text-ink-3">这一轮已经做过的步骤不能自动重来，请先看看已有内容，再重新提问。</p>}
      {more && (
        <p className="fade mt-2 text-micro break-all text-ink-3">
          技术详情：<span className="font-mono">{code}</span>
          {run ? (
            <>
              {' '}
              · 追踪编号 <span className="font-mono">{run.traceId}</span>
            </>
          ) : null}
        </p>
      )}
    </div>
  )
}

export function Sources({ sources, onSource }: { sources: ThinkingSource[]; onSource: (s: ThinkingSource) => void }) {
  const [open, setOpen] = useState(false)
  if (!sources.length) return null
  return (
    <div className="mb-3 -ml-2">
      <Btn size="sm" pressed={open} onClick={() => setOpen(!open)} className="text-ink-3 max-md:min-h-11">
        <Icon name="book" className="h-3.5 w-3.5" />
        已参考作品中的 {sources.length} 处原文
        <Icon name="chevron" className={`h-3 w-3 transition-transform duration-200 ease-calm ${open ? 'rotate-90' : ''}`} />
      </Btn>
      {open && (
        <div className="fade mt-2 ml-2 space-y-3">
          {sources.map((src, i) => (
            <Quote
              key={src.sourceId}
              label={`［原文 ${i + 1}］${src.title} · ${src.validity === 'stale' ? '旧版本引文' : '原文位置已核验'}${src.epistemic ? ` · ${{ observation: '正文观察', claim: '角色说法', inference: 'AI 推测' }[src.epistemic]}` : ''}`}
              state={src.validity === 'stale' ? 'stale' : 'ok'}
              onOpen={() => onSource(src)}
            >
              {src.quote}
            </Quote>
          ))}
          <p className="text-micro text-ink-3">点击可跳回对应章节核对上下文。</p>
        </div>
      )}
    </div>
  )
}

export function AiMsg({ m, fresh, streaming, onSource, onNote, onCopied, organize, failure }: {
  m: ThinkingMessage
  fresh: boolean
  streaming: boolean
  onSource: (s: ThinkingSource) => void
  /** Saves the reply as an author note; absent when notes are not available. */
  onNote?: (text: string) => Promise<void>
  onCopied: (ok: boolean) => void
  organize?: ReactNode
  failure?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const [noted, setNoted] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const text = readable(m)
  const done = m.status === 'completed'
  const copy = () => {
    const value = plain(text)
    const ok = () => {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1800)
      onCopied(true)
    }
    // WebViews may forbid the Clipboard API: fall back to a hidden selection, and say so if both fail.
    const legacy = () => {
      const el = document.createElement('textarea')
      el.value = value
      el.setAttribute('readonly', '')
      el.className = 'fixed top-0 left-0 opacity-0'
      document.body.appendChild(el)
      el.select()
      let success = false
      try {
        success = document.execCommand('copy')
      } catch {
        /* reported below */
      }
      el.remove()
      if (success) ok()
      else onCopied(false)
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(ok, legacy)
    else legacy()
  }
  const act = 'text-ink-3 max-md:min-h-11'
  return (
    <article aria-label="创作伙伴的回复" className={fresh ? 'msg-in' : ''}>
      <Sources sources={m.sources} onSource={onSource} />
      {text.trim() && <Rich text={text} streaming={streaming} />}
      {failure}
      {organize}
      {done && (
        <div className="mt-4 -ml-2 flex flex-wrap items-center gap-x-0.5">
          <Btn size="sm" onClick={copy} className={act}>
            {copied && <Icon name="check" className="h-3 w-3" />}
            {copied ? '已复制' : '复制'}
          </Btn>
          {onNote && (
            <Btn
              size="sm"
              disabled={noted !== 'idle'}
              onClick={() => {
                setNoted('saving')
                void onNote(plain(text)).then(
                  () => setNoted('saved'),
                  () => setNoted('idle'),
                )
              }}
              className={act}
            >
              {noted === 'saved' && <Icon name="check" className="h-3 w-3 text-accent" />}
              {noted === 'saved' ? '已加入创作笔记' : noted === 'saving' ? '正在保存…' : '加入创作笔记'}
            </Btn>
          )}
          {m.modelLabel && <span className="ml-auto pl-2 text-micro text-ink-4">{m.modelLabel}</span>}
        </div>
      )}
    </article>
  )
}
