import { useState, type ReactNode } from 'react'
import { Choice } from './vnext/ui'
import { kindMeta, statusMeta, type Evidence, type ProposalKind, type ProposalStatus } from '../types'

export function Btn({ children, onClick, variant = 'ghost', disabled, title, className = '', small }: {
  children: ReactNode; onClick?: (e: React.MouseEvent) => void; variant?: 'primary' | 'outline' | 'ghost'; disabled?: boolean; title?: string; className?: string; small?: boolean
}) {
  const v =
    variant === 'primary'
      ? { background: 'var(--ink)', color: 'var(--bg)' }
      : variant === 'outline'
        ? { border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)' }
        : { color: 'var(--ink-2)' }
  return (
    <button
      type="button" title={title} disabled={disabled} onClick={onClick}
      className={`btn rounded-md ${small ? 'px-2 py-1 text-[12px]' : 'px-3 py-1.5 text-[12.5px]'} ${variant === 'ghost' ? 'ghost' : 'hover:opacity-85'} ${className}`}
      style={v}
    >
      {children}
    </button>
  )
}

export function KindTag({ kind }: { kind: ProposalKind }) {
  const m = kindMeta[kind]
  return <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ color: m.c, background: m.bg }}>{m.label}</span>
}

export function StatusTag({ status }: { status: ProposalStatus }) {
  const m = statusMeta[status]
  return <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px]" style={{ color: m.c, background: m.bg }}>{m.label}</span>
}

export function DemoBadge() {
  return <span className="rounded border px-1 text-[10px]" style={{ borderColor: 'var(--line)', color: 'var(--ink-3)' }} title="原型阶段，由本地规则模拟生成，未连接 LLM">演示数据</span>
}

export function EvidenceItem({ e, onOpen }: { e: Evidence; onOpen: (e: Evidence) => void }) {
  const unavailable = e.type === 'unavailable'
  return (
    <button
      type="button" disabled={unavailable} onClick={() => onOpen(e)}
      className="btn block w-full rounded-md border-l-2 px-3 py-2 text-left enabled:hover:brightness-[0.98]"
      style={{ borderColor: unavailable ? 'var(--line)' : 'var(--ink-3)', background: 'var(--surface-2)', cursor: unavailable ? 'default' : 'pointer' }}
      title={unavailable ? '来源尚未建档' : '点击定位来源'}
    >
      <div className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--ink-3)' }}>
        <span>{e.label}</span>
        {unavailable ? (
          <span className="ml-auto rounded px-1" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>来源不可用 · 未建档</span>
        ) : (
          <span className="ml-auto" style={{ color: 'var(--accent)' }}>{e.type === 'chapter' ? '定位正文 →' : '打开条目 →'}</span>
        )}
      </div>
      {e.quote && <div className="font-prose mt-0.5 text-[13px]" style={{ color: unavailable ? 'var(--ink-2)' : 'var(--ink)' }}>{e.quote}</div>}
    </button>
  )
}

export function Empty({ title, desc, action }: { title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 h-8 w-8 rounded-full border-2 border-dashed" style={{ borderColor: 'var(--line)' }} />
      <div className="text-[13px]" style={{ color: 'var(--ink)' }}>{title}</div>
      {desc && <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--ink-3)' }}>{desc}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border px-1 font-sans text-[10px]" style={{ borderColor: 'var(--line)', color: 'var(--ink-3)' }}>{children}</kbd>
}

export function ConfirmDialog({ title, desc, confirmText, danger, onConfirm, onCancel, requireAcknowledgement }: {
  title: string; desc: string; confirmText: string; danger?: boolean; requireAcknowledgement?: boolean; onConfirm: () => void; onCancel: () => void
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(20,18,15,.28)' }} onClick={onCancel} role="dialog" aria-modal="true">
      <div className="fade-up w-[min(400px,calc(100vw-2rem))] rounded-xl border p-5" style={{ background: 'var(--surface)', borderColor: 'var(--line)', boxShadow: 'var(--shadow)' }} onClick={(e) => e.stopPropagation()}>
        <div className="text-[15px] font-medium">{title}</div>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>{desc}</p>
        {requireAcknowledgement && <Choice checked={acknowledged} onChange={setAcknowledged} className="mt-4 text-ui">我已导出本地草稿，或确认不再需要它。</Choice>}
        <div className="mt-5 flex justify-end gap-2">
          <Btn variant="outline" onClick={onCancel}>取消</Btn>
          <button autoFocus type="button" disabled={requireAcknowledgement && !acknowledged} onClick={onConfirm} className="btn rounded-md px-3 py-1.5 text-[12.5px] hover:opacity-85"
            style={{ background: danger ? 'var(--danger)' : 'var(--ink)', color: danger ? '#fff' : 'var(--bg)' }}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export function Toasts({ items }: { items: { id: string; text: string }[] }) {
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="fade-up rounded-lg px-3.5 py-2 text-[12.5px]" style={{ background: 'var(--ink)', color: 'var(--bg)', boxShadow: 'var(--shadow)' }}>{t.text}</div>
      ))}
    </div>
  )
}

export const fmtTime = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
