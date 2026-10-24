import type { Decision, Proposal } from '@writer-agent/contracts'
import { statusMeta } from '../../types'

/** Preserve old Demo proposals/decisions as records, without silently converting them to notes or canon. */
export default function LegacyRecords({
  proposals,
  decisions,
}: {
  proposals: Proposal[]
  decisions: Decision[]
}) {
  if (!proposals.length && !decisions.length) return null
  return (
    <details className="mt-10 border-t border-line pt-6 text-ui text-ink-2">
      <summary className="cursor-pointer text-ink">旧版提案与决定 · 只读演示记录</summary>
      <p className="mt-3 text-ui-sm text-ink-3">
        保留旧版记录。它们不会自动变成创作笔记或正式设定。
      </p>
      <ul className="mt-4 space-y-4">
        {proposals.map((proposal) => (
          <li key={proposal.id}>
            <div className="font-prose text-ui-lg text-ink">{proposal.title}</div>
            <p className="text-micro text-ink-3">
              {proposal.origin} · {statusMeta[proposal.status].label}
            </p>
            <p className="mt-1 whitespace-pre-wrap">{proposal.analysis.suggestion}</p>
            {decisions
              .filter((decision) => decision.proposalId === proposal.id)
              .map((decision) => (
                <p key={decision.id} className="mt-1 text-ui-sm text-ink-3">
                  {decision.by} · {new Date(decision.at).toLocaleString('zh-CN')}
                  {decision.note ? ` · ${decision.note}` : ''}
                </p>
              ))}
          </li>
        ))}
      </ul>
    </details>
  )
}
