// 本次整理 (Figma Make idea/Inspiration.tsx review drawer) and the proposal
// detail drawer. Proposals are real CreativeProposals; nothing here writes
// canon — accepting is always the author's explicit decision through the
// existing creative decide API.
import { useEffect, useState } from 'react'
import type { CreativeProposal, CreativeTurn } from '@writer-agent/contracts'
import { Btn, Choice, Icon, IconBtn, ago } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import AssetEditor from '../creative/AssetEditor'
import ProposalCard from '../creative/ProposalCard'
import { designKind, designKindName } from '../creative/kit'
import { creativeError, turnStatusLabels } from '../creative/labels'

export type OrganizeSettings = { enabled: boolean; needsModelConsent: boolean; autoOrganize: boolean; available: boolean; paused: boolean }

export function ReviewDrawer({ settings, proposals, onOpen, onDecide, onClose, onBook, onEnable, onAuto }: {
  settings?: OrganizeSettings
  proposals: CreativeProposal[]
  onOpen: (p: CreativeProposal) => void
  onDecide: (p: CreativeProposal, action: 'accept' | 'reject') => void
  onClose: () => void
  onBook: () => void
  onEnable: () => void
  onAuto: (on: boolean) => void
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const off = !settings?.enabled || settings.needsModelConsent
  return (
    <>
      <div className="fade fixed inset-0 z-50 bg-scrim" onClick={onClose} aria-hidden />
      <aside aria-label="本次整理" className="slide-r fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line-soft bg-surface shadow-soft sm:max-w-drawer">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line-soft pr-2 pl-5">
          <span className="text-ui font-medium text-ink">本次整理</span>
          <IconBtn icon="x" label="关闭" onClick={onClose} className="ml-auto max-md:min-h-11 max-md:min-w-11" />
        </div>
        <div className="scroll min-h-0 flex-1 overflow-y-auto p-4">
          {settings && off && (
            <div className="mb-4 rounded-lg border border-line-soft bg-paper px-3.5 py-3 text-ui-sm">
              <p className="text-ink">{settings.needsModelConsent ? '整理所用的模型已变化，需要重新确认后才能继续整理。' : '启用后，讨论中的人物、世界观、剧情与伏笔会被整理成待确认的候选。'}</p>
              <Btn size="sm" variant="primary" className="mt-2" disabled={!settings.available} onClick={onEnable}>
                {settings.needsModelConsent ? '重新确认' : '启用灵感整理'}
              </Btn>
              {!settings.available && <p className="mt-1 text-micro text-warn">整理服务暂未配置，稍后再试。</p>}
            </div>
          )}
          <p className="mb-3 text-ui-sm text-ink-3">这次讨论整理出的设定草稿，挑有用的收入「书」即可。</p>
          {!proposals.length && !off && <p className="py-6 text-center text-ui-sm text-ink-3">这次讨论还没有整理出内容。继续聊下去，人物、世界观、剧情和伏笔会在这里逐步出现。</p>}
          <ul className="space-y-2">
            {proposals.map((p) => (
              <li key={p.proposalId}>
                <ProposalCard dense proposal={p} onOpen={() => onOpen(p)} onAccept={() => onDecide(p, 'accept')} onReject={() => onDecide(p, 'reject')} onEdit={() => onOpen(p)} />
              </li>
            ))}
          </ul>
        </div>
        <div className="shrink-0 space-y-2 border-t border-line-soft px-5 py-3">
          {settings?.enabled && !settings.needsModelConsent && (
            <Choice checked={settings.autoOrganize} onChange={onAuto} className="text-ui-sm text-ink-2">
              每轮回复后自动整理
            </Choice>
          )}
          <Btn variant="link" className="text-ui-sm" onClick={onBook}>
            在「书」中查看全部待确认
            <Icon name="chevron" className="h-3 w-3" />
          </Btn>
        </div>
      </aside>
    </>
  )
}

/** The lightweight entry under each reply: organize this turn, its status, or its candidates. */
export function TurnOrganize({ turn, proposals, enabled, busy, onOrganize, onOpen, onDecide }: {
  turn?: CreativeTurn
  proposals: CreativeProposal[]
  enabled: boolean
  busy: boolean
  onOrganize: () => void
  onOpen: (p: CreativeProposal) => void
  onDecide: (p: CreativeProposal, action: 'accept' | 'reject') => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (!enabled) return null
  const own = proposals.filter((p) => turn?.changeSetId && p.changeSetId === turn.changeSetId)
  const open = own.filter((p) => p.status === 'proposed').length
  if (!turn)
    return (
      <div className="mt-5 -ml-2">
        <Btn size="sm" disabled={busy} onClick={onOrganize} className="text-ink-3 max-md:min-h-11">
          <Icon name="layers" className="h-3 w-3" />
          整理本轮
        </Btn>
      </div>
    )
  if (turn.status === 'awaiting' || turn.status === 'queued')
    return (
      <p className="mt-5 inline-flex items-center gap-1.5 text-ui-sm text-ink-3" aria-live="polite">
        <Icon name="refresh" className="h-3 w-3 animate-spin" />
        正在整理本轮讨论…
      </p>
    )
  if (turn.status === 'organized' && own.length > 0) {
    const kinds = [...new Set(own.map((p) => designKindName[designKind(p.kind)]))].join('、')
    return (
      <div className="mt-5">
        <Btn size="sm" variant="outline" pressed={expanded} onClick={() => setExpanded(!expanded)} className="h-auto min-h-7 py-1 text-left whitespace-normal max-md:min-h-11">
          <Icon name="layers" className="h-3 w-3" />
          整理出 {own.length} 项候选 · {kinds}
          {open < own.length ? ` · 已处理 ${own.length - open}` : ''}
          <Icon name="chevronDown" className={`h-3 w-3 transition-transform duration-200 ease-calm ${expanded ? 'rotate-180' : ''}`} />
        </Btn>
        {expanded && (
          <ul className="fade mt-3 space-y-2">
            {own.map((p) => (
              <li key={p.proposalId}>
                <ProposalCard dense proposal={p} onOpen={() => onOpen(p)} onAccept={() => onDecide(p, 'accept')} onReject={() => onDecide(p, 'reject')} onEdit={() => onOpen(p)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  if (turn.status === 'no_change') return null
  return (
    <p className="mt-5 flex flex-wrap items-center gap-2 text-micro text-ink-3">
      {turnStatusLabels[turn.status]}
      {turn.reason ? ` · ${turn.reason}` : ''}
      {['failed', 'skipped', 'expired', 'cancelled'].includes(turn.status) && (
        <Btn variant="link" className="text-micro" disabled={busy} onClick={onOrganize}>
          重新整理
        </Btn>
      )}
    </p>
  )
}

export function ProposalDrawer({ proposal: p, book, chapters, onClose, onDecide, onDone, onSession }: {
  proposal: CreativeProposal
  book: string
  chapters: { id: string; title: string }[]
  onClose: () => void
  onDecide: (p: CreativeProposal, action: 'accept' | 'reject') => void
  onDone: () => void
  onSession: (sessionId: string, messageId: string) => void
}) {
  const [edit, setEdit] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !edit && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [edit, onClose])
  return (
    <>
      <div className="fade fixed inset-0 z-50 bg-scrim" onClick={onClose} aria-hidden />
      <aside aria-label="候选详情" className="slide-r fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line-soft bg-surface shadow-soft sm:max-w-drawer">
        <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-5 py-3">
          <span className="min-w-0 truncate text-ui-sm text-ink-3">{designKindName[designKind(p.kind)]} · 候选</span>
          <IconBtn icon="x" label="关闭详情" onClick={onClose} className="ml-auto max-md:min-h-11 max-md:min-w-11" />
        </div>
        <div className="scroll min-h-0 flex-1 overflow-auto px-5 pt-5 pb-16">
          <ProposalCard proposal={p} busy={busy} onAccept={() => onDecide(p, 'accept')} onReject={() => onDecide(p, 'reject')} onEdit={() => setEdit(true)} onShowConversation={() => onSession(p.source.sessionId, p.source.messageId)} />
          <p className="mt-4 text-micro text-ink-3">来源：灵感对话 · {ago(Date.parse(p.source.capturedAt) || Date.now())}</p>
          {error && (
            <p role="alert" className="mt-3 text-ui-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </aside>
      {edit && (
        <AssetEditor
          title="编辑后确认"
          kind={p.kind}
          kindLocked
          showStatus={p.operation === 'CREATE'}
          initial={p.result ?? p.draft}
          chapters={chapters}
          busy={busy}
          error={error}
          submitLabel="保存并确认"
          onClose={() => setEdit(false)}
          onSubmit={async ({ content, status }) => {
            setBusy(true)
            setError('')
            try {
              await creativeApi.decide(book, [{ proposalId: p.proposalId, action: 'accept_edited', content, ...(p.operation === 'CREATE' ? { status } : {}), ...(p.stale && p.currentVersion ? { expectedVersion: p.currentVersion } : {}) }])
              setEdit(false)
              onDone()
            } catch (e) {
              setError(creativeError(e))
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
    </>
  )
}
