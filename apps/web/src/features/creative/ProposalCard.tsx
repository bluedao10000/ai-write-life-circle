import type { CreativeProposal } from '@writer-agent/contracts'
import { Btn, Icon } from '../../components/vnext/ui'
import { DiffView, Disclosure, OriginTag, StatusTag, proposalStatus } from './kit'
import { kindLabels, stanceLabels } from './labels'

/**
 * One AI proposal, in the Figma Make ReviewCard layout. What the author said
 * (你说), what the AI said (AI 说) and the resulting change stay distinct; the
 * change exists only after the author confirms it.
 */
export default function ProposalCard({
  proposal: p,
  selected,
  onSelect,
  onAccept,
  onEdit,
  onReject,
  onShowConversation,
  onOpen,
  busy,
  alternatives,
  dense,
}: {
  proposal: CreativeProposal
  selected?: boolean
  onSelect?: (on: boolean) => void
  onAccept?: () => void
  onEdit?: () => void
  onReject?: () => void
  onShowConversation?: () => void
  onOpen?: () => void
  busy?: boolean
  alternatives?: number
  dense?: boolean
}) {
  const pending = p.status === 'proposed'
  const status = proposalStatus(p)
  const name = p.result?.name ?? p.targetName ?? '未命名设定'
  const revision = p.operation === 'UPDATE' || p.operation === 'SUPERSEDE'
  const conflict = p.operation === 'SUPERSEDE'
  const quote = p.evidence.find((e) => e.quote)
  return (
    <article aria-label={`${kindLabels[p.kind]}：${name}`} className={`rounded-lg border bg-surface ${status === 'conflict' ? 'border-conflict/40' : p.exploratory ? 'border-dashed border-line' : 'border-line-soft'} ${selected ? 'ring-1 ring-accent/40' : ''} ${dense ? 'px-3 py-2.5' : 'px-4 py-3.5'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {pending && onSelect && <input type="checkbox" aria-label={`选择 ${name}`} checked={!!selected} onChange={(e) => onSelect(e.target.checked)} className="accent-current" />}
        <span className="text-micro text-ink-3">
          {kindLabels[p.kind]}
          {p.alternativeGroup ? ` · 互斥方案${alternatives ? ` ${alternatives} 选 1` : ''}` : ''}
        </span>
        <StatusTag status={status} />
        <span className="text-micro text-ink-3">{stanceLabels[p.stance]}</span>
        <span className="ml-auto">
          <OriginTag origin="idea" />
        </span>
      </div>
      <div className="mt-1 font-prose text-ui-lg text-ink">
        {p.operation === 'LINK' ? (
          <>
            {p.targetName} <span className="text-ink-3">—{p.link?.relation}→</span> {p.linkTargetName}
          </>
        ) : onOpen ? (
          <Btn variant="link" className="font-prose text-ui-lg text-ink" onClick={onOpen}>
            {name}
          </Btn>
        ) : (
          name
        )}
      </div>
      {revision ? (
        <>
          <p className={`mt-1 text-ui-sm ${conflict ? 'text-conflict' : 'text-ink-2'}`}>
            {conflict ? '与已确认的设定不同：' : '建议修改：'}
            {p.reason || '来自本轮讨论'}
          </p>
          <Disclosure label="比较新旧版本" defaultOpen={!dense} className="mt-2">
            {p.result && <DiffView before={p.current} after={p.result} labels={['已确认的版本', '新版本 · 灵感对话']} />}
          </Disclosure>
        </>
      ) : p.operation === 'CREATE' ? (
        <>
          {p.result?.summary && <p className={`mt-1 text-ui text-ink-2 ${dense ? 'line-clamp-2' : ''}`}>{p.result.summary}</p>}
          {!dense && p.result && p.result.fields.length > 0 && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-ui-sm">
              {p.result.fields.map((f) => (
                <div key={f.key} className="contents">
                  <dt className="text-ink-4">{f.key}</dt>
                  <dd className="text-ink-2">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {p.reason && !dense && <p className="mt-2 text-ui-sm text-ink-3">AI 说明：{p.reason}</p>}
        </>
      ) : (
        p.reason && <p className="mt-1 text-ui-sm text-ink-2">{p.reason}</p>
      )}
      {p.exploratory && !dense && <p className="mt-2 rounded-md border border-dashed border-ai px-3 py-2 text-ui-sm text-ink-2">◇ 这是讨论中的可能性，不构成作品事实。确认之前，它不会出现在你的设定里。</p>}
      {quote && (
        <blockquote className={`mt-2 border-l-2 pl-3 font-prose text-ui-sm ${quote.role === 'user' ? 'border-ink-4 text-ink-2' : 'border-ai text-ink-2'}`}>
          <span className="mr-1 text-micro text-ink-3">{quote.role === 'user' ? '你说' : 'AI 说'}</span>
          {quote.quote}
        </blockquote>
      )}
      {!dense &&
        p.evidence
          .filter((e) => e.quote && e !== quote)
          .map((e, i) => (
            <blockquote key={i} className={`mt-1.5 border-l-2 pl-3 font-prose text-ui-sm text-ink-2 ${e.role === 'user' ? 'border-ink-4' : 'border-ai'}`}>
              <span className="mr-1 text-micro text-ink-3">{e.role === 'user' ? '你说' : 'AI 说'}</span>
              {e.quote}
            </blockquote>
          ))}
      {p.source.sessionDeleted && <p className="mt-2 text-micro text-ink-3">来源会话已删除，原话已清除。</p>}
      {p.stale && pending && (
        <p role="status" className="mt-2 rounded-md bg-warn-soft px-3 py-1.5 text-ui-sm text-ink-2">
          这条设定在候选生成后被修改过，需要对照当前版本编辑后再确认。
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        {pending && (
          <>
            <Btn size="sm" variant="outline" disabled={busy || p.stale} onClick={onAccept}>
              <Icon name="check" className="h-3 w-3" />
              {revision ? '采纳新版本' : '确认'}
            </Btn>
            <Btn size="sm" disabled={busy} onClick={onReject}>
              {revision ? '保留原设定' : '否决'}
            </Btn>
            {p.operation !== 'LINK' && (
              <Btn size="sm" disabled={busy} onClick={onEdit}>
                <Icon name="edit" className="h-3 w-3" />
                {revision ? '自己改写' : '编辑'}
              </Btn>
            )}
          </>
        )}
        {onShowConversation && !p.source.sessionDeleted && (
          <Btn size="sm" onClick={onShowConversation}>
            <Icon name="quote" className="h-3 w-3" />
            回到对话
          </Btn>
        )}
      </div>
    </article>
  )
}
