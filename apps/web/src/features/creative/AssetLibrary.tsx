// 「书」中的创作资产 — layout from Figma Make BookView (header, filter, cards,
// detail drawer). Data comes from the creative API; pending CREATE proposals
// appear as candidates beside confirmed assets, always labelled by status.
import { Children, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CreativeAssetDetail, CreativeAssetSummary, CreativeKind, CreativeProposal } from '@writer-agent/contracts'
import { BOOK_NAV, type AssetSection, type BookSection } from '../../components/vnext/BookView'
import { Btn, Field, Heading, Icon, IconBtn, Row, Seg, Select, TextInput, ago } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import AssetEditor, { type EditorResult } from './AssetEditor'
import ManuscriptMatches from './ManuscriptMatches'
import ProposalList from './ProposalList'
import { DiffView, Disclosure, EmptyState, Facets, OriginTag, StatusTag, assetOrigin, assetStatus, kindsOf, proposalStatus, type DesignKind } from './kit'
import { creativeError, kindLabels, questionStatusLabels } from './labels'
import { useCreativeOverview } from './useCreativeOverview'

const designOf: Record<AssetSection, DesignKind> = { people: 'person', world: 'world', timeline: 'event', plot: 'plot', threads: 'thread' }
const meta: Record<AssetSection | 'inbox', { label: string; desc: string; search?: string }> = {
  people: { label: '人物', desc: '人物的身份、性格、欲望与动机，他们之间的关系，以及在故事里的变化。', search: '按名字、身份或特征查找' },
  world: { label: '世界观', desc: '规则、社会结构、地理、组织与文明体系。', search: '查找规则、地点或组织' },
  timeline: { label: '时间线', desc: '故事内的先后与因果。时间不确定的地方会如实标出，不会替你补上日期。', search: '查找事件' },
  plot: { label: '剧情结构', desc: '主线、支线与场景构想，以及还没想好的问题。想清楚的一幕，可以直接开始写。', search: '查找剧情或场景' },
  threads: { label: '伏笔', desc: '计划埋设与回收的伏笔。是否回收、何时回收，由你决定。', search: '查找伏笔' },
  inbox: { label: '待确认', desc: 'AI 从灵感对话整理出的候选与修改草案。你确认之前，它们都不是作品设定。', search: '查找待确认的内容' },
}
const originLabels: Record<string, string> = { author_create: '你创建', author_edit: '你修改', proposal_accept: '确认灵感候选', proposal_edit_accept: '编辑后确认灵感候选', status_change: '状态变更', dialogue_decision: '对话中的决定', dialogue_undo: '撤销对话中的决定' }
type Filter = 'all' | 'canon' | 'review'

