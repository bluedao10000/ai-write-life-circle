import { useEffect, useState, type ReactNode } from 'react'
import type {
  AnalysisFinding,
  NovelAnalysisJob,
  NovelAnalysisView,
  WorldEntity,
} from '@writer-agent/contracts'
import { analysisApi } from '../../services/api/analysisApi'
import { BOOK_NAV, type BookSection } from '../../components/vnext/BookView'
import { Btn, Dot, Heading, Icon, Quote, Seg } from '../../components/vnext/ui'

const POLL_MS = 3000

const jobLabel: Record<NovelAnalysisJob['status'], string> = {
  queued: '排队中',
  running: '分析中',
  paused: '已暂停',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消',
}

const findingLabel: Record<AnalysisFinding['status'], string> = {
  proposed: '待确认',
  author_confirmed: '已确认',
  rejected: '已忽略',
  superseded: '已被替代',
  stale: '正文已改 · 需重跑',
}

const entityLabel: Record<WorldEntity['state'], string> = {
  observed: '正文观察',
  candidate: '候选',
  author_confirmed: '已确认',
  rejected: '已忽略',
  superseded: '已被替代',
}

const findingKind: Record<AnalysisFinding['kind'], string> = {
  character: '人物',
  place: '地点',
  event: '事件',
  rule: '规则',
  relationship: '关系',
  thread: '线索',
  timeline: '时间线',
  conflict: '冲突',
  continuity: '连续性',
}

const entityKind: Record<WorldEntity['kind'], string> = {
  character: '人物',
  place: '地点',
  faction: '组织',
  item: '物品',
  rule: '规则',
  event: '事件',
  thread: '线索',
}

const errorText = (value: unknown) =>
  value instanceof Error && value.message ? value.message : '整书分析请求失败，请稍后重试。'

const percent = (value: number) => `${Math.round(value * 100)}%`

type Props = {
  bookId: string
  bookTitle?: string
  chapters?: { id: string; title: string; no?: number }[]
  onChapter: (id: string) => void
  onSection?: (section: BookSection) => void
  headerExtra?: ReactNode
}

function StateChip({ children, tone }: { children: ReactNode; tone: 'ok' | 'warn' | 'danger' | 'quiet' | 'ai' }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line-soft px-2 py-0.5 text-micro text-ink-2">
      <Dot tone={tone} />
      {children}
    </span>
  )
}

