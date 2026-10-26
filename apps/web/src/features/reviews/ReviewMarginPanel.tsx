import { useState } from 'react'
import type { AuthorNote, ReviewFeedback, ReviewFinding } from '@writer-agent/contracts'
import MarginPanel from '../../components/vnext/MarginPanel'
import { Btn, Dialog, Icon } from '../../components/vnext/ui'
import type { Margin, Source } from '../vnext/model'
import type { useReviewController } from './useReviewController'

const statuses = { queued: '排队中', running: '审查中', completed: '已完成', failed: '审查失败', cancelled: '已取消' }
export function ReviewMarginPanel({ review, locate, select, saveNote, marksHidden, setMarksHidden, emptyChapter, authorNotes = [], notesError, onAddNote, notesEnabled }: {
  authorNotes?: AuthorNote[]; notesError?: string; onAddNote?: () => void; notesEnabled?: boolean;
  review: ReturnType<typeof useReviewController>; locate: (id: string) => void; select: (id: string | null) => void;
  saveNote: (content: string) => Promise<string>; marksHidden: boolean; setMarksHidden: (value: boolean) => void; emptyChapter: boolean;
}) {
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [noteError, setNoteError] = useState('')
  const quota = review.allowance
  const exhausted = review.quotaExhausted
  const run = review.run
  const source = run?.sources.find((item) => item.sourceId === sourceId)
  const feedback: Record<string, ReviewFeedback['choice'] | undefined> = {}
  const margin = (finding: ReviewFinding): Margin => {
    feedback[finding.findingId] = finding.feedback?.choice
    return { id: finding.findingId, chapterId: run!.chapterId, para: 0, quote: finding.anchor.quote, tone: 'ai', title: finding.title,
      inference: finding.inference, question: finding.question, alternativeExplanation: finding.alternativeExplanation,
      locationLabel: finding.anchor.status === 'ambiguous' ? '原文匹配多处，暂不能定位' : '固定版本原文引用',
      state: review.stale ? 'stale' : 'fresh', facts: finding.evidence.map((evidence): Source => {
        const ref = run!.sources.find((item) => item.sourceId === evidence.sourceId)
        return { label: `${ref?.title ?? '来源'} · ${ref?.kind === 'confirmed_knowledge' ? '确认知识' : '正文快照'}`, quote: evidence.quote,
          chapterId: ref?.chapterId ?? undefined, entryId: ref?.documentId ?? undefined, reviewSourceId: evidence.sourceId,
          state: review.stale || ref?.freshness !== 'current' ? 'stale' : 'ok' }
      }),
    }
  }
  const all = run?.findings.map(margin) ?? []
  const live = all.filter((item) => feedback[item.id] !== 'ignored')
  const ignored = all.filter((item) => feedback[item.id] === 'ignored')
  return <div className="flex min-h-full flex-col">
    <section className="space-y-3 border-b border-line px-5 pb-4">
      <div className="flex items-center gap-2"><h2 className="flex-1 text-ui font-medium">本章连续性审查</h2><Btn size="sm" disabled={!!review.busy} onClick={review.refresh}>刷新记录</Btn></div>
      {!review.available && <p className="text-ui-sm text-ink-3">真实审查不可用：服务端尚未配置可用模型，或此后端不支持审查。历史记录仍可查看。</p>}
      <Btn size="sm" variant="outline" disabled={exhausted || !review.available || !!review.busy || emptyChapter || (run?.status === 'running' || run?.status === 'queued')} onClick={() => void review.prepare()}>{run?.status === 'completed' ? '重新审查' : '审查本章'}</Btn>
      {quota && !quota.unlimited && <p className="text-ui-sm text-ink-3">本月免费审查剩余 {quota.remaining} / {quota.limit} 次{quota.reserved > 0 ? `（${quota.reserved} 次已预留）` : ''}，{new Date(quota.resetsAt).toLocaleDateString('zh-CN', { timeZone: 'UTC' })}重置。{exhausted ? '可下月继续，或在账号方案中升级；已有结果仍可查看。' : '写作、阅读和保存不消耗 AI 点数。'}</p>}
      {review.runs.length > 0 && <label className="block text-ui-sm text-ink-3">审查记录<select aria-label="审查记录" className="mt-1 w-full rounded-md bg-surface-2 px-2 py-1.5 text-ui text-ink" value={run?.runId ?? ''} disabled={!!review.busy} onChange={(event) => void review.choose(event.target.value)}>{review.runs.map((item) => <option key={item.runId} value={item.runId}>{new Date(item.startedAt).toLocaleString('zh-CN')} · {statuses[item.status]}</option>)}</select></label>}
      {run && <p role="status" className="text-ui-sm text-ink-3">{statuses[run.status]}</p>}
      {(run?.status === 'running' || run?.status === 'queued') && <div className="rounded-lg border border-line p-3.5" aria-live="polite">
        <div className="flex items-center gap-2 text-ui text-ink"><span className="dot h-1.5 w-1.5 rounded-full bg-ai" aria-hidden />{statuses[run.status]}</div>
        <p className="mt-2 text-ui-sm text-ink-3">{run.status === 'queued' ? '正在等待后台审查。你可以继续写作，也可取消排队。' : '正在核对固定版本。你可以继续写作，结果完成后按需查看。'}</p>
        <Btn size="sm" variant="outline" className="mt-3" disabled={!!review.busy} onClick={() => void review.cancel()}>取消审查</Btn>
      </div>}
      {run?.status === 'failed' && <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger bg-danger-soft px-3.5 py-2.5 text-ui-sm text-ink"><Icon name="alert" className="mt-0.5 text-danger" /><span>审查未完成：{run.failureCode ?? '未知错误'}。正文和正式资料保持不变。</span></p>}
      {review.stale && <p role="alert" className="flex items-start gap-2 rounded-lg border border-warn bg-warn-soft px-3.5 py-2.5 text-ui-sm text-ink"><Icon name="clock" className="mt-0.5 text-warn" /><span>正文或历史证据已变化。这份结果基于旧快照，不能定位到当前正文；可以重新审查。</span></p>}
      {run?.status === 'completed' && run.findings.length === 0 && <p className="text-ui-sm text-ink-2">没有发现可证实的冲突。{run.rejectedCount ? '部分模型候选未通过引用核验，没有作为注记展示。' : '本次仅覆盖已确认的发送范围。'}</p>}
      {run && run.rejectedCount > 0 && <p className="text-micro text-ink-3">有 {run.rejectedCount} 项候选引用未通过核验。</p>}
      {(review.error || noteError) && <p role="alert" className="text-ui-sm text-warn">{review.error || noteError}</p>}
    </section>
    <section aria-label="作者注记" className="space-y-2 border-b border-line px-5 py-4">
      <div className="flex items-center justify-between"><h3>作者注记</h3><Btn size="sm" disabled={!notesEnabled} onClick={onAddNote}>添加注记</Btn></div>
      {notesError && <p role="alert" className="text-ui-sm text-warn">{notesError}</p>}
      {!authorNotes.length && <p className="text-ui-sm text-ink-3">本章还没有作者注记。</p>}
      {authorNotes.map((note) => <article key={note.noteId} className="rounded border border-line p-3 text-ui-sm"><p className="whitespace-pre-wrap break-words">{note.content}</p></article>)}
    </section>
    <MarginPanel margins={live} ignored={ignored} activeId={review.activeId} onSelect={select}
      onSource={(ref) => setSourceId(ref.reviewSourceId ?? null)} onIgnore={(id) => void review.feedback(id, 'ignored')} onRestore={() => {}}
      onNote={(item) => { setNoteError(''); void saveNote(`AI 推断（未经作者确认）：${item.title}\n${item.inference}\n其他可能解释：${item.alternativeExplanation ?? ''}\n作者问题：${item.question}\n审查记录：${run?.runId ?? ''}`).catch((e: unknown) => setNoteError(e instanceof Error ? e.message : '笔记保存失败')) }}
      onConflict={() => {}} onThink={() => {}} marksHidden={marksHidden} setMarksHidden={setMarksHidden} emptyChapter={emptyChapter}
      review={{ feedback, busy: !!review.busy, onFeedback: (id, choice) => void review.feedback(id, choice), onLocate: locate,
        locateDisabled: (id) => review.stale || review.finding(id)?.anchor.status !== 'unique' }} />
    {source && <Dialog title={source.title} label="审查证据快照" wide onClose={() => setSourceId(null)} actions={<Btn onClick={() => setSourceId(null)}>关闭证据</Btn>}>
      <p className="mb-3 text-ui-sm text-ink-3">{source.kind === 'confirmed_knowledge' ? '已确认知识' : '正文证据（叙述和角色认知不自动等于客观事实）'} · 审查时的只读快照{review.stale ? ' · 来源或正文已变化' : ''}</p>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-paper p-4 font-prose text-ui leading-relaxed" data-testid="review-source-snapshot">{source.excerpt}</pre>
      <p className="mt-3 break-all text-micro text-ink-3">{source.path}</p>
    </Dialog>}
  </div>
}
