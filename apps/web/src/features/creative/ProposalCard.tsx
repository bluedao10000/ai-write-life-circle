import type { CreativeProposal } from '@writer-agent/contracts'
import { Btn, Dot } from '../../components/vnext/ui'
import { diffContent, kindLabels, operationLabels, proposalStatusLabels, stanceLabels } from './labels'

/**
 * One AI proposal. The visual language keeps three things apart: what the
 * author said (quotes marked 你), what the AI suggested (marked AI), and the
 * resulting change, which exists only after the author accepts it.
 */
export default function ProposalCard({
  proposal: p,
  selected,
  onSelect,
  onAccept,
  onEdit,
  onReject,
  onShowConversation,
  busy,
  alternatives,
}: {
  proposal: CreativeProposal
  selected?: boolean
  onSelect?: (on: boolean) => void
  onAccept?: () => void
  onEdit?: () => void
  onReject?: () => void
  onShowConversation?: () => void
  busy?: boolean
  alternatives?: number
}) {
  const pending = p.status === 'proposed'
  const changes = p.operation === 'LINK' ? [] : diffContent(p.operation === 'CREATE' ? undefined : p.current, p.result)
  const name = p.result?.name ?? p.targetName ?? '未命名设定'
  return (
    <article aria-label={`${operationLabels[p.operation]}：${name}`} className={`rounded-lg border p-4 ${p.exploratory ? 'border-dashed border-ai/60' : 'border-line'} ${selected ? 'bg-surface-2' : ''}`}>
      <header className="flex flex-wrap items-center gap-2 text-micro">
        {pending && onSelect && (
          <input type="checkbox" aria-label={`选择 ${name}`} checked={!!selected} onChange={(e) => onSelect(e.target.checked)} className="accent-current" />
        )}
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-ink-2">{operationLabels[p.operation]}</span>
        <span className="text-ink-3">{kindLabels[p.kind]}</span>
        <span className={`inline-flex items-center gap-1 ${p.stance === 'ai_suggestion' ? 'text-ai' : 'text-ink-2'}`}>
          <Dot tone={p.stance === 'ai_suggestion' ? 'ai' : p.stance === 'author_rejection' ? 'warn' : 'ok'} />
          {stanceLabels[p.stance]}
        </span>
        {p.exploratory && <span className="rounded border border-dashed border-line px-1.5 text-ink-3">探索 · 未确定</span>}
        {p.alternativeGroup && <span className="text-ink-3">互斥方案{alternatives ? ` · 共 ${alternatives} 个` : ''}（最多接受一个）</span>}
        <span className="ml-auto text-ink-3">{proposalStatusLabels[p.status]}</span>
      </header>
      <h3 className="mt-2 font-prose text-ui-lg text-ink">
        {p.operation === 'LINK' ? (
          <>
            {p.targetName} <span className="text-ink-3">—{p.link?.relation}→</span> {p.linkTargetName}
          </>
        ) : (
          name
        )}
      </h3>
      {p.stale && pending && (
        <p role="status" className="mt-2 rounded bg-warn/10 px-2 py-1 text-ui-sm text-warn">
          这条设定在候选生成后被修改过，需要对照当前版本编辑后再接受。
        </p>
      )}
      {changes.length > 0 && (
        <dl className="mt-3 space-y-1.5 text-ui-sm">
          {changes.map((c) => (
            <div key={c.key} className="grid grid-cols-[5rem_1fr] gap-2">
              <dt className="text-ink-3">{c.key}</dt>
              <dd className="min-w-0 break-words">
                {c.before && <del className="mr-2 text-ink-3">{c.before}</del>}
                {c.after ? <ins className="no-underline text-ink">{c.after}</ins> : <span className="text-warn">移除</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {p.reason && <p className="mt-3 text-ui-sm text-ink-2">AI 说明：{p.reason}</p>}
      {p.evidence.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {p.evidence.map((e, i) =>
            e.quote ? (
              <blockquote key={i} className={`border-l-2 pl-3 font-prose text-ui-sm ${e.role === 'user' ? 'border-ink-4 text-ink' : 'border-ai text-ink-2'}`}>
                <span className="mr-1 text-micro text-ink-3">{e.role === 'user' ? '你说' : 'AI 说'}</span>
                {e.quote}
              </blockquote>
            ) : null,
          )}
        </div>
      )}
      {p.source.sessionDeleted && <p className="mt-2 text-micro text-ink-3">来源会话已删除，原话已清除。</p>}
      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {pending && (
          <>
            <Btn size="sm" variant="primary" disabled={busy || p.stale} onClick={onAccept}>
              接受
            </Btn>
            {p.operation !== 'LINK' && (
              <Btn size="sm" variant="outline" disabled={busy} onClick={onEdit}>
                编辑后接受
              </Btn>
            )}
            <Btn size="sm" disabled={busy} onClick={onReject}>
              拒绝
            </Btn>
          </>
        )}
        {onShowConversation && !p.source.sessionDeleted && (
          <Btn size="sm" variant="link" className="ml-auto text-micro" onClick={onShowConversation}>
            查看相关对话
          </Btn>
        )}
      </footer>
    </article>
  )
}
