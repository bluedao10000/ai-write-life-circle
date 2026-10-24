import { useState } from 'react'
import type { AgentTask, Evidence, Proposal } from '../types'
import { Btn, DemoBadge, Empty, EvidenceItem, KindTag, Kbd, StatusTag } from './ui'

export type DecideFn = (id: string, action: 'adopt' | 'reject' | 'defer' | 'note' | 'reopen', optionId?: string) => void

export function AgentStatus({ task, onRun, onCancel }: { task: AgentTask; onRun: () => void; onCancel: () => void }) {
  return (
    <div className="mx-4 mb-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
      {task.state === 'running' ? (
        <>
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            <span style={{ color: 'var(--ink)' }}>{task.name}</span>
            <Btn small onClick={onCancel} className="ml-auto">取消</Btn>
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: 'var(--ink-3)' }}>{task.step}</div>
          <div className="mt-2 h-1 rounded-full" style={{ background: 'var(--surface-2)' }}>
            <div className="h-1 rounded-full transition-all duration-300" style={{ width: `${task.progress}%`, background: 'var(--accent)' }} />
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 text-[12.5px]">
          {task.state === 'failed' && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--danger)' }} />}
          <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="true" role={task.state === 'failed' ? 'alert' : undefined}>
            {task.state === 'failed' ? (
              <span style={{ color: 'var(--danger)' }}>审查失败：{task.error}</span>
            ) : task.state === 'done' ? (
              <span style={{ color: 'var(--ink-2)' }}>{task.summary}</span>
            ) : (
              <span style={{ color: 'var(--ink-2)' }}>Agent 已就绪</span>
            )}
          </div>
          <Btn small variant="outline" onClick={onRun} title="⌘⇧R">{task.state === 'failed' ? '重试' : task.state === 'done' ? '重新审查' : '开始审查'}</Btn>
        </div>
      )}
    </div>
  )
}

