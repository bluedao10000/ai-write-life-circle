import { useCallback, useEffect, useRef, useState } from 'react'
import type { CreativeDecisionInput, CreativeProposal, CreativeTurn } from '@writer-agent/contracts'
import { Btn, Dialog } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import AssetEditor from './AssetEditor'
import ProposalCard from './ProposalCard'
import { creativeError } from './labels'

/**
 * Review queue for AI proposals. Decisions are batched atomically on the
 * server; a failed batch leaves every proposal untouched.
 */
export default function ProposalList({
  bookId,
  sessionId,
  refreshKey = 0,
  chapters,
  onDecided,
  emptyText = '暂无待审核的设定候选。',
}: {
  bookId: string
  sessionId?: string
  refreshKey?: number
  chapters: { id: string; title: string }[]
  onDecided?: () => void
  emptyText?: string
}) {
  const [items, setItems] = useState<CreativeProposal[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<CreativeProposal | null>(null)
  const [conversation, setConversation] = useState<CreativeTurn | null>(null)
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const id = ++generation.current
    const abort = new AbortController()
    void creativeApi
      .proposals(bookId, { status: 'proposed', sessionId, limit: 100 }, abort.signal)
      .then((page) => {
        if (id !== generation.current) return
        setItems(page.items)
        setSelected((all) => all.filter((p) => page.items.some((i) => i.proposalId === p)))
      })
      .catch((e: unknown) => {
        if (id === generation.current && !abort.signal.aborted) setError(creativeError(e))
      })
    return () => abort.abort()
  }, [bookId, sessionId, refreshKey, reload])
  const decide = useCallback(
    async (decisions: CreativeDecisionInput[]) => {
      setBusy(true)
      setError('')
      try {
        await creativeApi.decide(bookId, decisions)
        setEditing(null)
        setSelected([])
        setReload((n) => n + 1)
        onDecided?.()
      } catch (e) {
        setError(creativeError(e))
      } finally {
        setBusy(false)
      }
    },
    [bookId, onDecided],
  )
  const showConversation = async (p: CreativeProposal) => {
    try {
      setConversation(await creativeApi.excerpt(bookId, p.source.sessionId, p.source.messageId))
    } catch (e) {
      setError(creativeError(e))
    }
  }
  if (!items) return <p className="text-ui-sm text-ink-3">{error || '正在读取设定候选…'}</p>
  const groups = new Map<string, number>()
  for (const p of items) if (p.alternativeGroup) groups.set(p.alternativeGroup, (groups.get(p.alternativeGroup) ?? 0) + 1)
  return (
    <section aria-label="设定候选" className="space-y-3">
      {error && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-ui-sm text-danger">
          {error}
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-ui-sm text-ink-3">{emptyText}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-ui-sm">
            <span className="text-ink-3">
              {items.length} 条待审核{selected.length ? `，已选 ${selected.length} 条` : ''}
            </span>
            <Btn size="sm" onClick={() => setSelected(selected.length === items.length ? [] : items.map((p) => p.proposalId))}>
              {selected.length === items.length ? '取消全选' : '全选'}
            </Btn>
            <Btn size="sm" variant="primary" disabled={busy || selected.length === 0} onClick={() => void decide(selected.map((proposalId) => ({ proposalId, action: 'accept' })))}>
              接受所选
            </Btn>
            <Btn size="sm" disabled={busy || selected.length === 0} onClick={() => void decide(selected.map((proposalId) => ({ proposalId, action: 'reject' })))}>
              拒绝所选
            </Btn>
          </div>
          <p className="text-micro text-ink-3">候选只是建议。接受前不会进入正式设定；未审核的候选可以在灵感讨论中被提到，但会标注为未确认。</p>
          {items.map((p) => (
            <ProposalCard
              key={p.proposalId}
              proposal={p}
              busy={busy}
              alternatives={p.alternativeGroup ? groups.get(p.alternativeGroup) : undefined}
              selected={selected.includes(p.proposalId)}
              onSelect={(on) => setSelected((all) => (on ? [...all, p.proposalId] : all.filter((id) => id !== p.proposalId)))}
              onAccept={() => void decide([{ proposalId: p.proposalId, action: 'accept' }])}
              onReject={() => void decide([{ proposalId: p.proposalId, action: 'reject' }])}
              onEdit={() => setEditing(p)}
              onShowConversation={() => void showConversation(p)}
            />
          ))}
        </>
      )}
      {editing && (
        <AssetEditor
          title="编辑后接受"
          kind={editing.kind}
          kindLocked
          showStatus={editing.operation === 'CREATE'}
          initial={editing.result ?? editing.draft}
          chapters={chapters}
          busy={busy}
          error={error}
          note={editing.stale ? '以当前版本为基础编辑；保存时会再次核对版本。' : '接受后成为你的设定，并保留来源对话。'}
          submitLabel="保存并接受"
          onClose={() => setEditing(null)}
          onSubmit={({ content, status }) =>
            void decide([
              {
                proposalId: editing.proposalId,
                action: 'accept_edited',
                content,
                ...(editing.operation === 'CREATE' ? { status } : {}),
                ...(editing.stale && editing.currentVersion ? { expectedVersion: editing.currentVersion } : {}),
              },
            ])
          }
        />
      )}
      {conversation && (
        <Dialog title="相关对话" label="相关对话" size="lg" onClose={() => setConversation(null)} footnote="整理时截取的有界对话片段，仅作者可见。">
          <div className="space-y-3">
            {(conversation.excerpt ?? []).length === 0 && <p className="text-ink-3">对话片段已按保留策略清除。</p>}
            {(conversation.excerpt ?? []).map((m) => (
              <div key={m.messageId} className={m.messageId === conversation.messageId || m.messageId === conversation.answerId ? '' : 'opacity-70'}>
                <div className="text-micro text-ink-3">{m.role === 'user' ? '你' : '灵感 Agent'}</div>
                <p className="whitespace-pre-wrap font-prose text-ui text-ink">{m.text}</p>
              </div>
            ))}
          </div>
        </Dialog>
      )}
    </section>
  )
}
