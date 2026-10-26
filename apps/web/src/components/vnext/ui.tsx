// Writer Agent design-system primitives (VNext). Feature code composes these; it does not write raw controls.
import { useEffect, type ReactNode, type Ref } from 'react'

type BtnVariant = 'primary' | 'quiet' | 'outline' | 'danger' | 'link' | 'accent' | 'danger-outline'
type BtnSize = 'sm' | 'md' | 'lg'
const btnV: Record<BtnVariant, string> = {
  primary: 'bg-ink text-page hover:opacity-90',
  quiet: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  outline: 'border border-line text-ink hover:bg-surface-2',
  danger: 'bg-danger text-page hover:opacity-90',
  link: 'text-accent hover:underline underline-offset-4',
  accent: 'bg-accent text-page hover:opacity-90',
  'danger-outline': 'border border-danger/40 text-danger hover:bg-danger-soft',
}

export function buttonClassName(variant: BtnVariant = 'quiet', size: BtnSize = 'md') {
  const sz =
    variant === 'link'
      ? 'text-ui'
      : size === 'sm'
        ? 'h-7 px-2 text-ui-sm'
        : size === 'lg'
          ? 'h-10 px-4 text-ui font-medium'
          : 'h-8 px-3 text-ui'
  return `btn inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md ${sz} ${btnV[variant]}`
}

export function Btn({
  children,
  onClick,
  variant = 'quiet',
  disabled,
  title,
  className = '',
  size = 'md',
  type = 'button',
  ariaLabel,
  pressed,
}: {
  children: ReactNode
  onClick?: (e: React.MouseEvent) => void
  variant?: BtnVariant
  disabled?: boolean
  title?: string
  className?: string
  size?: BtnSize
  type?: 'button' | 'submit'
  ariaLabel?: string
  pressed?: boolean
}) {
  return (
    <button
      type={type}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`${buttonClassName(variant, size)} ${className}`}
    >
      {children}
    </button>
  )
}

export function IconBtn({
  icon,
  label,
  onClick,
  active,
  disabled,
  className = '',
  shortcut,
  size = 'md',
}: {
  icon: IconName
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  className?: string
  shortcut?: string
  size?: 'sm' | 'md'
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label}  ${shortcut}` : label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`btn inline-flex ${size === 'sm' ? 'h-6 w-6' : 'h-8 w-8'} shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'} ${className}`}
    >
      <Icon name={icon} />
    </button>
  )
}

/** Unstyled full-width pressable row, for lists. */
export function Row({
  children,
  onClick,
  active,
  className = '',
  title,
  disabled,
}: {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  className?: string
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      aria-current={active || undefined}
      className={`btn block w-full rounded-md text-left ${active ? 'bg-surface-2 text-ink' : 'hover:bg-surface-2'} ${className}`}
    >
      {children}
    </button>
  )
}

export function Heading({
  level = 2,
  children,
  className = '',
}: {
  level?: 1 | 2 | 3
  children: ReactNode
  className?: string
}) {
  const cls =
    level === 1
      ? 'font-prose text-title font-medium text-ink'
      : level === 2
        ? 'text-ui-lg font-medium text-ink'
        : 'text-ui-sm font-medium text-ink-3'
  if (level === 1) return <h1 className={`${cls} ${className}`}>{children}</h1>
  if (level === 2) return <h2 className={`${cls} ${className}`}>{children}</h2>
  return <h3 className={`${cls} ${className}`}>{children}</h3>
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  autoFocus,
  onKeyDown,
  className = '',
  prose,
  label,
  inputRef,
  disabled,
  maxLength,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  maxLength?: number
  rows?: number
  autoFocus?: boolean
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  className?: string
  prose?: boolean
  label: string
  inputRef?: Ref<HTMLTextAreaElement>
}) {
  return (
    <textarea
      disabled={disabled}
      maxLength={maxLength}
      ref={inputRef}
      aria-label={label}
      rows={rows}
      autoFocus={autoFocus}
      value={value}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      onChange={(e) => onChange(e.target.value)}
      className={`block w-full resize-none rounded-md bg-transparent text-ink outline-none placeholder:text-ink-3 ${prose ? 'font-prose text-read' : 'text-ui'} ${className}`}
    />
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  label,
  autoFocus,
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  label: string
  autoFocus?: boolean
  className?: string
}) {
  return (
    <label
      className={`flex h-8 items-center gap-2 rounded-md bg-surface-2 px-2.5 text-ink-3 focus-within:text-ink ${className}`}
    >
      <Icon name="search" />
      <input
        aria-label={label}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-3"
      />
    </label>
  )
}