export function ProposalCard({ p, active, onSelect, onDecide, onOpenDetail, onEvidence, onRerun }: {
  p: Proposal; active: boolean; onSelect: () => void; onDecide: DecideFn; onOpenDetail: () => void; onEvidence: (e: Evidence) => void; onRerun: () => void
}) {
  const [showEv, setShowEv] = useState(false)
  const stop = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f() }
  return (
    <div
      role="button" tabIndex={0} onClick={onSelect} onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      className="rounded-lg border p-3.5 transition"
      style={{ borderColor: active ? 'var(--ink-3)' : 'var(--line)', background: 'var(--surface)', boxShadow: active ? 'var(--shadow)' : undefined }}
    >
      <div className="flex items-center gap-1.5">
        <KindTag kind={p.kind} />
        {p.anchor && <span className="text-[11px]" style={{ color: 'var(--ink-3)' }}>¶ {p.anchor.paraIndex + 1}</span>}
        <span className="ml-auto"><StatusTag status={p.status} /></span>
      </div>
      <div className="mt-2 text-[13px] font-medium leading-snug">{p.title}</div>
      {active && (
        <div className="fade-up">
          <div className="mt-2 space-y-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
            {p.analysis.facts.map((f) => <div key={f}><span className="mr-1 text-[10.5px]" style={{ color: 'var(--ink)' }}>事实</span>{f}</div>)}
            {p.analysis.inferences.map((f) => <div key={f}><span className="mr-1 text-[10.5px]" style={{ color: 'var(--warn)' }}>推测</span>{f}</div>)}
            <div><span className="mr-1 text-[10.5px]" style={{ color: 'var(--accent)' }}>建议</span>{p.analysis.suggestion}</div>
          </div>
          {showEv && (
            <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
              {p.evidence.map((e) => <EvidenceItem key={e.label} e={e} onOpen={onEvidence} />)}
            </div>
          )}
          {p.status === 'adopted' && (
            <div className="mt-3 rounded-md px-3 py-2 text-[12px] leading-relaxed" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              已记录你的决定{p.chosenOption && `：${p.options.find((o) => o.id === p.chosenOption)?.label}`}。正文未被修改——请自行改写，完成后重新审查以确认是否解决。
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {p.status === 'pending' && p.kind !== 'research' && (
              <>
                <Btn small variant="primary" onClick={stop(() => (p.options.length > 1 ? onOpenDetail() : onDecide(p.id, 'adopt', p.options[0]?.id)))}>采纳建议</Btn>
                <Btn small variant="outline" onClick={stop(() => onDecide(p.id, 'reject'))}>拒绝</Btn>
                <Btn small onClick={stop(() => onDecide(p.id, 'defer'))}>暂缓</Btn>
              </>
            )}
            {p.status === 'pending' && p.kind === 'research' && (
              <>
                <Btn small variant="outline" onClick={stop(() => onDecide(p.id, 'note'))}>标记为待整理参考</Btn>
                <Btn small onClick={stop(() => onDecide(p.id, 'reject'))}>忽略</Btn>
              </>
            )}
            {p.status === 'adopted' && <Btn small variant="outline" onClick={stop(onRerun)}>我已修改，重新审查</Btn>}
            {(p.status === 'deferred' || p.status === 'rejected' || p.status === 'adopted') && <Btn small onClick={stop(() => onDecide(p.id, 'reopen'))}>撤回决定</Btn>}
            <Btn small onClick={stop(() => setShowEv(!showEv))}>{showEv ? '收起证据' : `查看证据 (${p.evidence.length})`}</Btn>
            <Btn small onClick={stop(onOpenDetail)} className="ml-auto">详情</Btn>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ReviewPanel({ task, proposals, activeId, onSelect, onDecide, onOpenDetail, onEvidence, onRun, onCancel }: {
  task: AgentTask; proposals: Proposal[]; activeId: string | null; onSelect: (id: string) => void; onDecide: DecideFn
  onOpenDetail: (id: string) => void; onEvidence: (e: Evidence) => void; onRun: () => void; onCancel: () => void
}) {
  const [filter, setFilter] = useState<'open' | 'all'>('open')
  const open = proposals.filter((p) => p.status === 'pending' || p.status === 'adopted')
  const list = filter === 'open' ? open : proposals
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="pt-3"><AgentStatus task={task} onRun={onRun} onCancel={onCancel} /></div>
      <div className="flex items-center gap-1 px-4 pb-2 text-[12px]">
        {(['open', 'all'] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className="btn ghost rounded px-2 py-0.5" style={{ color: filter === f ? 'var(--ink)' : 'var(--ink-3)', fontWeight: filter === f ? 500 : 400 }}>
            {f === 'open' ? '待处理' : '全部'}
          </button>
        ))}
        <span className="ml-auto"><DemoBadge /></span>
      </div>
      <div className="scroll min-h-0 flex-1 space-y-2.5 overflow-auto px-4 pb-4">
        {list.length === 0 ? (
          proposals.length === 0 ? (
            <Empty title="本章尚未审查" desc="Agent 会比对时间线、人物档案与伏笔库，只提出问题，不修改正文。" action={task.state !== 'running' && <Btn variant="outline" onClick={onRun}>开始审查 <Kbd>⌘⇧R</Kbd></Btn>} />
          ) : (
            <Empty title="没有待处理的问题" desc="切换到「全部」可查看已处理的提案。" />
          )
        ) : (
          list.map((p) => (
            <ProposalCard key={p.id} p={p} active={activeId === p.id} onSelect={() => onSelect(p.id)} onDecide={onDecide}
              onOpenDetail={() => onOpenDetail(p.id)} onEvidence={onEvidence} onRerun={onRun} />
          ))
        )}
        {list.length > 0 && <p className="pt-1 text-center text-[11px]" style={{ color: 'var(--ink-3)' }}>AI 没有正文写入权限 · 所有变更由你执行</p>}
      </div>
    </div>
  )
}
