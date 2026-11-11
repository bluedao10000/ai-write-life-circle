import { useEffect, useState, type ReactNode } from 'react'
import type { AnalysisFinding, NovelAnalysisJob, NovelAnalysisView, WorldEntity } from '@writer-agent/contracts'
import { analysisApi } from '../../services/api/analysisApi'
import { BOOK_NAV, type BookSection } from '../../components/vnext/BookView'
import { Btn, Dot, Field, Heading, Icon, Quote, Seg, Select } from '../../components/vnext/ui'
import { Disclosure, EmptyState, ListSkeleton } from '../knowledge/kit'

const POLL_MS = 3000
const jobLabel: Record<NovelAnalysisJob['status'], string> = {
  queued: '排队中', running: '分析中', paused: '已暂停', completed: '已完成', failed: '未完成', cancelled: '已取消',
}
const findingLabel: Record<AnalysisFinding['status'], string> = {
  proposed: '待确认', author_confirmed: '已确认', rejected: '已忽略', superseded: '已被替代', stale: '正文已改 · 需重跑',
}
const entityLabel: Record<WorldEntity['state'], string> = {
  observed: '正文观察', candidate: '候选', author_confirmed: '已确认', rejected: '已忽略', superseded: '已被替代',
}
const findingKind: Record<AnalysisFinding['kind'], string> = {
  character: '人物', place: '地点', event: '事件', rule: '规则', relationship: '关系', thread: '线索', timeline: '时间线', conflict: '冲突', continuity: '连续性',
}
const entityKind: Record<WorldEntity['kind'], string> = {
  character: '人物', place: '地点', faction: '组织', item: '物品', rule: '规则', event: '事件', thread: '线索',
}
type Category = 'all' | 'people' | 'plot' | 'world' | 'consistency'
const categories: { id: Category; label: string; kinds: AnalysisFinding['kind'][] }[] = [
  { id: 'all', label: '全部', kinds: [] },
  { id: 'people', label: '人物', kinds: ['character', 'relationship'] },
  { id: 'plot', label: '情节', kinds: ['event', 'thread', 'timeline'] },
  { id: 'world', label: '世界观', kinds: ['place', 'rule'] },
  { id: 'consistency', label: '一致性', kinds: ['conflict', 'continuity'] },
]
const errorText = (value: unknown) => value instanceof Error && value.message ? value.message : '整书分析请求失败，请稍后重试。'

type Props = {
  bookId: string
  bookTitle?: string
  chapters?: { id: string; title: string; no?: number; volume?: string }[]
  currentChapterId?: string
  onChapter: (id: string) => void
  onSection?: (section: BookSection) => void
  onBack?: () => void
  headerExtra?: ReactNode
}

function StateChip({ children, tone }: { children: ReactNode; tone: 'ok' | 'warn' | 'danger' | 'quiet' | 'ai' | 'conflict' }) {
  return <span className="inline-flex items-center gap-1.5 text-micro text-ink-3"><Dot tone={tone} />{children}</span>
}

