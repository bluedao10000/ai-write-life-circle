// 灵感 conversation pieces: reply typography, author bubble, generating and
// failure states. Visuals follow Figma Make (idea/Chat.tsx); content, status
// and recovery come only from the real ThinkingSession.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import type { ThinkingAutonomyState, ThinkingMessage, ThinkingRecovery, ThinkingRun, ThinkingSource } from '@writer-agent/contracts'
import { Btn, Icon, Quote } from '../../components/vnext/ui'
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

/** Source markers become numbered references to the returned, verified quotes. */
export function readable(m: ThinkingMessage) {
  const text = m.sources.reduce((value, src, index) => value.split(`【${src.sourceId}】`).join(`［原文 ${index + 1}］`), m.text)
  return text.replace(/\[\[source:([^\]]+)\]\]/g, (_all, id: string) => {
    const index = m.sources.findIndex((src) => src.sourceId === id)
    return index >= 0 ? `［原文 ${index + 1}］` : m.status === 'running' ? '［引文待核验］' : '［未核验引用］'
  })
}
/** Copy and 创作笔记 take plain prose without Markdown markers. */
export const plain = (t: string) => t.replace(/^#{1,6} /gm, '').replace(/^> ?/gm, '').replace(/\*\*/g, '').replace(/`/g, '')

export function AutonomyStatus({ state }: { state: ThinkingAutonomyState }) {
  const label = {
    planning: '正在建立只读计划',
    planned: '计划已就绪',
    running: '正在执行计划',
    completed: '计划已完成',
    needs_input: '需要补充信息',
    failed: '计划未完成',
    cancelled: '计划已取消',
  }[state.status]
  return (
    <section aria-label="只读自主执行状态" className="mt-1.5 max-w-5/6 rounded-xl border border-line-soft bg-surface px-3 py-2.5 text-left">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm">
        <Icon name="target" className="h-3.5 w-3.5 text-ink-3" />
        <span className="font-medium text-ink">{label}</span>
        <span className="text-micro text-ink-3">最多 {state.maxSteps} 步 · 只读</span>
      </div>
      <p className="mt-1.5 text-ui-sm text-ink-2"><span className="text-ink-3">完成条件：</span>{state.completionCriteria}</p>
      {state.plan ? (
        <ol className="mt-2 space-y-1 border-l border-line-soft pl-3">
          {state.plan.steps.map((step) => (
            <li key={step.stepId} className="flex items-start gap-2 text-ui-sm text-ink-2">
              <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${step.status === 'completed' ? 'bg-ok' : step.status === 'running' ? 'bg-ai' : step.status === 'failed' ? 'bg-warn' : 'bg-ink-4'}`} />
              <span>{step.purpose}<span className="sr-only">；{step.status === 'completed' ? '已完成' : step.status === 'running' ? '进行中' : step.status === 'failed' ? '未完成' : '等待执行'}</span></span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-ui-sm text-ink-3">模型必须先提交计划，之后才能查阅作品资料。</p>
      )}
      {state.completion && (
        <div className="mt-2 border-t border-line-soft pt-2 text-ui-sm text-ink-2">
          <p>{state.completion.summary}</p>
          {state.completion.remainingSteps.length > 0 && (
            <p className="mt-1 text-ink-3">仍需补充：{state.completion.remainingSteps.map((step) => step.reason).join('；')}</p>
          )}
        </div>
      )}
    </section>
  )
}

export function AuthorMsg({ m, fresh, note }: { m: Pick<ThinkingMessage, 'text'|'autonomy'>; fresh: boolean; note?: ReactNode }) {
  return (
    <div className={`group flex flex-col items-end ${fresh ? 'msg-in' : ''}`}>
      <div className="max-w-5/6 rounded-2xl bg-surface-2 px-4 py-2.5 text-ui-lg whitespace-pre-wrap break-words text-ink">{m.text}</div>
      {m.autonomy && <AutonomyStatus state={m.autonomy} />}
      {note}
    </div>
  )
}

export function Pending({ tool, steps }: { tool: string; steps: ToolStep[] }) {
  const [details, setDetails] = useState(false)
  // Only real events: a tool that is running, or discussion memory being organized.
  const label = !tool ? '正在思考…' : /[\u4e00-\u9fff]/.test(tool) ? tool.replace(/。$/, '…') : ['offer_story_changes', 'record_story_changes', 'update_discussion_focus'].includes(tool) ? `正在${labelOf(tool)}…` : `正在参考作品资料：${labelOf(tool)}…`
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
export function Failure({ m, run, busy, recent, storySaved, onResume, onAsk, onScopes, onNewTopic, onAnalyze }: {
  m: ThinkingMessage
  /** The session's current run when it belongs to this reply. */
  run?: ThinkingRun
  busy: boolean
  /** Recent visible discussion used to resume an interrupted reply. */
  recent: string
  storySaved?: boolean
  onResume: (input: ThinkingRecovery) => void
  onAsk: () => void
  onScopes: () => void
  onNewTopic: () => void
  /** Offer the background whole-book route when the turn itself was too large. */
  onAnalyze?: () => void
}) {
  const [more, setMore] = useState(false)
  const stopped = m.status === 'cancelled'
  const code = m.errorCode ?? (stopped ? 'CANCELLED' : 'SESSION_INTERRUPTED')
  const failure = run?.failure
  const resumable = !!run && !!failure?.retryable && run.resumable && ['failed', 'interrupted'].includes(run.status)
  const needsContext = failure?.code === 'CONTEXT_OVERFLOW'
  const tooLarge = ['INPUT_BUDGET_EXCEEDED', 'TURN_BUDGET_EXCEEDED', 'TOOL_BUDGET_EXCEEDED', 'CONTEXT_OVERFLOW'].includes(code)
  const title = storySaved ? '设定已经保存，但回答中断。' : stopped ? '已停止回复。' : m.text.trim() ? '这次回复没有完整生成，已收到的内容已保留。' : '这次回复未能完成，你的问题已保存。'
  // The code-specific explanation is the most precise; the run's category text covers unknown codes.
  const specific = thinkingError(code)
  const explanation = specific === thinkingError() && failure?.message ? failure.message : specific
  const resume = () => onResume({ runId: run!.runId, confirmAdditionalCost: true, ...(recent.trim() ? { continuationContext: recent.trim() } : {}) })
  return (
    <div className="msg-in mt-5 border-l-2 border-line pl-4">
      <p className="text-ui text-ink-2">{title}</p>
      {!stopped && <p className="mt-1 text-ui-sm text-ink-3">{explanation}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
        {resumable && (
          <Btn size="sm" variant="outline" disabled={busy} onClick={resume} className="max-md:min-h-11">
            <Icon name="refresh" className="h-3 w-3" />
            {storySaved || run!.status === 'interrupted' || needsContext ? '继续回复' : '重新尝试'}
          </Btn>
        )}
        {!resumable && (
          <Btn size="sm" variant="outline" disabled={busy} onClick={onAsk} className="max-md:min-h-11">
            <Icon name="refresh" className="h-3 w-3" />
            重新提问
          </Btn>
        )}
        {tooLarge && onAnalyze && (
          <Btn size="sm" variant="outline" disabled={busy} onClick={onAnalyze} className="max-md:min-h-11">
            <Icon name="layers" className="h-3 w-3" />
            转为整书后台分析
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
      {tooLarge && onAnalyze && (
        <p className="mt-2 text-micro text-ink-3">
          整书分析会按章节分批读取已保存正文，不会一次发送整本书；进度和候选发现可在「整书分析」里查看，只有你确认后才会成为设定。
        </p>
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
        本轮查阅 {sources.length} 处原文
        <Icon name="chevron" className={`h-3 w-3 transition-transform duration-200 ease-calm ${open ? 'rotate-90' : ''}`} />
      </Btn>
      {open && (
        <div className="fade mt-2 ml-2 space-y-3">
          {sources.map((src, i) => (
            <Quote
              key={src.sourceId}
              label={`［原文 ${i + 1}］${src.title} · ${src.validity === 'stale' ? '旧版本引文' : '原文位置已核验'}${src.epistemic ? ` · ${{ observation: '原文提及', claim: '角色说法', inference: 'AI 推测' }[src.epistemic]}` : ''}`}
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
