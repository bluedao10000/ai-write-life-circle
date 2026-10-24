import type { ProposalKind, ProposalStatus } from '@writer-agent/contracts'

export type * from '@writer-agent/contracts'

/** Local presentation state; it is deliberately excluded from API contracts. */
export type Layout = { leftOpen: boolean; rightOpen: boolean; leftW: number; rightW: number; focus: boolean }
export type AgentTask =
  | { state: 'idle' }
  | { state: 'running'; name: string; step: string; progress: number }
  | { state: 'done'; summary: string; at: number }
  | { state: 'failed'; error: string }

export const statusMeta: Record<ProposalStatus, { label: string; c: string; bg: string }> = {
  pending: { label: '待确认', c: 'var(--warn)', bg: 'var(--warn-soft)' },
  adopted: { label: '已采纳，待作者处理', c: 'var(--accent)', bg: 'var(--accent-soft)' },
  rejected: { label: '已拒绝', c: 'var(--ink-3)', bg: 'var(--surface-2)' },
  deferred: { label: '已暂缓', c: 'var(--ink-2)', bg: 'var(--surface-2)' },
  resolved: { label: '已解决', c: 'var(--ok)', bg: 'var(--ok-soft)' },
  noted: { label: '已标记待整理', c: 'var(--ok)', bg: 'var(--ok-soft)' },
}

export const kindMeta: Record<ProposalKind, { label: string; c: string; bg: string; hint: string }> = {
  fact: { label: '事实冲突', c: 'var(--danger)', bg: 'var(--danger-soft)', hint: '存在可核验的前后矛盾' },
  suggestion: { label: '创作建议', c: 'var(--accent)', bg: 'var(--accent-soft)', hint: 'AI 提出的可选方案，由你决定' },
  research: { label: '研究参考', c: 'var(--ok)', bg: 'var(--ok-soft)', hint: '外部文学研究，不构成作品事实' },
}