export default function AssetLibrary({
  bookId,
  bookTitle,
  section,
  chapters,
  headerExtra,
  onSection,
  onDiscuss,
  onChapter,
  onSession,
}: {
  bookId: string
  bookTitle: string
  section: AssetSection | 'inbox'
  chapters: { id: string; title: string }[]
  headerExtra?: ReactNode
  onSection: (s: BookSection) => void
  onDiscuss: (seed: string) => void
  onChapter: (id: string) => void
  onSession: (sessionId: string, messageId: string) => void
}) {
  const m = meta[section]
  const kinds: CreativeKind[] = section === 'inbox' ? [] : kindsOf[designOf[section]]
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [f, setF] = useState<Filter>('all')
  const [items, setItems] = useState<CreativeAssetSummary[] | null>(null)
  const [candidates, setCandidates] = useState<CreativeProposal[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [trail, setTrail] = useState<string[]>([])
  const openAsset = (id: string) => { setTrail([]); setCandidate(null); setSelected(id) }
  const [candidate, setCandidate] = useState<CreativeProposal | null>(null)
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const [mobileNav, setMobileNav] = useState(false)
  const [assetNext, setAssetNext] = useState<number | null>(null)
  const [candidateNext, setCandidateNext] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const moreRequest = useRef<AbortController | null>(null)
  const { overview, refresh } = useCreativeOverview(bookId, true)
  const chapterTitle = useMemo(() => new Map(chapters.map((c) => [c.id, c.title])), [chapters])
  useEffect(() => {
    setQ('')
    setItems(null)
    setCandidates([])
    setAssetNext(null)
    setCandidateNext(null)
    setSelected(null)
    setCandidate(null)
    setAdding(false)
    setCreateError('')
  }, [section])
  useEffect(() => {
    const timer = window.setTimeout(() => setDq(q.trim()), 220)
    return () => window.clearTimeout(timer)
  }, [q])
  useEffect(() => {
    moreRequest.current?.abort()
    setLoadingMore(false)
    setMoreError('')
    if (section === 'inbox') return
    const abort = new AbortController()
    setError('')
    Promise.all([
      creativeApi.assets(bookId, { kind: kinds.join(','), q: dq, status: f === 'canon' ? 'accepted' : '', limit: 100 }, abort.signal),
      creativeApi.proposals(bookId, { status: 'proposed', limit: 100 }, abort.signal),
    ])
      .then(([page, pending]) => {
        if (abort.signal.aborted) return
        setItems(page.items.filter((a) => a.status !== 'archived' && a.status !== 'superseded'))
        setCandidates(pending.items.filter((p) => p.operation === 'CREATE' && kinds.includes(p.kind) && matchesProposal(p, dq)))
        setAssetNext(page.nextCursor)
        setCandidateNext(pending.nextCursor)
        setMoreError('')
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(creativeError(e))
      })
    return () => { abort.abort(); moreRequest.current?.abort() }
    // kinds derive from section
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, section, dq, f, tick])
  const reload = () => {
    setTick((n) => n + 1)
    refresh()
  }
  const loadMore = async () => {
    if (loadingMore) return
    const abort = new AbortController()
    moreRequest.current = abort
    setLoadingMore(true)
    setMoreError('')
    try {
      const [page, pending] = await Promise.all([
        assetNext !== null ? creativeApi.assets(bookId, { kind: kinds.join(','), q: dq, status: f === 'canon' ? 'accepted' : '', cursor: assetNext, limit: 100 }, abort.signal) : null,
        candidateNext !== null && f !== 'canon' ? creativeApi.proposals(bookId, { status: 'proposed', cursor: candidateNext, limit: 100 }, abort.signal) : null,
      ])
      if (abort.signal.aborted) return
      if (page) {
        setItems((all) => [...(all ?? []), ...page.items.filter((a) => a.status !== 'archived' && a.status !== 'superseded' && !all?.some((current) => current.assetId === a.assetId))])
        setAssetNext(page.nextCursor)
      }
      if (pending) {
        setCandidates((all) => [...all, ...pending.items.filter((p) => p.operation === 'CREATE' && kinds.includes(p.kind) && matchesProposal(p, dq) && !all.some((current) => current.proposalId === p.proposalId))])
        setCandidateNext(pending.nextCursor)
      }
    } catch (cause) { if (!abort.signal.aborted) setMoreError(creativeError(cause)) } finally { if (!abort.signal.aborted) setLoadingMore(false) }
  }
  const visible = (items ?? []).filter((a) => f !== 'review' || a.status === 'draft' || a.pendingProposals > 0)
  const shownCandidates = f === 'canon' ? [] : candidates
  // 人物 · 关系: asset→asset links between visible characters, read from asset details.
  const [peopleView, setPeopleView] = useState<'cards' | 'rels'>('cards')
  const [pairs, setPairs] = useState<{ key: string; a: CreativeAssetSummary; b: CreativeAssetSummary; label: string }[]>([])
  const [pairPhase, setPairPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [pairRetry, setPairRetry] = useState(0)
  const characterKey = section === 'people' ? visible.filter((a) => a.kind === 'character').map((a) => a.assetId + ':' + a.version).join(',') : ''
  useEffect(() => {
    if (peopleView !== 'rels' || !characterKey) {
      setPairs([])
      setPairPhase('idle')
      return
    }
    const abort = new AbortController()
    setPairPhase('loading')
    const people = visible.filter((a) => a.kind === 'character')
    const byId = new Map(people.map((a) => [a.assetId, a]))
    Promise.all(people.map((a) => creativeApi.asset(bookId, a.assetId, abort.signal)))
      .then((details) => {
        const seen = new Set<string>()
        const out: typeof pairs = []
        for (const d of details) {
          for (const l of d?.links ?? []) {
            const a = byId.get(l.fromAssetId)
            const b = l.to.type === 'asset' ? byId.get(l.to.id) : undefined
            const key = l.linkId
            if (!a || !b || l.status !== 'active' || seen.has(key)) continue
            seen.add(key)
            out.push({ key, a, b, label: l.relation })
          }
        }
        if (!abort.signal.aborted) { setPairs(out); setPairPhase('ready') }
      })
      .catch(() => { if (!abort.signal.aborted) setPairPhase('error') })
    return () => abort.abort()
    // visible is derived from characterKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, characterKey, peopleView, pairRetry])
  const nonEmptyKinds = kinds.filter((k) => visible.some((a) => a.kind === k) || shownCandidates.some((p) => p.kind === k)).length
  const counts = overview?.counts
  const sectionCount = (s: BookSection) => (s === 'inbox' ? overview?.pendingProposals : s in designOf && counts ? kindsOf[designOf[s as AssetSection]].reduce((n, k) => n + (counts[k]?.accepted ?? 0) + (counts[k]?.draft ?? 0), 0) : undefined)

  const header = (
    <header className="border-b border-line-soft px-5 pt-5 pb-4 md:px-8 md:pt-7">
      <div className="mx-auto max-w-page">
        <div className="flex min-h-7 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-ui-sm text-ink-3">
            {bookTitle} <span className="text-ink-4">/</span> 书
          </span>
          {headerExtra && <div className="ml-auto flex items-center gap-2">{headerExtra}</div>}
        </div>
        <div className="mt-3 md:hidden">
          <Btn variant="outline" className="w-full justify-between" onClick={() => setMobileNav(!mobileNav)} pressed={mobileNav}>
            <span className="flex items-center gap-2">
              <Icon name={BOOK_NAV.find((n) => n.id === section)?.icon ?? 'book'} />
              {m.label}
              {section !== 'inbox' && overview?.pendingProposals ? <span className="text-micro text-warn">· {overview.pendingProposals} 项待确认</span> : null}
            </span>
            <Icon name="chevronDown" className={mobileNav ? 'rotate-180' : ''} />
          </Btn>
          {mobileNav && (
            <ul className="mt-2 rounded-lg border border-line bg-surface p-1.5 shadow-soft">
              {BOOK_NAV.map((n) => (
                <li key={n.id}>
                  <Row active={n.id === section} onClick={() => { setMobileNav(false); onSection(n.id) }} className="flex items-center gap-2.5 px-3 py-2 text-ui">
                    <Icon name={n.icon} className={n.id === section ? 'text-accent' : 'text-ink-3'} />
                    <span>{n.label}</span>
                    <span className="ml-auto text-micro tabular-nums text-ink-3">{sectionCount(n.id) || ''}</span>
                  </Row>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Heading level={1}>{m.label}</Heading>
        </div>
        <p className="mt-1 text-ui text-ink-3">{m.desc}</p>
        {m.search && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <TextInput label={m.search} value={q} onChange={setQ} placeholder={m.search} className="w-full sm:max-w-xs" />
            {section !== 'inbox' && <Seg size="sm" label="按确认状态筛选" value={f} onChange={setF} options={[['all', '全部'], ['canon', '已确认'], ['review', '待确认']]} />}
            <span className="text-ui-sm text-ink-3" aria-live="polite">
              {q.trim() !== dq ? '筛选中…' : dq ? <>已筛选“{dq}” <Btn variant="link" className="text-ui-sm" onClick={() => setQ('')}>清除</Btn></> : null}
            </span>
            {section !== 'inbox' && (
              <Btn size="sm" variant="outline" className="ml-auto" onClick={() => setAdding(true)}>
                <Icon name="plus" />
                添加{m.label === '剧情结构' ? '剧情' : m.label}
              </Btn>
            )}
          </div>
        )}
      </div>
    </header>
  )

  let body: ReactNode
  if (section === 'inbox') {
    body = <ProposalList inbox q={dq} bookId={bookId} chapters={chapters} onDecided={refresh} onSession={onSession} onIdea={() => onDiscuss('')} />
  } else if (error) {
    body = (
      <div role="alert" className="rounded-xl border border-line px-6 py-10 text-center">
        <p className="text-ui-lg font-medium text-ink">这部分内容暂时没有读取成功</p>
        <p className="mx-auto mt-1.5 max-w-sm text-ui text-ink-3">{error} 你的设定没有丢失。</p>
        <div className="mt-5 flex justify-center gap-2">
          <Btn variant="outline" onClick={reload}>重试</Btn>
        </div>
      </div>
    )
  } else if (!items) {
    body = (
      <div className="space-y-3" aria-busy="true" aria-label="正在读取">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton h-16 rounded-lg" />)}
      </div>
    )
  } else if (!visible.length && !shownCandidates.length) {
    body = dq ? (
      <EmptyState icon="search" title={`没有找到与“${dq}”相关的${m.label}`} body="换一个关键词试试，或清除筛选。">
        <Btn variant="outline" onClick={() => setQ('')}>清除筛选</Btn>
      </EmptyState>
    ) : f !== 'all' ? (
      <EmptyState icon="layers" title={f === 'canon' ? `还没有已确认的${m.label}` : `没有待确认的${m.label}`} body="切换到“全部”可以看到其余内容。">
        <Btn variant="outline" onClick={() => setF('all')}>查看全部</Btn>
      </EmptyState>
    ) : (
      <EmptyState icon={BOOK_NAV.find((n) => n.id === section)?.icon ?? 'book'} title={`还没有${m.label}`} body="在「灵感」里聊聊你的故事，AI 会把讨论整理成候选，经你确认后出现在这里。也可以自己添加。">
        <Btn variant="primary" onClick={() => onDiscuss(`我想构思这部作品的${m.label}。`)}>
          <Icon name="think" />
          去灵感聊聊
        </Btn>
        <Btn variant="outline" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          添加{m.label}
        </Btn>
      </EmptyState>
    )
  } else if (section === 'timeline') {
    const chapterOrder = new Map(chapters.map((chapter, index) => [chapter.id, index]))
    const events = [...visible].sort((a, b) => (chapterOrder.get(a.plan?.chapterId ?? '') ?? Infinity) - (chapterOrder.get(b.plan?.chapterId ?? '') ?? Infinity))
    body = <>
      <p className="mb-5 text-micro text-ink-3">按计划章节排列，未锚定章节的事件列在后面。故事时间采用你填写的「时间」或「故事时间」属性。</p>
      <ol>
        {events.map((asset, index) => {
          const time = asset.fields.find((field) => field.key === '时间' || field.key === '故事时间')?.value
          return <li key={asset.assetId} className="relative pb-7 pl-7">
            {index < events.length - 1 && <span aria-hidden className="absolute top-4 bottom-0 left-1 w-px bg-line" />}
            <span aria-hidden className={`absolute top-1.5 left-0 h-2.5 w-2.5 rounded-full border-2 bg-paper ${time ? 'border-accent' : 'border-dashed border-ink-4'}`} />
            <p className="text-ui-sm text-ink-3">{time ?? '时间尚未确定'}</p>
            <Row active={selected === asset.assetId} onClick={() => { openAsset(asset.assetId) }} className="-mx-2 mt-0.5 flex flex-wrap items-center gap-2 px-2 py-1">
              <span className="min-w-0 flex-1 font-prose text-ui-lg text-ink">{asset.name}</span><StatusTag status={assetStatus(asset)} />
              {asset.pendingProposals > 0 && <span className="text-micro text-warn">有待确认的修改</span>}
            </Row>
            {asset.summary && <p className="mt-1 whitespace-pre-wrap text-ui text-ink-2">{asset.summary}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"><OriginTag origin={assetOrigin(asset)} />{asset.plan?.chapterId && <Btn variant="link" className="text-ui-sm" onClick={() => onChapter(asset.plan!.chapterId!)}>计划于 {chapterTitle.get(asset.plan.chapterId) ?? '已删除章节'}</Btn>}<Btn variant="link" className="text-ui-sm" onClick={() => { openAsset(asset.assetId) }}>查看详情与关联</Btn></div>
          </li>
        })}
      </ol>
      {shownCandidates.length > 0 && <Group title="候选事件" count={shownCandidates.length}>{shownCandidates.map((proposal) => <CandidateCard key={proposal.proposalId} proposal={proposal} active={candidate?.proposalId === proposal.proposalId} onOpen={() => { setSelected(null); setCandidate(proposal) }} />)}</Group>}
    </>
  } else if (section === 'people' && peopleView === 'rels') {
    body = (
      <>
        <div className="mb-4"><Seg size="sm" label="人物视图" value={peopleView} onChange={setPeopleView} options={[['cards', '档案'], ['rels', pairPhase === 'ready' ? `关系 · ${pairs.length}` : '关系']]} /></div>
        {pairPhase === 'loading' ? <p aria-busy="true" className="py-8 text-ui text-ink-3">正在读取人物关联…</p> : pairPhase === 'error' ? <div role="alert" className="py-8 text-ui text-ink-3"><p>人物关联暂时无法读取。</p><Btn variant="outline" className="mt-3" onClick={() => setPairRetry((value) => value + 1)}>重试</Btn></div> : pairs.length ? (
          <ul className="divide-y divide-line-soft rounded-lg border border-line-soft">
            {pairs.map(({ key, a, b, label }) => (
              <li key={key} className="flex items-center gap-3 px-4 py-3">
                <Btn variant="link" className="font-prose text-ui-lg text-ink" onClick={() => setSelected(a.assetId)}>{a.name}</Btn>
                <span aria-hidden className="h-px min-w-4 flex-1 bg-line" />
                <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-0.5 text-ui-sm text-ink-2">{label}</span>
                <span aria-hidden className="h-px min-w-4 flex-1 bg-line" />
                <Btn variant="link" className="font-prose text-ui-lg text-ink" onClick={() => setSelected(b.assetId)}>{b.name}</Btn>
                {(a.status !== 'accepted' || b.status !== 'accepted') && <span className="text-micro text-warn">含待确认</span>}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="users" title="人物之间还没有记录关系" body="在人物详情里添加关联，或去灵感里聊聊他们之间发生过什么。" />
        )}
      </>
    )
  } else {
    body = (
      <>
        {section === 'people' && <div className="mb-4"><Seg size="sm" label="人物视图" value={peopleView} onChange={setPeopleView} options={[['cards', '档案'], ['rels', pairPhase === 'ready' ? `关系 · ${pairs.length}` : '关系']]} /></div>}
        {kinds.map((k) => {
          const list = visible.filter((a) => a.kind === k)
          const cands = shownCandidates.filter((p) => p.kind === k)
          if (!list.length && !cands.length) return null
          return (
            <Group key={k} title={kindLabels[k]} count={list.length + cands.length} single={nonEmptyKinds <= 1}>
              {list.map((a) => (
                <article key={a.assetId} className={`overflow-hidden rounded-lg border ${selected === a.assetId ? 'border-accent/40 bg-accent-soft/40' : 'border-line-soft'}`}>
                <Row active={selected === a.assetId} onClick={() => { openAsset(a.assetId) }} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-prose text-ui-lg text-ink">{a.name}</span>
                    <StatusTag status={assetStatus(a)} />
                    {a.pendingProposals > 0 && <span className="text-micro text-warn">有待确认的修改</span>}
                    <span className="ml-auto">
                      <OriginTag origin={assetOrigin(a)} />
                    </span>
                  </div>
                  {a.summary && <p className="mt-1 line-clamp-2 text-ui text-ink-2">{a.summary}</p>}
                  {a.fields.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {a.fields.slice(0, 3).map((x) => (
                        <li key={x.key} className="line-clamp-1 text-ui-sm text-ink-3">
                          <span className="text-ink-3">{x.key}</span>{'\u3000'}{x.value}
                        </li>
                      ))}
                    </ul>
                  )}
                  {a.kind === 'open_question' && <p className="mt-2 text-micro text-ink-3">{questionStatusLabels[a.questionStatus ?? 'pending']}</p>}
                  {a.plan?.chapterId && <p className="mt-2 text-micro text-ink-3">计划于 {chapterTitle.get(a.plan.chapterId) ?? '已删除章节'}</p>}
                  {a.plan?.payoffChapterId && <p className="mt-1 text-micro text-ink-3">计划回收于 {chapterTitle.get(a.plan.payoffChapterId) ?? '已删除章节'}</p>}
                </Row>
                {(section === 'plot' || section === 'threads') && <div className="flex flex-wrap items-center gap-2 px-4 pb-3"><Btn size="sm" onClick={() => onDiscuss(`关于「${a.name}」，我想继续讨论：`)}><Icon name="think" className="h-3 w-3" />继续讨论</Btn>{a.plan?.chapterId && <Btn size="sm" variant="link" className="ml-auto text-ui-sm" onClick={() => onChapter(a.plan!.chapterId!)}>打开计划章节</Btn>}</div>}
                </article>
              ))}
              {cands.map((proposal) => <CandidateCard key={proposal.proposalId} proposal={proposal} active={candidate?.proposalId === proposal.proposalId} onOpen={() => { setSelected(null); setCandidate(proposal) }} />)}
            </Group>
          )
        })}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="scroll min-w-0 flex-1 overflow-auto">
        {header}
        <div className="mx-auto max-w-page px-5 pt-6 pb-24 md:px-8">
          {section === 'threads' && items && visible.length > 0 && <p className="mb-5 border-l-2 border-sand pl-3 text-ui-sm text-ink-3">这里记录埋设与回收的创作计划，是否已在正文发生，由你判断。</p>}
          {body}
          {moreError && <p role="alert" className="mt-4 text-ui-sm text-warn">{moreError}</p>}
          {section !== 'inbox' && !error && items && (assetNext !== null || (f !== 'canon' && candidateNext !== null)) && <div className="mt-6 text-center"><Btn variant="outline" size="sm" loading={loadingMore} onClick={() => void loadMore()}>继续载入设定与候选</Btn><p className="mt-2 text-micro text-ink-3">当前显示已载入且符合筛选的内容。</p></div>}
        </div>
      </div>
      {(selected || candidate) && (
        <>
          <div className="fade fixed inset-0 z-40 bg-scrim xl:hidden" onClick={() => { setSelected(null); setCandidate(null) }} aria-hidden />
          <aside aria-label="设定详情" className="slide-r fixed inset-y-0 right-0 z-50 w-full border-l border-line-soft shadow-soft sm:max-w-drawer xl:static xl:z-auto xl:w-(--container-drawer) xl:shrink-0 xl:shadow-none">
            {selected ? (
              <AssetDrawer key={selected} bookId={bookId} id={selected} chapters={chapters} chapterTitle={chapterTitle} onClose={() => { setSelected(null); setTrail([]) }} onAsset={(id) => { setTrail((all) => [...all, selected]); setSelected(id) }} onBack={trail.length ? () => { setSelected(trail[trail.length - 1]); setTrail((all) => all.slice(0, -1)) } : undefined} onChanged={reload} onDiscuss={onDiscuss} onChapter={onChapter} onSession={onSession} />
            ) : candidate ? (
              <div className="flex h-full min-h-0 flex-col bg-surface">
                <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-5 py-3">
                  <span className="min-w-0 truncate text-ui-sm text-ink-3">{kindLabels[candidate.kind]} · 候选</span>
                  <IconBtn icon="x" label="关闭详情" onClick={() => setCandidate(null)} className="ml-auto" />
                </div>
                <div className="scroll min-h-0 flex-1 overflow-auto px-5 pt-5 pb-16">
                  <ProposalList bookId={bookId} chapters={chapters} onSession={onSession} onDecided={() => { setCandidate(null); reload() }} only={candidate.proposalId} />
                </div>
              </div>
            ) : null}
          </aside>
        </>
      )}
      {adding && section !== 'inbox' && (
        <AssetEditor
          title={`新建${m.label}`}
          kind={kinds[0]}
          kindLocked={kinds.length === 1}
          kinds={kinds}
          showStatus
          chapters={chapters}
          error={createError}
          busy={creating}
          note="作者创建的设定直接成为作品设定；也可以先存为草稿。"
          submitLabel="保存"
          onClose={() => { if (!creating) { setAdding(false); setCreateError('') } }}
          onSubmit={async (v: EditorResult) => {
            if (creating) return
            setCreating(true)
            setCreateError('')
            try {
              const created = await creativeApi.createAsset(bookId, { kind: v.kind, content: v.content, status: v.status })
              setAdding(false)
              openAsset(created.assetId)
              reload()
            } catch (e) {
              setCreateError(creativeError(e))
            } finally {
              setCreating(false)
            }
          }}
        />
      )}
    </div>
  )
}

function matchesProposal(proposal: CreativeProposal, query: string) {
  const content = proposal.result ?? proposal.draft
  return !query || [content?.name, content?.summary, ...(content?.aliases ?? []), ...(content?.fields.map((field) => `${field.key} ${field.value}`) ?? [])].some((value) => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
}

function CandidateCard({ proposal, active, onOpen }: { proposal: CreativeProposal; active: boolean; onOpen: () => void }) {
  const content = proposal.result ?? proposal.draft
  return <Row active={active} onClick={onOpen} className={`block w-full rounded-lg border px-4 py-3 text-left ${active ? 'border-accent/40 bg-accent-soft/40' : proposal.exploratory ? 'border-dashed border-line' : 'border-line-soft'}`}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="font-prose text-ui-lg text-ink">{content?.name ?? '新的候选'}</span><StatusTag status={proposalStatus(proposal)} /><span className="ml-auto"><OriginTag origin="idea" /></span></div>
    {content?.summary && <p className="mt-1 line-clamp-2 text-ui text-ink-2">{content.summary}</p>}
  </Row>
}

function Group({ title, count, children, single }: { title: string; count: number; children: ReactNode; single?: boolean }) {
  const [open, setOpen] = useState(true)
  if (!count) return null
  if (single) return <ul className="space-y-2">{Children.map(children, (c) => (c ? <li>{c}</li> : null))}</ul>
  return (
    <section className="mb-7">
      <Btn variant="quiet" size="sm" className="-ml-2 mb-2" onClick={() => setOpen(!open)} pressed={open}>
        <Icon name="chevron" className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="font-medium text-ink-2">{title}</span>
        <span className="tabular-nums text-ink-3">{count}</span>
      </Btn>
      {open && <div className="space-y-2">{children}</div>}
    </section>
  )
}

export function AssetDrawer({
  bookId,
  id,
  chapters,
  chapterTitle,
  onClose,
  onChanged,
  onDiscuss,
  onChapter,
  onSession,
  onAsset,
  onBack,
}: {
  bookId: string
  id: string
  chapters: { id: string; title: string }[]
  chapterTitle: Map<string, string>
  onClose: () => void
  onChanged: () => void
  onDiscuss: (seed: string) => void
  onChapter: (id: string) => void
  onSession: (sessionId: string, messageId: string) => void
  onAsset?: (id: string) => void
  onBack?: () => void
}) {
  const [detail, setDetail] = useState<CreativeAssetDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState(false)
  const [tick, setTick] = useState(0)
  const [others, setOthers] = useState<CreativeAssetSummary[]>([])
  const [linkTarget, setLinkTarget] = useState('')
  const [relation, setRelation] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    setError('')
    creativeApi.asset(bookId, id, abort.signal).then((next) => { if (!abort.signal.aborted) setDetail(next) }).catch((e: unknown) => !abort.signal.aborted && setError(creativeError(e)))
    creativeApi.assets(bookId, { limit: 100 }, abort.signal).then((p) => { if (!abort.signal.aborted) setOthers(p.items.filter((asset) => asset.assetId !== id && asset.status !== 'archived' && asset.status !== 'superseded')) }).catch(() => { if (!abort.signal.aborted) setOthers([]) })
    return () => abort.abort()
  }, [bookId, id, tick])
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !edit && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [edit, onClose])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      setTick((n) => n + 1)
      onChanged()
      return true
    } catch (e) {
      setError(creativeError(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const a = detail?.asset
  const source = detail?.versions.find((v) => v.source)?.source
  const pending = detail?.proposals.filter((p) => p.status === 'proposed') ?? []
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-5 py-3">
        {onBack && <IconBtn icon="back" label="返回上一条设定" onClick={onBack} />}
        <span className="min-w-0 truncate text-ui-sm text-ink-3">{a ? kindLabels[a.kind] : '设定'}</span>
        <IconBtn icon="x" label="关闭详情" onClick={onClose} className="ml-auto" />
      </div>
      <div className="scroll min-h-0 flex-1 overflow-auto px-5 pt-5 pb-16">
        {error && (
          <p role="alert" className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-ui-sm text-danger">
            {error}
          </p>
        )}
        {!a || !detail ? (
          error ? <Btn variant="outline" onClick={() => setTick((value) => value + 1)}>重新读取详情</Btn> : <div aria-busy="true" aria-label="正在读取设定详情" className="space-y-3"><div className="skeleton h-5 w-2/3" /><div className="skeleton h-3 w-full" /><div className="skeleton h-3 w-5/6" /></div>
        ) : (
          <article aria-label={`设定：${a.name}`}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusTag status={assetStatus(a)} />
              <OriginTag origin={assetOrigin(a)} />
              <span className="text-micro text-ink-3">版本 {a.version}</span>
              {a.kind === 'open_question' && <span className="text-micro text-ink-3">{questionStatusLabels[a.questionStatus ?? 'pending']}</span>}
            </div>
            <Heading level={1} className="mt-2 break-words">
              {a.name}
            </Heading>
            {(a.aliases.length > 0 || a.plan) && (
              <p className="mt-1 text-ui-sm text-ink-3">
                {a.aliases.length > 0 && `别名：${a.aliases.join('、')}`}
                {a.plan?.chapterId && ` · 计划于 ${chapterTitle.get(a.plan.chapterId) ?? '已删除章节'}`}
                {a.plan?.payoffChapterId && ` · 计划于 ${chapterTitle.get(a.plan.payoffChapterId) ?? '已删除章节'} 回收`}
              </p>
            )}
            {a.summary && <p className="mt-3 font-prose text-read whitespace-pre-wrap text-ink-2">{a.summary}</p>}
            {a.plan && <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-ui-sm text-ink-2">这是规划，表示作者意图，不代表正文已经发生。</p>}
            {pending.map((p) => (
              <section key={p.proposalId} className={`mt-6 rounded-lg border p-4 ${p.operation === 'SUPERSEDE' ? 'border-conflict/40 bg-conflict-soft' : 'border-line-soft bg-paper'}`}>
                <div className="flex flex-wrap items-center gap-2 text-ui-sm">
                  <span className={p.operation === 'SUPERSEDE' ? 'font-medium text-conflict' : 'font-medium text-ink'}>{p.operation === 'SUPERSEDE' ? '与已确认设定存在冲突' : '有一个待定的新版本'}</span>
                  <span className="text-ink-3">· 来自灵感对话 · {ago(Date.parse(p.createdAt) || Date.now())}</span>
                </div>
                <p className="mt-1 text-ui-sm text-ink-2">{p.reason || '来自本轮讨论'}。在你决定之前，「书」中仍以当前版本为准。</p>
                {p.result && <div className="mt-3"><DiffView before={a} after={p.result} labels={['已确认的版本', '新版本 · 灵感对话']} /></div>}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Btn size="sm" variant="primary" disabled={busy || p.stale} onClick={() => void run(() => creativeApi.decide(bookId, [{ proposalId: p.proposalId, action: 'accept' }]))}>采纳新版本</Btn>
                  <Btn size="sm" variant="outline" disabled={busy} onClick={() => void run(() => creativeApi.decide(bookId, [{ proposalId: p.proposalId, action: 'reject' }]))}>保留原设定</Btn>
                  <Btn size="sm" onClick={() => onSession(p.source.sessionId, p.source.messageId)}>回到对话</Btn>
                </div>
                {p.stale && <p className="mt-2 text-micro text-warn">设定已在别处修改，请在「待确认」中编辑后确认。</p>}
              </section>
            ))}
            {a.fields.length > 0 && (
              <section className="mt-8">
                <Heading level={3} className="mb-3">
                  {{ story_intent: '作品方向', character: '人物档案', character_arc: '人物轨迹', event: '事件', plot_line: '剧情结构', foreshadowing: '伏笔计划', open_question: '问题' }[a.kind as string] ?? '设定'}
                </Heading>
                <Facets fields={a.fields} />
              </section>
            )}
            <section className="mt-8">
              <Heading level={3} className="mb-2">查看关联</Heading>
              {!detail.links.length && <p className="text-ui-sm text-ink-3">还没有关联的人物、剧情或事件。</p>}
              <ul>
                {detail.links.map((l) => (
                  <li key={l.linkId} className="flex items-center gap-2 py-1 text-ui">
                    <span className="w-24 shrink-0 text-ink-3">{l.relation}</span>
                    {l.to.type === 'chapter' ? (
                      <Btn variant="link" onClick={() => onChapter(l.to.id)}>{chapterTitle.get(l.to.id) ?? '章节'}</Btn>
                    ) : onAsset && (l.to.type === 'asset' || l.fromAssetId !== a.assetId) ? (
                      <Btn variant="link" className="min-w-0 truncate text-ui" onClick={() => onAsset(l.fromAssetId === a.assetId ? l.to.id : l.fromAssetId)}>{l.fromAssetId === a.assetId ? l.toName || '关联设定' : l.fromName || '关联设定'}</Btn>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-ink">{l.fromAssetId === a.assetId ? l.toName || (l.to.type === 'knowledge_entity' ? '正文观察条目' : '关联设定') : l.fromName || '关联设定'}</span>
                    )}
                    <IconBtn size="sm" icon="x" label={`移除关联 ${l.relation}`} className="ml-auto" disabled={busy} onClick={() => void run(() => creativeApi.removeLink(bookId, l.linkId))} />
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Select label="关联到" value={linkTarget} onChange={setLinkTarget} options={[{ value: '', label: '选择设定或章节' }, ...others.map((x) => ({ value: 'asset:' + x.assetId, label: `${kindLabels[x.kind]} · ${x.name}` })), ...chapters.map((c) => ({ value: 'chapter:' + c.id, label: `章节 · ${c.title}` }))]} />
                <Field label="关系" hideLabel placeholder="关系，如：师徒" maxLength={40} value={relation} onChange={setRelation} disabled={busy} className="w-36" />
                <Btn
                  size="sm"
                  disabled={busy || !linkTarget || !relation.trim()}
                  onClick={() => {
                    const [type, target] = linkTarget.split(/:(.*)/s) as ['asset' | 'chapter', string]
                    void run(() => creativeApi.link(bookId, { fromAssetId: a.assetId, to: { type, id: target }, relation: relation.trim() })).then((ok) => {
                      if (ok) {
                        setLinkTarget('')
                        setRelation('')
                      }
                    })
                  }}
                >
                  添加关联
                </Btn>
              </div>
              {a.plan?.chapterId ? (
                <p className="mt-3 text-ui-sm text-ink-3">
                  相关章节 <Btn variant="link" className="text-ui-sm" onClick={() => onChapter(a.plan!.chapterId!)}>{chapterTitle.get(a.plan.chapterId) ?? '章节'}</Btn>
                </p>
              ) : (
                <p className="mt-3 text-ui-sm text-ink-3">尚未写入正文——设定可以先于正文存在。</p>
              )}
            </section>
            <div className="mt-8">
              <ManuscriptMatches bookId={bookId} asset={a} links={detail.links} busy={busy} onLink={(entityId) => void run(() => creativeApi.link(bookId, { fromAssetId: a.assetId, to: { type: 'knowledge_entity', id: entityId }, relation: '正文对应' }))} />
            </div>
            <section className="mt-8">
              <Heading level={3} className="mb-3">来源</Heading>
              {source ? (
                <div className="rounded-lg border border-line-soft bg-paper px-3.5 py-3">
                  <div className="flex items-center gap-1.5 text-micro text-ink-3">
                    <Icon name="think" className="h-3 w-3" />
                    灵感对话 · {ago(Date.parse(source.capturedAt) || Date.now())} · {source.model.model}
                  </div>
                  {detail.versions.flatMap((v) => v.evidence).filter((e) => e.quote).slice(0, 2).map((e, i) => (
                    <p key={i} className="mt-1 line-clamp-2 font-prose text-ui-sm text-ink-2">
                      <span className="mr-1 text-micro text-ink-3">{e.role === 'user' ? '你说' : 'AI 说'}</span>
                      {e.quote}
                    </p>
                  ))}
                  {source.sessionDeleted ? (
                    <p className="mt-1 text-micro text-ink-3">来源会话已删除，原话已清除。</p>
                  ) : (
                    <Btn variant="link" className="mt-1 text-ui-sm" onClick={() => onSession(source.sessionId, source.messageId)}>回到原始对话</Btn>
                  )}
                </div>
              ) : (
                <p className="text-ui-sm text-ink-3">由你直接创建。</p>
              )}
            </section>
            <section className="mt-8">
              <Disclosure label={`变更记录 · ${detail.versions.length}`}>
                <ol className="space-y-3">
                  {detail.versions.map((v) => (
                    <li key={v.version} className="rounded-md border border-line-soft p-3 text-ui-sm">
                      <div className="flex flex-wrap items-center gap-2 text-micro text-ink-3">
                        <span className="font-medium text-ink">版本 {v.version}</span>
                        <span>{originLabels[v.origin] ?? v.origin}</span>
                        <time>{new Date(v.at).toLocaleString('zh-CN')}</time>
                      </div>
                      <p className="mt-1 text-ink-2">
                        {v.content.name}
                        {v.content.fields.length > 0 && ' · ' + v.content.fields.map((x) => `${x.key}：${x.value}`).join('；')}
                      </p>
                      {v.note && <p className="mt-1 text-micro text-ink-3">备注：{v.note}</p>}
                    </li>
                  ))}
                </ol>
              </Disclosure>
            </section>
            <div className="mt-10 border-t border-line-soft pt-5">
              <div className="flex flex-wrap gap-2">
                {a.status !== 'accepted' && (
                  <Btn variant="primary" disabled={busy} onClick={() => void run(() => creativeApi.updateAsset(bookId, a.assetId, { baseVersion: a.version, status: 'accepted' }))}>
                    <Icon name="check" />
                    确认为设定
                  </Btn>
                )}
                <Btn variant="outline" disabled={busy} onClick={() => setEdit(true)}>
                  <Icon name="edit" />
                  编辑
                </Btn>
                <Btn variant="quiet" onClick={() => onDiscuss(`关于「${a.name}」，我想继续讨论：`)}>
                  <Icon name="think" />
                  在灵感中讨论
                </Btn>
                {a.status === 'accepted' && (
                  <Btn variant="quiet" disabled={busy} onClick={() => void run(() => creativeApi.updateAsset(bookId, a.assetId, { baseVersion: a.version, status: 'draft' }))}>
                    改回草稿
                  </Btn>
                )}
                <Btn variant="quiet" disabled={busy} onClick={() => void run(() => creativeApi.updateAsset(bookId, a.assetId, { baseVersion: a.version, status: 'archived' })).then((ok) => ok && onClose())}>
                  归档
                </Btn>
              </div>
              <p className="mt-4 flex gap-2 text-ui-sm text-ink-3">
                <Icon name="info" className="mt-0.5" />
                AI 整理的内容永远是候选；你确认过的设定，不会被 AI 的推测覆盖。
              </p>
            </div>
          </article>
        )}
      </div>
      {edit && a && (
        <AssetEditor
          title={`编辑「${a.name}」`}
          kind={a.kind}
          kindLocked
          initial={a}
          chapters={chapters}
          busy={busy}
          error={error}
          note="保存会生成新版本，旧版本保留在历史中。"
          submitLabel="保存"
          onClose={() => setEdit(false)}
          onSubmit={(v) => void run(() => creativeApi.updateAsset(bookId, a.assetId, { baseVersion: a.version, content: v.content })).then((ok) => ok && setEdit(false))}
        />
      )}
    </div>
  )
}
