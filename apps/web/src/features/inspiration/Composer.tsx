// 灵感 composer and model picker. Layout, type and states follow Figma Make
// (Writer Agent UI_UX Design/src/components/idea/Chat.tsx); every value comes
// from the real thinking API — the model list is the server catalogue and the
// choice is sent as a registry id only.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { ThinkingModelOption } from '@writer-agent/contracts'
import { Btn, Dialog, Icon, IconBtn, Row, TextArea, type IconName } from '../../components/vnext/ui'
import { useMedia } from './media'

/** "OpenAI · GPT-OSS 120B" served by Amazon Bedrock must say so; never imply first-party hosting. */
export const hostNote = (m: Pick<ThinkingModelOption, 'displayName' | 'hostedBy'>) =>
  m.hostedBy && !m.displayName.toLowerCase().startsWith(m.hostedBy.toLowerCase()) ? `由 ${m.hostedBy} 托管` : ''

export function ModelPicker({ models, value, onPick, disabled, wide }: {
  models: ThinkingModelOption[]
  value: string
  onPick: (id: string) => void
  disabled?: boolean
  wide: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const current = models.find((m) => m.modelId === value)
  const available = !!current?.enabled
  const name = current?.displayName ?? (value ? '原模型不可用' : models.length ? '选择模型' : '模型暂不可用')
  useEffect(() => {
    if (!open || !wide) return
    box.current?.querySelector<HTMLElement>('[aria-current]')?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(box.current?.querySelectorAll<HTMLElement>('[data-model] button:not(:disabled)') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLElement)
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      e.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, wide])
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  const pick = (m: ThinkingModelOption) => {
    if (!m.enabled) return
    onPick(m.modelId)
    setOpen(false)
  }
  const items = (
    <ul data-model className="space-y-0.5">
      {!models.length && <li className="px-3 py-2.5 text-ui-sm text-ink-3">服务端暂时没有可用的模型。已有对话不受影响，稍后再试。</li>}
      {models.map((m) => {
        const on = m.modelId === value
        const host = hostNote(m)
        return (
          <li key={m.modelId}>
            <Row active={on} disabled={!m.enabled} onClick={() => pick(m)} className="flex items-start gap-3 px-3 py-2.5 max-md:py-3.5">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-ui font-medium text-ink">
                  {m.displayName}
                  {!m.enabled && <span className="text-micro font-normal text-ink-3">不可用</span>}
                </span>
                <span className="mt-0.5 block text-ui-sm text-ink-3">{m.enabled ? m.description : '暂时不可用，请稍后再试'}</span>
                {host && <span className="mt-0.5 block text-micro text-ink-3">{host}</span>}
              </span>
              {on && <Icon name="check" className="mt-0.5 text-accent" />}
            </Row>
          </li>
        )
      })}
    </ul>
  )
  const note = <p className="text-micro text-ink-3">切换只影响之后的回复，已有对话会完整保留。</p>
  return (
    <div ref={box} className="relative min-w-0">
      <Btn size="sm" pressed={open} disabled={disabled} onClick={() => setOpen(!open)} ariaLabel={`选择回复模型，当前为 ${name}`} className="max-w-full max-md:min-h-11">
        {!available && <Icon name="alert" className="h-3.5 w-3.5 text-warn" />}
        <span className={`truncate ${available ? '' : 'text-warn'}`}>{name}</span>
        <Icon name="chevronDown" className={`h-3 w-3 text-ink-3 transition-transform duration-200 ease-calm ${open ? 'rotate-180' : ''}`} />
      </Btn>
      {open && wide && (
        <>
          <div className="fixed inset-0 z-30" onClick={close} aria-hidden />
          <div role="group" aria-label="选择回复模型" className="pop absolute bottom-full left-0 z-40 mb-2 w-72 origin-bottom-left rounded-xl border border-line-soft bg-surface p-1.5 shadow-soft">
            <div className="px-3 pt-1.5 pb-1 text-micro text-ink-3">回复模型</div>
            {items}
            <div className="mt-1 border-t border-line-soft px-3 pt-2 pb-1">{note}</div>
          </div>
        </>
      )}
      {open &&
        !wide &&
        createPortal(
          <Dialog label="选择回复模型" title="选择回复模型" onClose={close}>
            <div className="-mx-3">{items}</div>
            <div className="mt-4 pb-safe">{note}</div>
          </Dialog>,
          document.body,
        )}
    </div>
  )
}

export function Composer({ value, onChange, onSend, onStop, running, sending, canSend, quote, inputRef, landing, wide, picker, sourceAccess, disabled }: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  /** The server is generating a reply: the send button becomes 停止. */
  running: boolean
  /** A request is in flight; the input is kept but locked until the server answers. */
  sending: boolean
  canSend: boolean
  quote?: ReactNode
  inputRef: RefObject<HTMLTextAreaElement | null>
  landing: boolean
  wide: boolean
  picker: ReactNode
  sourceAccess?: ReactNode
  disabled?: boolean
}) {
  const coarse = useMedia('(pointer: coarse)')
  return (
    <div className="vt-composer rounded-2xl border border-line bg-surface shadow-soft transition-colors duration-200 focus-within:border-ink-4">
      {quote}
      <TextArea
        label="说说你正在思考的问题"
        inputRef={inputRef}
        prose
        rows={1}
        maxLength={12000}
        disabled={disabled}
        value={value}
        onChange={onChange}
        placeholder="说说你正在思考的问题……"
        onKeyDown={(e) => {
          // 触屏上回车换行，用发送按钮发送；桌面回车发送，Shift + 回车换行。输入法组字时不发送。
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
          if (coarse && !e.metaKey && !e.ctrlKey) return
          e.preventDefault()
          if (!running && canSend) onSend()
        }}
        className={`scroll field-sizing-content px-4 pt-3.5 pb-1 ${landing ? 'min-h-18 max-h-72' : 'min-h-11 max-h-60 max-md:max-h-36'}`}
      />
      {sourceAccess && <div className="px-3 pb-1">{sourceAccess}</div>}
      <div className="flex min-w-0 items-center gap-2 px-2 pb-2">
        {picker}
        {wide && <span className="ml-auto shrink-0 text-micro text-ink-4">{running ? '回复中…' : sending ? '正在发送…' : 'Enter 发送 · Shift + Enter 换行'}</span>}
        {running ? (
          <Btn size="sm" variant="outline" onClick={onStop} ariaLabel="停止回复" className={`min-h-9 min-w-9 max-md:min-h-11 max-md:min-w-11 ${wide ? '' : 'ml-auto'}`}>
            <Icon name="stop" className="h-3.5 w-3.5" />
            <span className="max-md:sr-only">停止</span>
          </Btn>
        ) : (
          <Btn size="sm" variant="primary" onClick={onSend} disabled={!canSend} ariaLabel="发送" className={`min-h-9 min-w-9 max-md:min-h-11 max-md:min-w-11 ${wide ? '' : 'ml-auto'}`}>
            <Icon name="send" />
          </Btn>
        )}
      </div>
    </div>
  )
}

/** A quoted passage travelling with the next message (from 正文 or a proposal). */
export function ComposerQuote({ label, text, onClear, children }: { label: string; text: string; onClear: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 border-b border-line-soft py-2 pr-2 pl-4">
      <div className="min-w-0 flex-1">
        <div className="text-micro text-ink-3">{label}</div>
        <p className="line-clamp-2 font-prose text-ui text-ink-2">{text}</p>
        {children}
      </div>
      <IconBtn size="sm" icon="x" label="移除引用" onClick={onClear} />
    </div>
  )
}

/** Quiet line above the composer: offline, model unavailable, delivery unconfirmed. States facts, never blocks. */
export function Notice({ icon, children, action }: { icon: IconName; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="fade mb-2 flex flex-wrap items-start gap-x-2 gap-y-1 px-1 text-ui-sm text-ink-3">
      <Icon name={icon} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  )
}