export function AnalysisPanel({ bookId, bookTitle, chapters = [], currentChapterId, onChapter, onSection, onBack, headerExtra }: Props) {
  const [view, setView] = useState<NovelAnalysisView | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'findings' | 'world'>('findings')
  const [category, setCategory] = useState<Category>('all')
  const [review, setReview] = useState<'all' | 'pending'>('all')
  const [scope, setScope] = useState<'book' | 'volume' | 'chapter'>('book')
  const [targetChapter, setTargetChapter] = useState(currentChapterId ?? chapters[0]?.id ?? '')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setPhase('loading')
    analysisApi.view(bookId, controller.signal).then((next) => {
      if (!alive) return
      setView(next)
      setError('')
      setPhase('ready')
    }).catch((value) => {
      if (!alive || controller.signal.aborted) return
      setError(errorText(value))
      setPhase('error')
    })
    return () => { alive = false; controller.abort() }
  }, [bookId, refresh])

  const status = view?.job?.status
  useEffect(() => {
    if (status !== 'queued' && status !== 'running') return
    const abort = new AbortController()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      analysisApi.view(bookId, abort.signal).then((next) => {
        if (abort.signal.aborted) return
        setView(next)
        setError('')
      }).catch((value) => { if (!abort.signal.aborted) setError(errorText(value)) })
    }, POLL_MS)
    return () => { abort.abort(); window.clearInterval(timer) }
  }, [bookId, status])

  const act = async (run: () => Promise<NovelAnalysisView>) => {
    setBusy(true)
    setError('')
    try { setView(await run()) } catch (value) { setError(errorText(value)) } finally { setBusy(false) }
  }
  const job = view?.job ?? null
  const findings = view?.findings ?? []
  const entities = view?.entities ?? []
  const pending = findings.filter((finding) => finding.status === 'proposed').length
  const selectedCategory = categories.find((item) => item.id === category)!
  const shownFindings = findings.filter((finding) => (category === 'all' || selectedCategory.kinds.includes(finding.kind)) && (review === 'all' || finding.status === 'proposed'))
  const chapterName = (id: string) => {
    const chapter = chapters.find((item) => item.id === id)
    if (!chapter) return '来源章节已不在目录中'
    return chapter.no === undefined ? chapter.title : `第 ${chapter.no} 章${chapter.title ? ` · ${chapter.title.replace(/^第\s*\d+\s*章\s*/, '')}` : ''}`
  }
  const active = !!job && ['queued', 'running', 'paused'].includes(job.status)
  const currentVolume = chapters.find((chapter) => chapter.id === (currentChapterId ?? targetChapter))?.volume
  const volumeChapters = currentVolume ? chapters.filter((chapter) => chapter.volume === currentVolume) : []
  const scopeOptions: ['book' | 'volume' | 'chapter', string][] = [['book', '全书']]
  if (currentVolume) scopeOptions.push(['volume', '本卷'])
  scopeOptions.push(['chapter', '单章'])
  const canStart = !busy && !active && chapters.length > 0 && (scope === 'book' || (scope === 'volume' ? volumeChapters.length > 0 : chapters.some((chapter) => chapter.id === targetChapter)))
  const start = () => void act(() => scope === 'book' ? analysisApi.create(bookId) : analysisApi.create(bookId, scope === 'chapter' ? [targetChapter] : volumeChapters.map((chapter) => chapter.id)))
  const runningChapters = job?.batches.filter((batch) => batch.status === 'running' && batch.phase === 'chapters').flatMap((batch) => batch.chapterIds) ?? []
  const manifest = view?.manifest

  const findingCard = (finding: AnalysisFinding) => (
    <article key={finding.findingId} className="border-b border-line-soft py-6 first:pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-micro text-ink-3">{findingKind[finding.kind]}</span>
        <StateChip tone={finding.status === 'author_confirmed' ? 'ok' : finding.status === 'stale' ? 'warn' : finding.status === 'rejected' || finding.status === 'superseded' ? 'quiet' : finding.kind === 'conflict' ? 'conflict' : 'ai'}>
          {findingLabel[finding.status]}
        </StateChip>
      </div>
      <h3 className="mt-1.5 font-prose text-ui-lg font-medium text-ink">{finding.title}</h3>
      <p className="mt-2 whitespace-pre-wrap text-ui text-ink-2">{finding.statement}</p>
      {finding.alternativeExplanation && <p className="mt-2 border-l-2 border-dashed border-ai pl-3 text-ui-sm text-ink-3">另一种解释：{finding.alternativeExplanation}</p>}
      {finding.entityIds.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-1.5">
          {finding.entityIds.map((id) => {
            const entity = entities.find((item) => item.entityId === id)
            return entity ? <span key={id} className="rounded bg-surface-2 px-2 py-0.5 text-micro text-ink-2">{entity.name}</span> : null
          })}
        </p>
      )}
      <div className={`mt-4 grid gap-4 ${finding.kind === 'conflict' && finding.evidence.length > 1 ? 'sm:grid-cols-2' : ''}`}>
        {finding.evidence.map((evidence, index) => (
          <Quote key={`${evidence.chapterId}-${evidence.startUTF16}-${index}`} label={chapterName(evidence.chapterId)} state={finding.status === 'stale' ? 'stale' : 'ok'} tone={finding.kind === 'conflict' ? 'conflict' : 'quiet'} onOpen={() => onChapter(evidence.chapterId)}>
            {evidence.quote}
          </Quote>
        ))}
      </div>
      {finding.status === 'proposed' && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <Field label={`「${finding.title}」的审阅备注`} hideLabel value={notes[finding.findingId] ?? ''} onChange={(value) => setNotes((current) => ({ ...current, [finding.findingId]: value }))} placeholder="备注（可选）" maxLength={2000} disabled={busy} className="min-w-40 flex-1" />
          <Btn size="sm" variant="outline" disabled={busy} onClick={() => void act(() => analysisApi.decide(bookId, finding.findingId, 'confirm', notes[finding.findingId]))}><Icon name="check" className="h-3 w-3" />确认</Btn>
          <Btn size="sm" disabled={busy} onClick={() => void act(() => analysisApi.decide(bookId, finding.findingId, 'reject', notes[finding.findingId]))}>忽略</Btn>
        </div>
      )}
      {finding.authorNote && <p className="mt-3 text-ui-sm text-ink-3">你的备注：{finding.authorNote}</p>}
    </article>
  )

  const entityCard = (entity: WorldEntity) => (
    <article key={entity.entityId} className="border-b border-line-soft py-4">
      <StateChip tone={entity.state === 'author_confirmed' ? 'ok' : entity.state === 'candidate' ? 'ai' : 'quiet'}>{entityLabel[entity.state]}</StateChip>
      <h3 className="mt-1 font-prose text-ui-lg text-ink">{entity.name}</h3>
      {entity.aliases.length > 0 && <p className="mt-1 text-ui-sm text-ink-3">别名：{entity.aliases.join('、')}</p>}
      {entity.description && <p className="mt-2 whitespace-pre-wrap text-ui text-ink-2">{entity.description}</p>}
      {Object.keys(entity.attributes).length > 0 && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-sm">
          {Object.entries(entity.attributes).map(([key, value]) => <div key={key} className="contents"><dt className="text-ink-3">{key}</dt><dd className="min-w-0 break-words text-ink-2">{value}</dd></div>)}
        </dl>
      )}
      {entity.evidence.length > 0 && <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">{[...new Set(entity.evidence.map((item) => item.chapterId))].map((id) => <Btn key={id} variant="link" className="text-ui-sm" onClick={() => onChapter(id)}>{chapterName(id)}</Btn>)}</div>}
    </article>
  )

  return (
    <section aria-label="整书分析" className="scroll h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-6xl px-5 pt-6 pb-24 md:px-10 md:pt-10">
        <div className="flex flex-wrap items-center gap-3 text-ui-sm text-ink-3">
          {onBack && <Btn variant="link" className="text-ui-sm" onClick={onBack}><Icon name="back" className="h-3 w-3" />回到阅读</Btn>}
          <span className="min-w-0 truncate">{bookTitle || '当前作品'} <span aria-hidden className="mx-1 text-ink-4">/</span> 小说分析</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {headerExtra}
            {onSection && <div className="md:hidden"><Select label="书的分区" value="analysis" onChange={(value) => onSection(value as BookSection)} options={BOOK_NAV.map((item) => ({ value: item.id, label: item.label }))} /></div>}
          </div>
        </div>
        <header className="mt-7 border-b border-line pb-6">
          <p className="mb-2 text-micro tracking-wide text-ink-3">Writer Intelligence · 小说分析</p>
          <Heading level={1}>通读这部小说</Heading>
          <p className="mt-3 max-w-prose text-ui text-ink-3">从已保存的正文整理人物、情节、世界观与一致性，每条结果都附原文依据，由你逐条确认。</p>
        </header>
        {error && <div role="alert" className="mt-5 flex flex-wrap items-center gap-2 border-l-2 border-warn pl-3 text-ui-sm text-ink-2"><Icon name="alert" className="h-3.5 w-3.5 text-warn" />{error}<Btn variant="link" className="text-ui-sm" onClick={() => setRefresh((value) => value + 1)}>重新读取</Btn></div>}
        <div className="mt-8 grid gap-10 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-16">
          <div className="space-y-8">
            <section aria-label="分析范围">
              <Heading level={3} className="border-b border-line pb-3">分析范围</Heading>
              <div className="pt-4">
                {active ? <p className="text-ui text-ink-2">本次分析 · {manifest?.chapters.length ?? '—'} 章</p> : <Seg size="sm" label="分析范围" value={scope} onChange={setScope} options={scopeOptions} />}
                {!active && scope === 'chapter' && <div className="mt-3"><Select label="选择章节" value={targetChapter} onChange={setTargetChapter} options={[{ value: '', label: '选择一个章节' }, ...chapters.map((chapter) => ({ value: chapter.id, label: chapterName(chapter.id) }))]} /></div>}
                {!active && <p className="mt-3 text-ui-sm text-ink-2">{scope === 'book' ? `全部已保存章节 · 目录共 ${chapters.length} 章` : scope === 'volume' ? `${currentVolume ?? '当前卷暂无资料'} · ${volumeChapters.length} 章` : targetChapter ? chapterName(targetChapter) : '请选择要分析的章节'}</p>}
                <p className="mt-2 text-micro text-ink-3">正文按批次读取，空白章节由服务端跳过。</p>
                {manifest && <Disclosure className="mt-3" label={`本次分析的章节 · ${manifest.chapters.length}`}><ul className="max-h-64 space-y-1 overflow-auto">{manifest.chapters.map((chapter) => <li key={chapter.chapterId}><Btn variant="link" className="text-ui-sm" onClick={() => onChapter(chapter.chapterId)}>{chapterName(chapter.chapterId)}</Btn></li>)}</ul></Disclosure>}
              </div>
            </section>
            <section aria-label="分析任务">
              <Heading level={3} className="border-b border-line pb-3">任务</Heading>
              <div className="pt-4">
                {phase === 'loading' && !view ? <p className="text-ui-sm text-ink-3">正在读取分析状态…</p> : phase === 'error' && !view ? <Btn variant="outline" onClick={() => setRefresh((value) => value + 1)}>重试</Btn> : (
                  <>
                    {job && <div aria-label="分析进度">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm"><StateChip tone={job.status === 'completed' ? 'ok' : job.status === 'failed' || job.status === 'paused' ? 'warn' : job.status === 'cancelled' ? 'quiet' : 'ai'}>{jobLabel[job.status]}</StateChip><span className="tabular-nums text-ink-3">{job.progress.completed} / {job.progress.total} 批</span></div>
                      <div className="mt-3 h-0.5 overflow-hidden bg-line" role="progressbar" aria-label="整书分析完成度" aria-valuemin={0} aria-valuemax={Math.max(1, job.progress.total)} aria-valuenow={job.progress.completed}><div className="h-full bg-sand" style={{ width: job.progress.total > 0 ? `${(job.progress.completed / job.progress.total) * 100}%` : '0%' }} /></div>
                      <p className="mt-3 text-micro text-ink-3">已完成 {job.progress.completed} / {job.progress.total} 批 · 待处理 {job.progress.pending}{job.progress.failed > 0 ? ` · ${job.progress.failed} 批未完成` : ''}</p>
                      {runningChapters.length > 0 && <p className="mt-2 text-ui-sm text-ink-2">正在读取：{runningChapters.map(chapterName).join('、')}</p>}
                      {job.synthesisStatus === 'running' && <p className="mt-2 text-ui-sm text-ink-2">正在合并跨章观察与连续性结果。</p>}
                      {job.progress.stale > 0 && <p className="mt-3 border-l-2 border-warn pl-3 text-ui-sm text-ink-2">有 {job.progress.stale} 批正文已改动，相关依据需要重新分析。</p>}
                      <div className="mt-4 flex flex-wrap gap-2">
                        {(job.status === 'running' || job.status === 'queued') && <Btn size="sm" variant="outline" disabled={busy} onClick={() => void act(() => analysisApi.pause(bookId))}><Icon name="pause" />暂停</Btn>}
                        {job.status === 'paused' && <Btn size="sm" variant="outline" disabled={busy} onClick={() => void act(() => analysisApi.resume(bookId))}><Icon name="play" />继续</Btn>}
                        {job.status !== 'completed' && job.status !== 'cancelled' && <Btn size="sm" disabled={busy} onClick={() => void act(() => analysisApi.cancel(bookId))}>取消分析</Btn>}
                      </div>
                    </div>}
                    {!active && <Btn variant="primary" className={job ? 'mt-4' : ''} disabled={!canStart} onClick={start}><Icon name="layers" />{job ? '重新分析' : '开始整书分析'}</Btn>}
                    {chapters.length === 0 && <p className="mt-3 text-ui-sm text-ink-3">这本书还没有可分析的章节。</p>}
                    {job && <p className="mt-3 text-micro text-ink-3">最近更新：{new Date(job.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>}
                  </>
                )}
              </div>
            </section>
          </div>
          <div className="min-w-0">
            {phase === 'loading' && !view ? <ListSkeleton rows={3} /> : phase === 'error' && !view ? <EmptyState icon="alert" title="暂时无法读取整书分析" body="稍后重新读取，已保存的正文可继续阅读。" /> : !job ? (
              <div className="border-y border-dashed border-line py-16 text-center"><p className="font-prose text-read text-ink-2">还没有分析过这部小说。</p><p className="mx-auto mt-3 max-w-prose text-ui-sm text-ink-3">开始后，带原文依据的候选发现会随批次完成陆续出现。</p></div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3"><Seg label="整书分析视图" value={tab} onChange={setTab} options={[[ 'findings', `候选发现 ${findings.length}` ], [ 'world', `世界模型 ${entities.length}` ]]} /><span className="text-ui-sm text-ink-3">{pending > 0 ? `${pending} 条待确认` : job.status === 'completed' ? '整书分析完成' : jobLabel[job.status]}</span></div>
                {tab === 'findings' ? (
                  <>
                    <div className="scroll mt-4 overflow-x-auto"><Seg size="sm" label="分析结果分类" value={category} onChange={setCategory} options={categories.map((item) => [item.id, `${item.label} ${item.id === 'all' ? findings.length : findings.filter((finding) => item.kinds.includes(finding.kind)).length}`])} /></div>
                    <div className="mt-3 flex flex-wrap items-center gap-3"><Seg size="sm" label="分析结果状态" value={review} onChange={setReview} options={[[ 'all', '全部状态' ], [ 'pending', '待确认' ]]} /><span className="text-micro text-ink-3">AI 的阅读理解 · 经你确认后保存决定</span></div>
                    {shownFindings.length > 0 ? <div>{shownFindings.map(findingCard)}</div> : <p className="border-b border-line-soft py-12 text-ui text-ink-3">{review === 'pending' ? '这一类没有待确认的发现。' : job.status === 'queued' || job.status === 'running' ? '正在分析，候选发现会随批次完成陆续出现。' : '这次分析没有产出这一类候选发现。'}</p>}
                  </>
                ) : entities.length === 0 ? <p className="py-12 text-ui text-ink-3">还没有从正文观察到人物、地点或规则。</p> : <div className="space-y-7 pt-6">{(Object.keys(entityKind) as WorldEntity['kind'][]).map((kind) => {
                  const group = entities.filter((entity) => entity.kind === kind)
                  return group.length > 0 ? <section key={kind} aria-label={entityKind[kind]}><Heading level={3}>{entityKind[kind]} · {group.length}</Heading><div className="grid gap-x-8 sm:grid-cols-2">{group.map(entityCard)}</div></section> : null
                })}</div>}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
