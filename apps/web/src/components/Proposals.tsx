import { Fragment, useState } from "react"
import type { Chapter, KnowledgeEntry } from '@writer-agent/contracts'
import { kindMeta, type Decision, type Evidence, type Proposal } from '../types'
import type { DecideFn } from './ReviewPanel'
import { Btn, DemoBadge, Empty, EvidenceItem, KindTag, StatusTag, fmtTime } from './ui'

function Drawer({ title, onClose, children, width = 460 }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end" style={{ background: 'rgba(20,18,15,.18)' }} onClick={onClose}>
      <div role="dialog" aria-modal="true" className="slide-in flex h-full max-w-full flex-col border-l" style={{ width, background: 'var(--surface)', borderColor: 'var(--line)', boxShadow: 'var(--shadow)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-5" style={{ borderColor: 'var(--line)' }}>
          <div className="min-w-0 flex-1 truncate text-[13px]">{title}</div>
          <Btn small onClick={onClose} title="Esc">关闭</Btn>
        </div>
        <div className="scroll min-h-0 flex-1 overflow-auto px-5 py-5">{children}</div>
      </div>
    </div>
  )
}

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="mb-5">
    <div className="mb-1.5 text-[11px] font-medium tracking-wide" style={{ color: 'var(--ink-3)' }}>{k}</div>
    <div className="text-[13px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>{children}</div>
  </div>
)

export function ProposalDetail({ p, decisions, chapters, onClose, onDecide, onEvidence }: {
  p: Proposal; decisions: Decision[]; chapters: Chapter[]; onClose: () => void; onDecide: DecideFn; onEvidence: (e: Evidence) => void
}) {
  const [opt, setOpt] = useState(p.chosenOption ?? p.options[0]?.id)
  const ch = chapters.find((c) => c.id === p.chapterId)
  const last = decisions.filter((d) => d.by === '作者').at(-1)
  return (
    <Drawer onClose={onClose} title={<span className="flex items-center gap-2"><span className="font-mono text-[12px]" style={{ color: 'var(--ink-3)' }}>{p.id}</span><KindTag kind={p.kind} /><StatusTag status={p.status} /></span>}>
      <h2 className="font-prose text-[19px] font-semibold leading-snug" style={{ color: 'var(--ink)' }}>{p.title}</h2>
      <div className="mt-1 mb-5 flex items-center gap-2 text-[12px]" style={{ color: 'var(--ink-3)' }}>
        <span>{kindMeta[p.kind].hint}</span>·<span>来源：{p.origin}{ch && ` · ${ch.title}`}</span><DemoBadge />
      </div>
      <Row k="AI 分析">
        {p.analysis.facts.map((f) => <div key={f}><b className="mr-1.5 text-[11px]" style={{ color: 'var(--ink)' }}>事实</b>{f}</div>)}
        {p.analysis.inferences.map((f) => <div key={f}><b className="mr-1.5 text-[11px]" style={{ color: 'var(--warn)' }}>推测</b>{f}</div>)}
        <div><b className="mr-1.5 text-[11px]" style={{ color: 'var(--accent)' }}>建议</b>{p.analysis.suggestion}</div>
      </Row>
      <Row k="证据来源">
        <div className="space-y-2">{p.evidence.length ? p.evidence.map((e) => <EvidenceItem key={e.label} e={e} onOpen={onEvidence} />) : '无（来自作者讨论）'}</div>
      </Row>
      <Row k="影响范围"><div className="flex flex-wrap gap-1.5">{p.impact.map((i) => <span key={i} className="rounded px-2 py-0.5 text-[12px]" style={{ background: 'var(--surface-2)' }}>{i}</span>)}</div></Row>
      {p.options.length > 0 && (
        <Row k="候选方案（由你选择，Agent 不会执行）">
          <div className="space-y-2" role="radiogroup">
            {p.options.map((o) => (
              <label key={o.id} className="flex cursor-pointer gap-2.5 rounded-lg border p-3" style={{ borderColor: opt === o.id ? 'var(--ink-3)' : 'var(--line)' }}>
                <input type="radio" name="opt" checked={opt === o.id} onChange={() => setOpt(o.id)} className="mt-1 accent-[var(--ink)]" disabled={p.status !== 'pending'} />
                <span><span className="text-[13px]" style={{ color: 'var(--ink)' }}>{o.label}</span><br /><span className="text-[12px]">{o.detail}</span></span>
              </label>
            ))}
          </div>
        </Row>
      )}
      <Row k="作者决策">
        {last ? <>{last.action}{p.chosenOption && ` · ${p.options.find((o) => o.id === p.chosenOption)?.label}`}<span className="ml-2" style={{ color: 'var(--ink-3)' }}>{fmtTime(last.at)}</span></> : '尚未决定'}
      </Row>
      <Row k="决策记录">
        {decisions.length === 0 ? '暂无' : (
          <ol className="space-y-1.5 border-l pl-3" style={{ borderColor: 'var(--line)' }}>
            {decisions.map((d) => <li key={d.id} className="text-[12px]"><span style={{ color: 'var(--ink)' }}>{d.action}</span> · {d.by} · {fmtTime(d.at)}{d.note && <div style={{ color: 'var(--ink-3)' }}>{d.note}</div>}</li>)}
          </ol>
        )}
      </Row>
      <div className="sticky bottom-0 -mx-5 mt-2 flex flex-wrap gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        {p.status === 'pending' && p.kind !== 'research' && (
          <>
            <Btn variant="primary" onClick={() => onDecide(p.id, 'adopt', opt)}>采纳所选方案</Btn>
            <Btn variant="outline" onClick={() => onDecide(p.id, 'reject')}>拒绝</Btn>
            <Btn onClick={() => onDecide(p.id, 'defer')}>暂缓</Btn>
          </>
        )}
        {p.status === 'pending' && p.kind === 'research' && (
          <><Btn variant="outline" onClick={() => onDecide(p.id, 'note')}>标记为待整理参考</Btn><Btn onClick={() => onDecide(p.id, 'reject')}>忽略</Btn></>
        )}
        {p.status !== 'pending' && p.status !== 'resolved' && <Btn variant="outline" onClick={() => onDecide(p.id, 'reopen')}>撤回决定，重新待确认</Btn>}
        {p.status === 'resolved' && <span className="text-[12px]" style={{ color: 'var(--ok)' }}>复审确认：问题已不再出现。</span>}
      </div>
    </Drawer>
  )
}