/** Single-line text field without an icon (codes, short values). */
export function Field({
  value,
  onChange,
  placeholder,
  label,
  maxLength,
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  label: string
  maxLength?: number
  className?: string
}) {
  return (
    <input
      aria-label={label}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className={`h-8 min-w-0 rounded-md bg-surface-2 px-2.5 text-ui text-ink outline-none placeholder:text-ink-3 focus:ring-1 focus:ring-line ${className}`}
    />
  )
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  label: string
  size?: 'sm' | 'md'
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex items-center gap-0.5">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={`btn whitespace-nowrap rounded-md ${size === 'sm' ? 'h-7 px-2.5 text-ui-sm' : 'h-8 px-2.5 text-ui sm:px-3'} ${value === v ? 'bg-surface-2 font-medium text-ink' : 'text-ink-3 hover:text-ink'}`}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

/** Marks anything simulated. Always visible next to Agent output and prototype-only actions. */
export function Proto({ children = '原型 · 模拟' }: { children?: ReactNode }) {
  return (
    <span
      title="原型阶段：由本地脚本模拟，未连接 Agent Runtime 或后端"
      className="inline-flex shrink-0 items-center rounded border border-dashed border-line px-1.5 text-micro text-ink-3"
    >
      {children}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line px-1 font-ui text-micro text-ink-3">{children}</kbd>
  )
}

export function Dot({ tone }: { tone: 'conflict' | 'ai' | 'quiet' | 'danger' | 'ok' | 'warn' }) {
  const c = {
    conflict: 'bg-conflict',
    ai: 'bg-ai',
    quiet: 'bg-ink-4',
    danger: 'bg-danger',
    ok: 'bg-ok',
    warn: 'bg-warn',
  }[tone]
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${c}`} />
}

/** Prose quote with a hairline rule — the single visual form for cited text. */
export function Quote({
  children,
  tone = 'quiet',
  label,
  onOpen,
  state = 'ok',
}: {
  children: ReactNode
  tone?: 'quiet' | 'conflict' | 'ai'
  label?: string
  onOpen?: () => void
  state?: 'ok' | 'stale' | 'missing'
}) {
  const rule = { quiet: 'border-ink-4', conflict: 'border-conflict', ai: 'border-ai' }[tone]
  return (
    <figure
      className={`border-l-2 ${state === 'missing' ? 'border-dashed border-line' : rule} pl-3`}
    >
      {label && (
        <figcaption className="mb-1 flex items-center gap-2 text-micro text-ink-3">
          <span>{label}</span>
          {state === 'stale' && <span className="text-warn">原文已改动 · 需重新核对</span>}
          {state === 'missing' && <span className="text-warn">来源未建档 · 无法核对</span>}
          {onOpen && state !== 'missing' && (
            <Btn variant="link" className="ml-auto text-micro" onClick={onOpen}>
              查看原文
            </Btn>
          )}
        </figcaption>
      )}
      <blockquote
        className={`font-prose text-ui-lg ${state === 'missing' ? 'text-ink-3' : 'text-ink'}`}
      >
        {children}
      </blockquote>
    </figure>
  )
}

export function Dialog({
  title,
  children,
  onClose,
  actions,
  wide,
  label,
  size,
  footnote,
}: {
  title: ReactNode
  children: ReactNode
  onClose: () => void
  actions?: ReactNode
  wide?: boolean
  label?: string
  size?: 'md' | 'lg' | 'xl'
  footnote?: ReactNode
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div
      className="fade fixed inset-0 z-50 flex items-end justify-center bg-scrim p-0 sm:items-center sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`fade-up max-h-full w-full overflow-auto rounded-t-xl border border-line bg-surface p-6 shadow-soft sm:rounded-xl ${wide || size === 'xl' ? 'sm:max-w-3xl' : size === 'lg' ? 'sm:max-w-xl' : 'sm:max-w-md'}`}
      >
        <div className="text-ui-lg font-medium text-ink">{title}</div>
        <div className="mt-3 text-ui text-ink-2">{children}</div>
        {(actions || footnote) && (
          <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
            {footnote && <div className="mr-auto text-micro text-ink-3">{footnote}</div>}
            {actions}
          </div>
        )}
      </div>
    </div>
  )
}

export function Toasts({
  items,
}: {
  items: { id: string; text: string; action?: { label: string; run: () => void } }[]
}) {
  return (
    <div
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className="fade-up pointer-events-auto flex items-center gap-3 rounded-lg bg-ink px-4 py-2 text-ui text-page shadow-soft"
        >
          {t.text}
          {t.action && (
            <button
              type="button"
              onClick={t.action.run}
              className="btn font-medium underline underline-offset-4"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function Skeleton({ lines = 4 }: { lines?: number }) {
  const w = ['w-full', 'w-11/12', 'w-10/12', 'w-8/12', 'w-9/12', 'w-7/12']
  return (
    <div className="space-y-4" aria-busy="true" aria-label="章节加载中">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`skeleton h-4 ${w[i % w.length]}`} />
      ))}
    </div>
  )
}

// Synced from Figma Make (Writer Agent UI_UX Design/src/components/ui.tsx).
export type IconName = 'menu' | 'panel' | 'x' | 'search' | 'pen' | 'sun' | 'moon' | 'focus' | 'chevron' | 'back' | 'think' | 'download' | 'flask' | 'expand' | 'collapse' | 'alert' | 'check' | 'lock'
  | 'book' | 'plus' | 'upload' | 'file' | 'more' | 'trash' | 'edit' | 'users' | 'globe' | 'clock' | 'revision' | 'layers' | 'refresh' | 'pause' | 'play' | 'stop'
  | 'send' | 'quote' | 'external' | 'up' | 'down' | 'folder' | 'shield' | 'sliders' | 'eye' | 'offline' | 'history' | 'note' | 'flag' | 'pin' | 'chevronDown'
  | 'sidebarL' | 'sidebarR' | 'info' | 'image' | 'review' | 'link' | 'target' | 'compress' | 'tool' | 'dot' | 'undo' | 'move' | 'grid' | 'thread'
const paths: Record<IconName, ReactNode> = {
  menu: <path d="M3 5h10M3 8h10M3 11h6" />,
  panel: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M10 3v10" /></>,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3 3" /></>,
  pen: <path d="M10.5 3.5l2 2L6 12l-2.5.5L4 10z" />,
  sun: <><circle cx="8" cy="8" r="2.8" /><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" /></>,
  moon: <path d="M12.5 9.5A5 5 0 016.5 3.5a5 5 0 106 6z" />,
  focus: <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  back: <path d="M10 4L6 8l4 4" />,
  think: <><path d="M4 11.5c-1-.8-1.5-2-1.5-3.3C2.5 5.3 5 3 8 3s5.5 2.3 5.5 5.2S11 13.4 8 13.4c-.7 0-1.4-.1-2-.3L3.5 14z" /></>,
  download: <path d="M8 3v7M5 7.5L8 10.5l3-3M3.5 13h9" />,
  flask: <path d="M6.5 2.5h3M7 2.5v4L3.8 12a1 1 0 00.9 1.5h6.6a1 1 0 00.9-1.5L9 6.5v-4" />,
  expand: <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />,
  collapse: <path d="M13 3L9 7M9 3.5V7h3.5M3 13l4-4M7 12.5V9H3.5" />,
  alert: <><path d="M8 2.5l6 10.5H2z" /><path d="M8 6.5v3M8 11.2v.1" /></>,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></>,
  book: <><path d="M3 3.5h4a1.5 1.5 0 011.5 1.5v8.5A1.5 1.5 0 007 12H3z" /><path d="M13 3.5H9.5A1.5 1.5 0 008 5v8.5A1.5 1.5 0 019.5 12H13z" /></>,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  upload: <path d="M8 10.5v-7M5 6.5L8 3.5l3 3M3.5 13h9" />,
  file: <><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></>,
  more: <><circle cx="4" cy="8" r=".6" /><circle cx="8" cy="8" r=".6" /><circle cx="12" cy="8" r=".6" /></>,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />,
  edit: <><path d="M10 3.5l2.5 2.5L6 12.5H3.5V10z" /><path d="M8.5 5l2.5 2.5" /></>,
  users: <><circle cx="6" cy="6" r="2.2" /><path d="M2.5 13c.4-2 1.8-3.2 3.5-3.2s3.1 1.2 3.5 3.2" /><path d="M10.5 4a2 2 0 010 4M11.5 9.9c1 .4 1.7 1.5 2 3.1" /></>,
  globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10 5.7 8S6.4 4.1 8 2.5" /></>,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
  revision: <><circle cx="4.5" cy="4" r="1.5" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="11.5" cy="6.5" r="1.5" /><path d="M4.5 5.5v5M11.5 8c0 2-2 2.5-5.5 3.2" /></>,
  layers: <><path d="M8 2.5l5.5 3L8 8.5l-5.5-3z" /><path d="M2.5 8.5L8 11.5l5.5-3M2.5 11L8 14l5.5-3" /></>,
  refresh: <><path d="M13 8a5 5 0 01-8.6 3.5M3 8a5 5 0 018.6-3.5" /><path d="M11.8 2v2.6H9.2M4.2 14v-2.6h2.6" /></>,
  pause: <path d="M6 4v8M10 4v8" />,
  play: <path d="M5 3.5v9l7-4.5z" />,
  stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1" />,
  send: <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
  quote: <path d="M3.5 11.5c0-3 1-5 3-6M9.5 11.5c0-3 1-5 3-6M3.5 11.5h2.5V9H3.5M9.5 11.5H12V9H9.5" />,
  external: <path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13H3V4.5h3.5" />,
  up: <path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" />,
  down: <path d="M8 3.5v9M4.5 9L8 12.5 11.5 9" />,
  folder: <path d="M2.5 4.5a1 1 0 011-1h3l1.5 1.5h4.5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1z" />,
  shield: <><path d="M8 2.5l5 2v3.8c0 2.8-2.1 4.7-5 5.7-2.9-1-5-2.9-5-5.7V4.5z" /><path d="M6 8l1.5 1.5L10.5 6.5" /></>,
  sliders: <path d="M3 5h6M11.5 5H13M3 11h1.5M7 11h6M9 3.5v3M4.5 9.5v3" />,
  eye: <><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" /><circle cx="8" cy="8" r="1.8" /></>,
  offline: <><path d="M2.5 6.5a8 8 0 0111 0M4.5 8.7a5 5 0 017 0M6.6 10.8a2 2 0 012.8 0" /><path d="M2.5 2.5l11 11" /></>,
  history: <><path d="M2.8 8a5.2 5.2 0 101.6-3.8" /><path d="M2.5 2.5v2.5H5M8 5.5V8l1.8 1.2" /></>,
  note: <><path d="M3.5 2.5h9v8l-3 3h-6z" /><path d="M12.5 10.5h-3v3M6 6h4M6 8.5h2.5" /></>,
  flag: <path d="M4 14V2.5M4 3h7.5L10 5.5 11.5 8H4" />,
  pin: <><path d="M8 14s4.5-4 4.5-7.5a4.5 4.5 0 00-9 0C3.5 10 8 14 8 14z" /><circle cx="8" cy="6.5" r="1.5" /></>,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  sidebarL: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M6.5 3v10" /></>,
  sidebarR: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M9.5 3v10" /></>,
  info: <><circle cx="8" cy="8" r="5.5" /><path d="M8 7.5v3.5M8 5.2v.1" /></>,
  image: <><rect x="2.5" y="3.5" width="11" height="9" rx="1" /><circle cx="6" cy="6.5" r="1" /><path d="M2.5 11l3.5-3 3 2.5 2-1.5 2.5 2" /></>,
  review: <><path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z" /><path d="M5.5 7l1.5 1.5 3-3" /></>,
  link: <path d="M7 9a2.5 2.5 0 003.5 0l2-2a2.5 2.5 0 00-3.5-3.5l-.6.6M9 7a2.5 2.5 0 00-3.5 0l-2 2A2.5 2.5 0 007 12.5l.6-.6" />,
  target: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" /></>,
  compress: <path d="M4 2.5L8 6l4-3.5M4 13.5L8 10l4 3.5M2.5 8h11" />,
  tool: <path d="M10.5 2.8a3 3 0 00-3.7 3.9L2.8 10.7a1.4 1.4 0 002 2l4-4a3 3 0 003.9-3.7l-1.8 1.8-1.7-.3-.3-1.7z" />,
  dot: <circle cx="8" cy="8" r="2" />,
  undo: <><path d="M5 6.5h5a3 3 0 010 6H7" /><path d="M7 4L4.5 6.5 7 9" /></>,
  move: <path d="M3 8h10M10 5l3 3-3 3M6 3.5v9" />,
  grid: <><rect x="3" y="3" width="4" height="4" rx=".8" /><rect x="9" y="3" width="4" height="4" rx=".8" /><rect x="3" y="9" width="4" height="4" rx=".8" /><rect x="9" y="9" width="4" height="4" rx=".8" /></>,
  thread: <><circle cx="4" cy="4" r="1.5" /><circle cx="12" cy="12" r="1.5" /><path d="M5.5 4.5c4 0 1 7 5 7" strokeDasharray="1.5 1.5" /></>,
}
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`h-4 w-4 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  )
}

export const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.round(h / 24)
  return d === 1 ? '昨天' : `${d} 天前`
}
export const cn = (n: number) => `第 ${n} 章`

/** Checkbox / radio with a label. */
export function Choice({
  type = 'checkbox',
  checked,
  onChange,
  name,
  children,
  className = '',
}: {
  type?: 'checkbox' | 'radio'
  checked: boolean
  onChange: (v: boolean) => void
  name?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 ${className}`}>
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-current"
      />
      <span className="min-w-0">{children}</span>
    </label>
  )
}

/** Native select keeps the keyboard and mobile picker semantics. */
export function Select({
  label,
  value,
  onChange,
  disabled,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  options: { value: string; label: string }[]
}) {
  return (
    <label className="flex flex-wrap items-center gap-3 text-ui-sm text-ink-3">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 max-w-full rounded-md bg-surface-2 px-2 py-1 text-ui text-ink"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
