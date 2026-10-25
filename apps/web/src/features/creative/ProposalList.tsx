import { useCallback, useEffect, useRef, useState } from 'react'
import type { CreativeDecisionInput, CreativeProposal, CreativeTurn } from '@writer-agent/contracts'
import { Btn, Dialog, Dot, Heading, Icon } from '../../components/vnext/ui'
import { EmptyState } from './kit'
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
  onSession,
  dense,
  only,
  inbox,
  q = '',
  onIdea,
}: {
  bookId: string
  sessionId?: string
  refreshKey?: number
  chapters: { id: string; title: string }[]
  onDecided?: () => void
  emptyText?: string
  /** When set, “回到对话” jumps to the message instead of showing the excerpt. */
  onSession?: (sessionId: string, messageId: string) => void
  dense?: boolean
  /** Show a single proposal (detail drawer). */
  only?: string
  /** 「书 · 待确认」 layout: banner, grouped by conflict / revision / new candidate. */
  inbox?: boolean
  /** Client-side filter on name, summary and reason. */
  q?: string
  onIdea?: () => void
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
        setItems(only ? page.items.filter((p) => p.proposalId === only) : page.items)
        setSelected((all) => all.filter((p) => page.items.some((i) => i.proposalId === p)))
      })
      .catch((e: unknown) => {
        if (id === generation.current && !abort.signal.aborted) setError(creativeError(e))
      })
    return () => abort.abort()
  }, [bookId, sessionId, refreshKey, reload, only])
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
  const needle = q.trim()
  const shown = needle ? items.filter((p) => [p.result?.name, p.result?.summary, p.draft?.name, p.reason].some((t) => t?.includes(needle))) : items
  const card = (p: CreativeProposal) => (
    <ProposalCard
      key={p.proposalId}
      proposal={p}
      busy={busy}
      alternatives={p.alternativeGroup ? groups.get(p.alternativeGroup) : undefined}
      selected={selected.includes(p.proposalId)}
      onSelect={only ? undefined : (on) => setSelected((all) => (on ? [...all, p.proposalId] : all.filter((id) => id !== p.proposalId)))}
      onAccept={() => void decide([{ proposalId: p.proposalId, action: 'accept' }])}
      onReject={() => void decide([{ proposalId: p.proposalId, action: 'reject' }])}
      onEdit={() => setEditing(p)}
      onShowConversation={() => (onSession ? onSession(p.source.sessionId, p.source.messageId) : void showConversation(p))}
      dense={dense}
    />
  )
  const sections: [string, string, string, CreativeProposal[]][] = [
    ['conflict', '存在冲突', '两个版本都保留着，等你决定采用哪一个，或自己改写。', shown.filter((p) => p.operation === 'SUPERSEDE')],
    ['draft', '修改草案', '已确认的设定不会被静默覆盖；修改需要你确认。', shown.filter((p) => p.operation === 'UPDATE')],
    ['new', '新的候选', '来自灵感对话。确认后进入对应分区。', shown.filter((p) => p.operation !== 'SUPERSEDE' && p.operation !== 'UPDATE')],
  ]
  return (
    <section aria-label="设定候选" className={inbox ? '' : 'space-y-3'}>
      {inbox && (
        <p className="mb-5 flex flex-wrap items-center gap-x-2 rounded-md bg-surface-2 px-3 py-2 text-ui-sm text-ink-2">
          <Dot tone="quiet" />
          这里的内容都还不是作品设定。确认后才会出现在人物、世界观等分区。
        </p>
      )}
      {error && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-ui-sm text-danger">
          {error}
        </p>
      )}
      {inbox && shown.length === 0 ? (
        <EmptyState icon="check" title={needle ? `没有找到与“${needle}”相关的待确认内容` : '没有需要你决定的内容'} body="灵感对话整理出的候选，会先出现在这里。">
          {!needle && onIdea && (
            <Btn variant="outline" onClick={onIdea}>
              <Icon name="think" />
              去灵感聊聊
            </Btn>
          )}
        </EmptyState>
      ) : items.length === 0 ? (
        <p className="text-ui-sm text-ink-3">{emptyText}</p>
      ) : inbox ? (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2 text-ui-sm">
            <span className="text-ink-3">
              {shown.length} 条待确认{selected.length ? `，已选 ${selected.length} 条` : ''}
            </span>
            <Btn size="sm" onClick={() => setSelected(selected.length === shown.length ? [] : shown.map((p) => p.proposalId))}>
              {selected.length === shown.length ? '取消全选' : '全选'}
            </Btn>
            <Btn size="sm" variant="primary" disabled={busy || selected.length === 0} onClick={() => void decide(selected.map((proposalId) => ({ proposalId, action: 'accept' })))}>
              确认所选
            </Btn>
            <Btn size="sm" disabled={busy || selected.length === 0} onClick={() => void decide(selected.map((proposalId) => ({ proposalId, action: 'reject' })))}>
              否决所选
            </Btn>
          </div>
          {sections.map(([id, title, hint, list]) =>
            list.length > 0 ? (
              <section key={id} aria-label={title} className="mb-8">
                <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
                  <Heading level={3} className={id === 'conflict' ? 'text-conflict' : ''}>
                    {title} · {list.length}
                  </Heading>
                  <span className="text-ui-sm text-ink-3">{hint}</span>
                </div>
                <ul className="space-y-3">{list.map((p) => <li key={p.proposalId}>{card(p)}</li>)}</ul>
              </section>
            ) : null,
          )}
        </>
      ) : (
        <>
          <div hidden={!!only} className="flex flex-wrap items-center gap-2 text-ui-sm">
            <span className="text-ink-3">
              {items.length} 条待审核{selected.length ? `，已选 ${selected.length} 条` : ''}
            </span>
            <Btn size="sm" onClick={() => setSelected(selected.length === items.length ? [] : items.map((p) => p.proposalId))}>
              {selected.length === items.length ? '取消全选' : '全选'}
            </Btn>
            <Btn size="sm" variant="primary" disabled={busy || selected.length === 0} onClick={() => void decide(selected.map((proposalId) => ({ proposalId, action: 'accept' })))}>
              确认所选
            </Btn>
            <Btn size="sm" disabled={busy || selected.length === 0} onClick={() => void decide(selected.map((proposalId) => ({ proposalId, action: 'reject' })))}>
              否决所选
            </Btn>
          </div>
          <p hidden={!!only} className="text-micro text-ink-3">整理结果都是候选，确认后才会成为作品设定。未确认的候选在灵感讨论中只作为可能性出现。</p>
          {items.map(card)}
        </>
      )}
      {editing && (
        <AssetEditor
          title="编辑后确认"
          kind={editing.kind}
          kindLocked
          showStatus={editing.operation === 'CREATE'}
          initial={editing.result ?? editing.draft}
          chapters={chapters}
          busy={busy}
          error={error}
          note={editing.stale ? '以当前版本为基础编辑；保存时会再次核对版本。' : '接受后成为你的设定，并保留来源对话。'}
          submitLabel="保存并确认"
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
