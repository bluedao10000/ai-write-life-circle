// V3 creative-asset presentation primitives, ported from Figma Make
// (Writer Agent UI_UX Design/src/components/idea/kit.tsx) and mapped onto the
// real proposal / asset contracts. Presentational only.
import { useState, type ReactNode } from 'react'
import type { CreativeAsset, CreativeContent, CreativeKind, CreativeProposal } from '@writer-agent/contracts'
import { Btn, Dot, Icon, type IconName } from '../../components/vnext/ui'

/** Design status vocabulary. Proposal stance/lifecycle and asset status map onto it. */
export type DesignStatus = 'suggested' | 'pending' | 'confirmed' | 'conflict' | 'rejected' | 'draft' | 'retired'
const statusName: Record<DesignStatus, string> = {
  suggested: 'AI 建议',
  pending: '待作者确认',
  confirmed: '作者已确认',
  conflict: '存在冲突',
  rejected: '已否决',
  draft: '作者草稿',
  retired: '已归档',
}
const statusCls: Record<DesignStatus, string> = {
  confirmed: 'border-transparent text-ok',
  pending: 'border-transparent text-warn',
  suggested: 'border-dashed border-ai text-ai',
  conflict: 'border-transparent text-conflict',
  rejected: 'border-transparent text-ink-3 line-through',
  draft: 'border-transparent text-ink-2',
  retired: 'border-transparent text-ink-3',
}
export function StatusTag({ status }: { status: DesignStatus }) {
  return (
    <span title={status === 'suggested' ? 'AI 推测 / 不构成作品事实，需要你确认' : undefined} className={`inline-flex shrink-0 items-center gap-1 rounded border px-1 text-micro ${statusCls[status]}`}>
      {status === 'confirmed' && <Dot tone="ok" />}
      {status === 'conflict' && <Dot tone="conflict" />}
      {status === 'suggested' && <span aria-hidden>◇</span>}
      {statusName[status]}
    </span>
  )
}
export function proposalStatus(p: CreativeProposal): DesignStatus {
  if (p.status === 'rejected' || p.status === 'expired' || p.status === 'superseded') return 'rejected'
  if (p.status === 'accepted') return 'confirmed'
  if (p.stale || p.operation === 'SUPERSEDE') return 'conflict'
  return p.exploratory ? 'suggested' : 'pending'
}
export function assetStatus(a: Pick<CreativeAsset, 'status'>): DesignStatus {
  return a.status === 'accepted' ? 'confirmed' : a.status === 'draft' ? 'draft' : 'retired'
}

export type Origin = 'author' | 'idea' | 'prose' | 'revision'
const originName: Record<Origin, string> = { author: '作者创建', idea: '灵感对话', prose: '正文发现', revision: '作者修改' }
const originIcon: Record<Origin, IconName> = { author: 'pen', idea: 'think', prose: 'book', revision: 'edit' }
export function OriginTag({ origin }: { origin: Origin }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-micro text-ink-3">
      <Icon name={originIcon[origin]} className="h-3 w-3" />
      {originName[origin]}
    </span>
  )
}
export const assetOrigin = (a: CreativeAsset): Origin => (a.origin === 'conversation' ? (a.version > 1 ? 'revision' : 'idea') : a.version > 1 ? 'revision' : 'author')

/** Design groups (人物 / 世界观 / 时间线 / 剧情 / 伏笔) over the server's nine kinds. */
export type DesignKind = 'person' | 'world' | 'event' | 'plot' | 'thread'
export const DESIGN_KINDS: DesignKind[] = ['person', 'world', 'event', 'plot', 'thread']
export const designKindName: Record<DesignKind, string> = { person: '人物', world: '世界观', event: '时间线', plot: '剧情', thread: '伏笔' }
export const kindsOf: Record<DesignKind, CreativeKind[]> = {
  person: ['character', 'character_arc'],
  world: ['world_rule', 'place', 'organization'],
  event: ['event'],
  plot: ['plot_line', 'open_question'],
  thread: ['foreshadowing'],
}
export const designKind = (k: CreativeKind): DesignKind => DESIGN_KINDS.find((d) => kindsOf[d].includes(k)) ?? 'plot'

export function Facets({ fields, className = '' }: { fields: { key: string; value: string }[]; className?: string }) {
  if (!fields.length) return null
  return (
    <dl className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-ui ${className}`}>
      {fields.map((f) => (
        <div key={f.key} className="contents">
          <dt className="text-ink-3">{f.key}</dt>
          <dd className="min-w-0 break-words text-ink">{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Old/new comparison. Missing `before` renders an addition. */
export function DiffView({ before, after, labels = ['当前版本', '新版本'] }: { before?: CreativeContent; after: CreativeContent; labels?: [string, string] }) {
  if (!before)
    return (
      <div className="rounded-lg border border-line-soft bg-paper px-3.5 py-3">
        <div className="mb-1.5 text-micro text-ok">新增</div>
        {after.summary && <p className="font-prose text-ui-lg text-ink">{after.summary}</p>}
        <Facets fields={after.fields} className={after.summary ? 'mt-3' : ''} />
      </div>
    )
  const keys = [...new Set([...before.fields.map((f) => f.key), ...after.fields.map((f) => f.key)])]
  const val = (c: CreativeContent, k: string) => c.fields.find((f) => f.key === k)?.value
  const rows: [string, string | undefined, string | undefined][] = [
    ['名称', before.name, after.name],
    ['概要', before.summary || undefined, after.summary || undefined],
    ...keys.map((k) => [k, val(before, k), val(after, k)] as [string, string | undefined, string | undefined]),
  ]
  const changed = rows.filter(([, b, a]) => b !== a)
  return (
    <div className="overflow-hidden rounded-lg border border-line-soft">
      <div className="grid grid-cols-2 border-b border-line-soft bg-surface-2 text-micro text-ink-3">
        <span className="px-3 py-1.5">{labels[0]}</span>
        <span className="border-l border-line-soft px-3 py-1.5">{labels[1]}</span>
      </div>
      {!changed.length && <p className="px-3 py-2 text-ui-sm text-ink-3">两个版本内容相同。</p>}
      {changed.map(([l, b, a]) => (
        <div key={l} className="border-b border-line-soft last:border-b-0">
          <div className="px-3 pt-2 text-micro text-ink-3">{l}</div>
          <div className="grid grid-cols-2 text-ui">
            {/* del/ins keep the change readable for assistive tech; styling follows the design. */}
            <p className={`px-3 pt-0.5 pb-2 ${b ? 'text-ink-3' : 'text-ink-4'}`}>{b ? <del className="decoration-ink-4">{b}</del> : '（无）'}</p>
            <p className={`border-l border-line-soft px-3 pt-0.5 pb-2 ${a ? 'text-ink' : 'text-ink-4'}`}>{a ? <ins className="bg-ok-soft no-underline">{a}</ins> : '（移除）'}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

export function Disclosure({ label, children, defaultOpen = false, className = '' }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={className}>
      <Btn variant="link" className="text-ui-sm text-ink-3" onClick={() => setOpen(!open)} pressed={open}>
        <Icon name="chevron" className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {label}
      </Btn>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

export function EmptyState({ icon = 'book', title, body, children }: { icon?: IconName; title: string; body: ReactNode; children?: ReactNode }) {
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