export function KnowledgeViewer({ entryId, knowledge, onClose, onPick, unavailable = false }: { entryId: string | null; knowledge: KnowledgeEntry[]; onClose: () => void; onPick: (id: string | null) => void; unavailable?: boolean }) {
  const e = knowledge.find((k) => k.id === entryId)
  return (
    <Drawer onClose={onClose} width={400} title={e ? <span><span style={{ color: 'var(--ink-3)' }}>作品知识库 / {e.kind} / </span>{e.title}</span> : '作品知识库'}>
      {e ? (
        <>
          <div className="text-[11px]" style={{ color: 'var(--ink-3)' }}>{e.kind}</div>
          <h2 className="font-prose mt-1 text-[20px] font-semibold">{e.title}</h2>
          <p className="font-prose mt-3 whitespace-pre-line text-[14px] leading-loose" style={{ color: 'var(--ink)' }}>{e.body}</p>
          {e.fields && (
            <dl className="mt-4 grid grid-cols-[88px_1fr] gap-y-2 border-t pt-4 text-[12.5px]" style={{ borderColor: 'var(--line)' }}>
              {e.fields.map(([k, v]) => <Fragment key={k}><dt style={{ color: "var(--ink-3)" }}>{k}</dt><dd>{v}</dd></Fragment>)}
            </dl>
          )}
          <Btn small className="mt-6" onClick={() => onPick(null)}>← 全部条目</Btn>
        </>
      ) : unavailable ? (
        <Empty title="知识库 API 尚未接入" desc="当前 API 模式只读取 Workspace 与章节。知识库查询仍待后续 Sprint 实现。" />
      ) : knowledge.length === 0 ? (
        <Empty title="暂无知识条目" desc="这里不会用演示资料填充真实 Harness。" />
      ) : (
        <div className="space-y-1">
          {knowledge.map((k) => (
            <button key={k.id} type="button" onClick={() => onPick(k.id)} className="btn ghost flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px]">
              <span className="w-16 text-[11px]" style={{ color: 'var(--ink-3)' }}>{k.kind}</span>{k.title}
            </button>
          ))}
        </div>
      )}
    </Drawer>
  )
}

export function DecisionHistory({ proposals, decisions, onOpen }: { proposals: Proposal[]; decisions: Decision[]; onOpen: (id: string) => void }) {
  const [kind, setKind] = useState<'all' | Proposal['kind']>('all')
  const list = proposals.filter((p) => kind === 'all' || p.kind === kind)
  return (
    <div className="scroll min-h-0 flex-1 overflow-auto px-4 py-3">
      <div className="mb-2 flex gap-1 text-[12px]">
        {(['all', 'fact', 'suggestion', 'research'] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className="btn ghost rounded px-2 py-0.5" style={{ color: kind === k ? 'var(--ink)' : 'var(--ink-3)', fontWeight: kind === k ? 500 : 400 }}>
            {k === 'all' ? '全部' : kindMeta[k].label}
          </button>
        ))}
      </div>
      {list.length === 0 ? <Empty title="暂无提案" desc="审查结果和推演中保存的提案会集中在这里。" /> : (
        <div className="space-y-1.5">
          {list.map((p) => (
            <button key={p.id} type="button" onClick={() => onOpen(p.id)} className="btn block w-full rounded-lg border px-3 py-2.5 text-left hover:shadow-sm" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
              <div className="flex items-center gap-1.5"><span className="font-mono text-[10.5px]" style={{ color: 'var(--ink-3)' }}>{p.id}</span><KindTag kind={p.kind} /><span className="ml-auto"><StatusTag status={p.status} /></span></div>
              <div className="mt-1 truncate text-[13px]">{p.title}</div>
            </button>
          ))}
        </div>
      )}
      <div className="mt-6 mb-2 text-[11px] font-medium" style={{ color: 'var(--ink-3)' }}>决策日志</div>
      {decisions.length === 0 ? <div className="text-[12px]" style={{ color: 'var(--ink-3)' }}>尚无决策记录。</div> : (
        <ol className="space-y-2 border-l pl-3" style={{ borderColor: 'var(--line)' }}>
          {[...decisions].reverse().slice(0, 30).map((d) => (
            <li key={d.id} className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
              <span style={{ color: 'var(--ink)' }}>{d.action}</span> · <span className="font-mono">{d.proposalId}</span> · {d.by}
              <div className="text-[11px]" style={{ color: 'var(--ink-3)' }}>{fmtTime(d.at)}{d.note && ` · ${d.note}`}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
