import { useEffect, useState, type ReactNode } from 'react'
import type { MemoryAssertion, MemorySource } from '@writer-agent/contracts'
import { Btn, Dot, Icon, type IconName } from '../../components/vnext/ui'

export type Nature = MemoryAssertion['epistemic']

export const natureLabel: Record<Nature, string> = {
  observation: '正文观察',
  claim: '角色说法',
  inference: 'AI 推测',
}

const natureHint: Record<Nature, string> = {
  observation: '正文直接写出的内容',
  claim: '角色说的或记得的，不一定客观成立',
  inference: 'AI 根据正文推断，需要作者判断',
}

const natureClass: Record<Nature, string> = {
  observation: 'border-line text-ink-2',
  claim: 'border-accent/40 text-accent',
  inference: 'border-dashed border-ai text-ai',
}

const natureIcon: Record<Nature, IconName> = {
  observation: 'quote',
  claim: 'users',
  inference: 'flask',
}

export function NatureTag({ nature, speaker }: { nature: Nature; speaker?: string }) {
  return (
    <span
      title={natureHint[nature]}
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 text-micro ${natureClass[nature]}`}
    >
      <Icon name={natureIcon[nature]} className="h-3 w-3" />
      {natureLabel[nature]}
      {speaker && <span className="text-ink-3">· {speaker}</span>}
    </span>
  )
}

export function useDebounced<T>(value: T, milliseconds = 220) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), milliseconds)
    return () => window.clearTimeout(timer)
  }, [milliseconds, value])
  return debounced
}

export function SourceCard({
  source,
  chapterLabel,
  onRead,
  onChapter,
  clamp = true,
}: {
  source: MemorySource
  chapterLabel?: string
  onRead?: (source: MemorySource) => void
  onChapter?: (source: MemorySource) => void
  clamp?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const long = source.quote.length > 54
  const unavailable = source.validity === 'unavailable'
  return (
    <figure
      className={`rounded-lg border bg-surface px-3.5 py-3 ${
        unavailable ? 'border-dashed border-line' : 'border-line-soft'
      }`}
    >
      <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-3">
        <Icon name="quote" className="h-3 w-3" />
        <span>{chapterLabel ?? source.chapterId}</span>
        {source.validity === 'current' && (
          <span className="inline-flex items-center gap-1">
            <Dot tone="ok" />
            当前版本
          </span>
        )}
        {source.validity === 'stale' && (
          <span className="inline-flex items-center gap-1 text-warn">
            <Dot tone="warn" />
            原文已修改
          </span>
        )}
        {unavailable && <span className="text-warn">暂无可引用原文</span>}
      </figcaption>
      <blockquote
        className={`mt-1.5 font-prose text-ui-lg text-ink ${
          clamp && long && !expanded ? 'line-clamp-2' : ''
        }`}
      >
        {source.quote}
      </blockquote>
      {(onRead || onChapter || (clamp && long)) && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {onRead && (
            <Btn
              variant="link"
              className="text-ui-sm"
              onClick={() => onRead(source)}
              ariaLabel={`${source.chapterId} · 查看原文依据`}
            >
              查看原文依据
            </Btn>
          )}
          {onChapter && (
            <Btn variant="link" className="text-ui-sm" onClick={() => onChapter(source)}>
              打开章节
            </Btn>
          )}
          {clamp && long && (
            <Btn
              variant="link"
              className="text-ui-sm text-ink-3"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? '收起' : '展开全文'}
            </Btn>
          )}
        </div>
      )}
    </figure>
  )
}

export function Disclosure({
  label,
  children,
  defaultOpen = false,
  className = '',
}: {
  label: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={className}>
      <Btn
        variant="link"
        className="text-ui-sm text-ink-3"
        onClick={() => setOpen((value) => !value)}
        pressed={open}
      >
        <Icon
          name="chevron"
          className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {label}
      </Btn>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="正在读取知识">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="rounded-lg border border-line-soft p-4">
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton mt-3 h-3 w-11/12" />
          <div className="skeleton mt-2 h-3 w-7/12" />
        </div>
      ))}
    </div>
  )
}

export function EmptyState({
  icon = 'file',
  title,
  body,
  children,
}: {
  icon?: IconName
  title: string
  body: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-ink-3">
        <Icon name={icon} />
      </span>
      <p className="mt-4 text-ui-lg font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-ui text-ink-3">{body}</p>
      {children && <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}

export function ErrorState({
  onRetry,
  onOther,
  otherLabel,
  technical,
}: {
  onRetry: () => void
  onOther: () => void
  otherLabel: string
  technical?: string
}) {
  return (
    <div role="alert" className="rounded-xl border border-line bg-surface px-6 py-10">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-warn">
          <Icon name="alert" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui-lg font-medium text-ink">知识暂时无法加载</p>
          <p className="mt-1 text-ui text-ink-2">
            你已保存的正文不受影响，写作可以照常进行。其他分类仍然可以打开。
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Btn variant="primary" onClick={onRetry}>
              <Icon name="refresh" />
              重试
            </Btn>
            <Btn variant="outline" onClick={onOther}>
              {otherLabel}
            </Btn>
          </div>
          {technical && (
            <Disclosure label="技术详情" className="mt-5">
              <p className="break-words rounded-md bg-surface-2 p-3 font-mono text-micro text-ink-3">
                {technical}
              </p>
            </Disclosure>
          )}
        </div>
      </div>
    </div>
  )
}

export function More({
  shown,
  total,
  onMore,
}: {
  shown: number
  total: number
  onMore: () => void
}) {
  if (shown >= total) return null
  return (
    <div className="pt-4 text-center">
      <Btn variant="outline" size="sm" onClick={onMore}>
        再显示 {Math.min(12, total - shown)} 条 · 共 {total} 条
      </Btn>
    </div>
  )
}