export function AnalysisPanel({ bookId, bookTitle, chapters = [], onChapter, onSection, headerExtra }: Props) {
  const [view, setView] = useState<NovelAnalysisView | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'findings' | 'world'>('findings')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setPhase('loading')
    analysisApi
      .view(bookId, controller.signal)
      .then((next) => {
        if (!alive) return
        setView(next)
        setError('')
        setPhase('ready')
      })
      .catch((value) => {
        if (!alive || controller.signal.aborted) return
        setError(errorText(value))
        setPhase('error')
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [bookId, refresh])

  const status = view?.job?.status
  useEffect(() => {
    if (status !== 'queued' && status !== 'running') return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      analysisApi
        .view(bookId)
        .then((next) => {
          setView(next)
          setError('')
        })
        .catch((value) => setError(errorText(value)))
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [bookId, status])

  const act = async (run: () => Promise<NovelAnalysisView>) => {
    setBusy(true)
    setError('')
    try {
      setView(await run())
    } catch (value) {
      setError(errorText(value))
    } finally {
      setBusy(false)
    }
  }

  const job = view?.job ?? null
  const findings = view?.findings ?? []
  const entities = view?.entities ?? []
  const chapterName = (id: string) => {
    const chapter = chapters.find((item) => item.id === id)
    return chapter ? `第 ${chapter.no ?? '?'} 章${chapter.title ? ` · ${chapter.title}` : ''}` : id
  }
  const pending = findings.filter((finding) => finding.status === 'proposed').length

  const header = (
    <header className="border-b border-line-soft px-5 pt-5 pb-4 md:px-8 md:pt-7">
      <div className="mx-auto max-w-page">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-ui-sm text-ink-3">
            {bookTitle || '当前作品'} <span className="text-ink-4">/</span> 书
          </span>
          <div className="ml-auto flex items-center gap-2">
            {headerExtra}
            {onSection && (
              <select
                aria-label="书的分区"
                value="analysis"
                onChange={(event) => onSection(event.target.value as BookSection)}
                className="rounded border border-line-soft bg-paper p-2 text-ui-sm md:hidden"
              >
                {BOOK_NAV.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Heading level={1}>整书分析</Heading>
          {job && (
            <StateChip tone={job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'danger' : job.status === 'paused' ? 'warn' : 'ai'}>
              {jobLabel[job.status]}
            </StateChip>
          )}
          {pending > 0 && <span className="text-ui-sm text-ink-3">{pending} 条待确认</span>}
        </div>
        <p className="mt-1 text-ui text-ink-3">
          按章节分批读取已保存正文，先产出带原文依据的候选观察，再跨章合并。候选不会自动成为设定，只有你确认后才会。
        </p>
      </div>
    </header>
  )

  const progress = job && (
    <section aria-label="分析进度" className="rounded-lg border border-line-soft bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-ui font-medium text-ink">
          已完成 {job.progress.completed} / {job.progress.total} 批
        </p>
        <span className="text-ui-sm text-ink-3">
          进行中 {job.progress.running} · 待处理 {job.progress.pending} · 失败 {job.progress.failed}
          {job.progress.stale > 0 ? ` · 失效 ${job.progress.stale}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {(job.status === 'running' || job.status === 'queued') && (
            <Btn disabled={busy} onClick={() => void act(() => analysisApi.pause(bookId))}>
              <Icon name="pause" className="h-3 w-3" /> 暂停
            </Btn>
          )}
          {job.status === 'paused' && (
            <Btn disabled={busy} onClick={() => void act(() => analysisApi.resume(bookId))}>
              <Icon name="play" className="h-3 w-3" /> 继续
            </Btn>
          )}
          {job.status !== 'completed' && job.status !== 'cancelled' && (
            <Btn variant="danger-outline" disabled={busy} onClick={() => void act(() => analysisApi.cancel(bookId))}>
              取消分析
            </Btn>
          )}
        </div>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label="整书分析完成度"
        aria-valuemin={0}
        aria-valuemax={job.progress.total}
        aria-valuenow={job.progress.completed}
      >
        <div
          className="h-full rounded-full bg-ai"
          style={{ width: job.progress.total > 0 ? `${(job.progress.completed / job.progress.total) * 100}%` : '0%' }}
        />
      </div>
      {job.progress.stale > 0 && (
        <p className="mt-3 text-ui-sm text-ink-2">
          有章节在分析开始后改动，相关批次和依据已标记失效。重新开始分析会按最新正文生成新结果。
        </p>
      )}
    </section>
  )

  const findingCard = (finding: AnalysisFinding) => (
    <article key={finding.findingId} className="rounded-lg border border-line-soft bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-micro text-ink-2">{findingKind[finding.kind]}</span>
        <StateChip
          tone={
            finding.status === 'author_confirmed'
              ? 'ok'
              : finding.status === 'rejected'
                ? 'quiet'
                : finding.status === 'stale'
                  ? 'warn'
                  : 'ai'
          }
        >
          {findingLabel[finding.status]}
        </StateChip>
        <span className="text-micro text-ink-3">置信度 {percent(finding.confidence)}</span>
        <div className="ml-auto flex items-center gap-2">
          {finding.status === 'proposed' && (
            <>
              <Btn
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => void act(() => analysisApi.decide(bookId, finding.findingId, 'confirm'))}
              >
                确认
              </Btn>
              <Btn
                size="sm"
                disabled={busy}
                onClick={() => void act(() => analysisApi.decide(bookId, finding.findingId, 'reject'))}
              >
                忽略
              </Btn>
            </>
          )}
        </div>
      </div>
      <h3 className="mt-2 text-ui-lg font-medium text-ink">{finding.title}</h3>
      <p className="mt-1 whitespace-pre-wrap text-ui text-ink-2">{finding.statement}</p>
      {finding.alternativeExplanation && (
        <p className="mt-1 text-ui-sm text-ink-3">另一种解释：{finding.alternativeExplanation}</p>
      )}
      {finding.entityIds.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1.5">
          {finding.entityIds.map((id) => {
            const entity = entities.find((item) => item.entityId === id)
            return entity ? (
              <span key={id} className="rounded-full bg-surface-2 px-2 py-0.5 text-micro text-ink-2">
                {entity.name}
              </span>
            ) : null
          })}
        </p>
      )}
      <div className="mt-3 space-y-3">
        {finding.evidence.map((evidence, index) => (
          <Quote
            key={`${evidence.chapterId}-${evidence.startUTF16}-${index}`}
            label={chapterName(evidence.chapterId)}
            state={finding.status === 'stale' ? 'stale' : 'ok'}
            onOpen={() => onChapter(evidence.chapterId)}
          >
            {evidence.quote}
          </Quote>
        ))}
      </div>
      {finding.authorNote && <p className="mt-2 text-ui-sm text-ink-3">备注：{finding.authorNote}</p>}
    </article>
  )

  const entityCard = (entity: WorldEntity) => (
    <article key={entity.entityId} className="rounded-lg border border-line-soft bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-ui-lg font-medium text-ink">{entity.name}</h3>
        <StateChip
          tone={
            entity.state === 'author_confirmed'
              ? 'ok'
              : entity.state === 'rejected' || entity.state === 'superseded'
                ? 'quiet'
                : entity.state === 'candidate'
                  ? 'warn'
                  : 'ai'
          }
        >
          {entityLabel[entity.state]}
        </StateChip>
      </div>
      {entity.aliases.length > 0 && (
        <p className="mt-1 text-ui-sm text-ink-3">别名：{entity.aliases.join('、')}</p>
      )}
      {entity.description && <p className="mt-1 text-ui text-ink-2">{entity.description}</p>}
      {Object.keys(entity.attributes).length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-sm">
          {Object.entries(entity.attributes).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-ink-3">{key}</dt>
              <dd className="text-ink-2">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {entity.evidence.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {[...new Set(entity.evidence.map((item) => item.chapterId))].map((id) => (
            <Btn key={id} variant="link" size="sm" onClick={() => onChapter(id)}>
              {chapterName(id)}
            </Btn>
          ))}
        </div>
      )}
    </article>
  )

  return (
    <section aria-label="整书分析" className="relative flex h-full min-h-0">
      <div className="scroll min-w-0 flex-1 overflow-auto">
        {header}
        <div className="mx-auto max-w-page px-5 pt-6 pb-24 md:px-8">
          {error && (
            <p role="alert" className="mb-5 flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-ui-sm text-ink-2">
              <Icon name="alert" className="h-3.5 w-3.5 text-warn" />
              {error}
              <Btn variant="link" className="text-ui-sm" onClick={() => setRefresh((value) => value + 1)}>
                重试
              </Btn>
            </p>
          )}
          {phase === 'loading' && !view ? (
            <p className="text-ui text-ink-3">正在读取分析状态…</p>
          ) : phase === 'error' && !view ? (
            <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center">
              <p className="text-ui text-ink-2">暂时无法读取整书分析。</p>
              <Btn className="mt-3" onClick={() => setRefresh((value) => value + 1)}>
                重试
              </Btn>
            </div>
          ) : !job ? (
            <div className="rounded-lg border border-dashed border-line px-5 py-10 text-center">
              <p className="text-ui-lg font-medium text-ink">还没有分析过整本书</p>
              <p className="mx-auto mt-2 max-w-lg text-ui text-ink-3">
                分析会按章节分批读取已保存正文，不会一次发送整本书。每一批都限制在模型容量内，结果附原文引文，供你逐条确认或忽略。
              </p>
              <Btn
                className="mt-5"
                variant="primary"
                disabled={busy || chapters.length === 0}
                onClick={() => void act(() => analysisApi.create(bookId))}
              >
                开始整书分析
              </Btn>
              {chapters.length === 0 && <p className="mt-2 text-ui-sm text-ink-3">这本书还没有可分析的章节。</p>}
            </div>
          ) : (
            <div className="space-y-5">
              {progress}
              <div className="flex flex-wrap items-center gap-3">
                <Seg
                  label="整书分析视图"
                  value={tab}
                  onChange={setTab}
                  options={[
                    ['findings', `候选发现 ${findings.length}`],
                    ['world', `世界模型 ${entities.length}`],
                  ]}
                />
                {(job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') && (
                  <Btn
                    className="ml-auto"
                    size="sm"
                    disabled={busy || chapters.length === 0}
                    onClick={() => void act(() => analysisApi.create(bookId))}
                  >
                    重新分析
                  </Btn>
                )}
              </div>
              {tab === 'findings' ? (
                findings.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-ui text-ink-3">
                    {job.status === 'queued' || job.status === 'running'
                      ? '正在分析，候选发现会随批次完成陆续出现。'
                      : '这次分析没有产出候选发现。'}
                  </p>
                ) : (
                  <div className="space-y-3">{findings.map(findingCard)}</div>
                )
              ) : entities.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-ui text-ink-3">
                  还没有从正文观察到人物、地点或规则。
                </p>
              ) : (
                <div className="space-y-6">
                  {(Object.keys(entityKind) as WorldEntity['kind'][]).map((kind) => {
                    const group = entities.filter((entity) => entity.kind === kind)
                    if (group.length === 0) return null
                    return (
                      <section key={kind} aria-label={entityKind[kind]}>
                        <h2 className="mb-2 text-ui font-medium text-ink-2">
                          {entityKind[kind]} <span className="text-ink-3">{group.length}</span>
                        </h2>
                        <div className="grid gap-3 md:grid-cols-2">{group.map(entityCard)}</div>
                      </section>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
