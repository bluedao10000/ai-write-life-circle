import { useEffect, useMemo, useState } from 'react'
import type { CreativeAssetDetail, CreativeAssetSummary, CreativeKind } from '@writer-agent/contracts'
import { CANON_SECTIONS, type BookSection, type CanonSection } from '../../components/vnext/BookView'
import { Btn, Heading, Row, Select, TextInput } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import AssetEditor, { type EditorResult } from './AssetEditor'
import ProposalList from './ProposalList'
import ManuscriptMatches from './ManuscriptMatches'
import { assetStatusLabels, creativeError, kindLabels, operationLabels, proposalStatusLabels, stanceLabels } from './labels'
import { useCreativeOverview } from './useCreativeOverview'

const sectionKinds: Record<Exclude<CanonSection, 'canon-review'>, CreativeKind[]> = {
  'canon-people': ['character'],
  'canon-world': ['world_rule', 'place', 'organization'],
  'canon-plot': ['plot_line', 'event'],
  'canon-threads': ['foreshadowing'],
  'canon-arcs': ['character_arc'],
  'canon-questions': ['open_question'],
}
const originLabels: Record<string, string> = {
  author_create: '你创建',
  author_edit: '你修改',
  proposal_accept: '接受灵感候选',
  proposal_edit_accept: '编辑后接受灵感候选',
  status_change: '状态变更',
}

/** Author-owned creative assets in the 书 space. Never mixed with manuscript knowledge rows. */
export default function AssetLibrary({
  bookId,
  section,
  chapters,
  onSection,
  onDiscuss,
}: {
  bookId: string
  section: CanonSection
  chapters: { id: string; title: string }[]
  onSection: (s: BookSection) => void
  onDiscuss: (seed: string) => void
}) {
  const meta = CANON_SECTIONS.find((s) => s.id === section)!
  const kinds = section === 'canon-review' ? [] : sectionKinds[section]
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('active')
  const [items, setItems] = useState<CreativeAssetSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<CreativeAssetDetail | null>(null)
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [linkTarget, setLinkTarget] = useState('')
  const [relation, setRelation] = useState('')
  const [allAssets, setAllAssets] = useState<CreativeAssetSummary[]>([])
  const { overview, refresh } = useCreativeOverview(bookId, true)
  const chapterTitle = useMemo(() => new Map(chapters.map((c) => [c.id, c.title])), [chapters])
  useEffect(() => {
    setSelected(null)
    setDetail(null)
  }, [section])
  useEffect(() => {
    if (section === 'canon-review') return
    const abort = new AbortController()
    setError('')
    creativeApi
      .assets(bookId, { kind: kinds.join(','), q: query, status: status === 'active' ? '' : status, limit: 100 }, abort.signal)
      .then((page) => setItems(status === 'active' ? page.items.filter((a) => a.status !== 'archived') : page.items))
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(creativeError(e))
      })
    return () => abort.abort()
    // kinds derives from section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, section, query, status, tick])
  useEffect(() => {
    if (!selected) return
    const abort = new AbortController()
    creativeApi
      .asset(bookId, selected, abort.signal)
      .then(setDetail)
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(creativeError(e))
      })
    creativeApi
      .assets(bookId, { limit: 100 }, abort.signal)
      .then((p) => setAllAssets(p.items.filter((a) => a.assetId !== selected && a.status !== 'archived')))
      .catch(() => setAllAssets([]))
    return () => abort.abort()
  }, [bookId, selected, tick])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      setTick((n) => n + 1)
      refresh()
      return true
    } catch (e) {
      setError(creativeError(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const save = async (v: EditorResult) => {
    const ok = await run(async () => {
      if (editing === 'new') {
        const created = await creativeApi.createAsset(bookId, { kind: v.kind, content: v.content, status: v.status })
        setSelected(created.assetId)
      } else if (detail) {
        await creativeApi.updateAsset(bookId, detail.asset.assetId, { baseVersion: detail.asset.version, content: v.content })
      }
    })
    if (ok) setEditing(null)
  }
  const setAssetStatus = (next: 'draft' | 'accepted' | 'archived') =>
    detail && void run(() => creativeApi.updateAsset(bookId, detail.asset.assetId, { baseVersion: detail.asset.version, status: next }))
  const header = (
    <header className="border-b border-line-soft px-5 pt-5 pb-4 md:px-8 md:pt-7">
      <div className="mx-auto max-w-3xl">
        <label className="block md:hidden">
          <span className="sr-only">知识分类</span>
          <select aria-label="创作设定分类" value={section} onChange={(e) => onSection(e.target.value as BookSection)} className="w-full rounded-md border border-line bg-surface px-3 py-2 text-ui text-ink">
            {CANON_SECTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                创作设定 · {s.label}
              </option>
            ))}
            <option value="chapter">正文观察 · 本章相关</option>
          </select>
        </label>
        <div className="mt-4 flex flex-wrap items-baseline gap-3">
          <Heading level={1}>{meta.label}</Heading>
          {overview && overview.pendingProposals > 0 && section !== 'canon-review' && (
            <Btn size="sm" variant="link" onClick={() => onSection('canon-review')}>
              {overview.pendingProposals} 条候选待审核
            </Btn>
          )}
        </div>
        <p className="mt-1 text-ui text-ink-3">{meta.desc}</p>
      </div>
    </header>
  )
  if (section === 'canon-review')
    return (
      <div className="scroll h-full overflow-auto">
        {header}
        <div className="px-5 pt-6 pb-24 md:px-8"><div className="mx-auto max-w-3xl">
          <ProposalList bookId={bookId} chapters={chapters} onDecided={refresh} emptyText="没有待审核的候选。在“灵感”中讨论人物、世界或剧情后，候选会出现在这里。" />
        </div></div>
      </div>
    )
  return (
    <div className="scroll h-full overflow-auto">
      {header}
      <div className="px-5 pt-6 pb-24 md:px-8"><div className="mx-auto max-w-3xl">
        {error && (
          <p role="alert" className="mb-4 rounded bg-danger-soft px-3 py-2 text-ui-sm text-danger">
            {error}
          </p>
        )}
        {!detail ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <TextInput label={`查找${meta.label}`} value={query} onChange={setQuery} placeholder="名称、别名或属性" className="min-w-0 flex-1" />
              <Select label="状态" value={status} onChange={setStatus} options={[{ value: 'active', label: '当前' }, { value: 'accepted', label: '已确认' }, { value: 'draft', label: '草稿' }, { value: 'archived', label: '已归档' }]} />
              <Btn variant="primary" size="sm" onClick={() => setEditing('new')}>
                新建{kindLabels[kinds[0]]}
              </Btn>
            </div>
            {!items ? (
              <p className="text-ui-sm text-ink-3">正在读取…</p>
            ) : items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line p-6 text-ui-sm text-ink-3">
                <p>还没有{meta.label}。可以直接新建，或去“灵感”和 Agent 讨论，整理出的候选经你确认后会出现在这里。</p>
                <Btn size="sm" variant="outline" className="mt-3" onClick={() => onDiscuss(`我想构思这部作品的${meta.label}。`)}>
                  去灵感讨论
                </Btn>
              </div>
            ) : (
              <ul className="space-y-1">
                {items.map((a) => (
                  <li key={a.assetId}>
                    <Row onClick={() => setSelected(a.assetId)} className="px-3 py-2.5">
                      <span className="flex items-baseline gap-2">
                        <span className="font-prose text-ui-lg text-ink">{a.name}</span>
                        <span className="text-micro text-ink-3">{kindLabels[a.kind]}</span>
                        <span className={`text-micro ${a.status === 'accepted' ? 'text-ok' : 'text-ink-3'}`}>{assetStatusLabels[a.status]}</span>
                        {a.plan?.chapterId && <span className="text-micro text-ink-3">计划 · {chapterTitle.get(a.plan.chapterId) ?? '已删除章节'}</span>}
                        {a.pendingProposals > 0 && <span className="ml-auto text-micro text-ai">{a.pendingProposals} 条候选</span>}
                      </span>
                      {a.summary && <span className="mt-0.5 block truncate text-ui-sm text-ink-2">{a.summary}</span>}
                    </Row>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <article aria-label={`设定：${detail.asset.name}`} className="space-y-6">
            <Btn size="sm" onClick={() => { setSelected(null); setDetail(null) }}>
              ← 返回{meta.label}
            </Btn>
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="font-prose text-title text-ink">{detail.asset.name}</h2>
                <span className="text-ui-sm text-ink-3">{kindLabels[detail.asset.kind]}</span>
                <span className={`text-ui-sm ${detail.asset.status === 'accepted' ? 'text-ok' : 'text-ink-3'}`}>{assetStatusLabels[detail.asset.status]}</span>
                <span className="text-micro text-ink-3">版本 {detail.asset.version} · {detail.asset.origin === 'conversation' ? '来自灵感讨论' : '你创建'}</span>
              </div>
              {detail.asset.aliases.length > 0 && <p className="mt-1 text-ui-sm text-ink-3">别名：{detail.asset.aliases.join('、')}</p>}
              {detail.asset.plan && (
                <p className="mt-1 text-ui-sm text-ink-3">
                  规划：{detail.asset.plan.chapterId ? `计划在「${chapterTitle.get(detail.asset.plan.chapterId) ?? '已删除章节'}」` : ''}
                  {detail.asset.plan.payoffChapterId ? ` · 计划在「${chapterTitle.get(detail.asset.plan.payoffChapterId) ?? '已删除章节'}」回收` : ''}（计划不等于正文已发生）
                </p>
              )}
              {detail.asset.summary && <p className="mt-3 whitespace-pre-wrap font-prose text-ui-lg text-ink">{detail.asset.summary}</p>}
              {detail.asset.fields.length > 0 && (
                <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-ui">
                  {detail.asset.fields.map((f) => (
                    <div key={f.key} className="contents">
                      <dt className="text-ink-3">{f.key}</dt>
                      <dd className="whitespace-pre-wrap text-ink">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn size="sm" variant="outline" disabled={busy} onClick={() => setEditing('edit')}>
                编辑
              </Btn>
              {detail.asset.status !== 'accepted' && (
                <Btn size="sm" variant="primary" disabled={busy} onClick={() => setAssetStatus('accepted')}>
                  确认为正式设定
                </Btn>
              )}
              {detail.asset.status === 'accepted' && (
                <Btn size="sm" disabled={busy} onClick={() => setAssetStatus('draft')}>
                  改回草稿
                </Btn>
              )}
              {detail.asset.status !== 'archived' && (
                <Btn size="sm" disabled={busy} onClick={() => setAssetStatus('archived')}>
                  归档
                </Btn>
              )}
              <Btn size="sm" variant="link" onClick={() => onDiscuss(`关于「${detail.asset.name}」，我想继续讨论：`)}>
                带着这条设定去灵感讨论
              </Btn>
            </div>
            <section>
              <Heading level={3} className="mb-2">关联</Heading>
              {detail.links.length === 0 && <p className="text-ui-sm text-ink-3">暂无关联。</p>}
              <ul className="space-y-1 text-ui-sm">
                {detail.links.map((l) => (
                  <li key={l.linkId} className="flex items-center gap-2">
                    <span className="text-ink">
                      {l.fromName} <span className="text-ink-3">—{l.relation}→</span> {l.toName || (l.to.type === 'chapter' ? chapterTitle.get(l.to.id) : l.to.type === 'knowledge_entity' ? '正文观察条目' : l.to.id)}
                    </span>
                    <span className="text-micro text-ink-3">{l.origin === 'conversation' ? '来自候选' : '你建立'}</span>
                    <Btn size="sm" className="ml-auto" disabled={busy} onClick={() => void run(() => creativeApi.removeLink(bookId, l.linkId))}>
                      移除
                    </Btn>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Select label="关联到" value={linkTarget} onChange={setLinkTarget} options={[{ value: '', label: '选择设定或章节' }, ...allAssets.map((a) => ({ value: 'asset:' + a.assetId, label: `${kindLabels[a.kind]} · ${a.name}` })), ...chapters.map((c) => ({ value: 'chapter:' + c.id, label: `章节 · ${c.title}` }))]} />
                <input aria-label="关系" placeholder="关系，如：师徒" maxLength={40} value={relation} onChange={(e) => setRelation(e.target.value)} className="w-36 rounded-md border border-line bg-transparent px-2 py-1 text-ui" />
                <Btn
                  size="sm"
                  disabled={busy || !linkTarget || !relation.trim()}
                  onClick={() => {
                    const [type, id] = linkTarget.split(/:(.*)/s) as ['asset' | 'chapter', string]
                    void run(() => creativeApi.link(bookId, { fromAssetId: detail.asset.assetId, to: { type, id }, relation: relation.trim() })).then((ok) => {
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
            </section>
            <ManuscriptMatches
              bookId={bookId}
              asset={detail.asset}
              links={detail.links}
              busy={busy}
              onLink={(entityId) => void run(() => creativeApi.link(bookId, { fromAssetId: detail.asset.assetId, to: { type: 'knowledge_entity', id: entityId }, relation: '正文对应' }))}
            />
            {detail.proposals.some((p) => p.status === 'proposed') && (
              <section>
                <Heading level={3} className="mb-2">待审核候选</Heading>
                <Btn size="sm" variant="link" onClick={() => onSection('canon-review')}>
                  去候选审核
                </Btn>
              </section>
            )}
            <section>
              <Heading level={3} className="mb-2">版本历史</Heading>
              <ol className="space-y-3">
                {detail.versions.map((v) => (
                  <li key={v.version} className="rounded-md border border-line-soft p-3 text-ui-sm">
                    <div className="flex flex-wrap items-center gap-2 text-micro text-ink-3">
                      <span className="font-medium text-ink">版本 {v.version}</span>
                      <span>{originLabels[v.origin] ?? v.origin}</span>
                      <span>{assetStatusLabels[v.status]}</span>
                      <time>{new Date(v.at).toLocaleString('zh-CN')}</time>
                    </div>
                    <p className="mt-1 text-ink-2">
                      {v.content.name}
                      {v.content.fields.length > 0 && ' · ' + v.content.fields.map((f) => `${f.key}：${f.value}`).join('；')}
                    </p>
                    {v.source && (
                      <p className="mt-1 text-micro text-ink-3">
                        来源：灵感会话{v.source.sessionDeleted ? '（已删除）' : ''} · {v.source.model.model} · {new Date(v.source.capturedAt).toLocaleString('zh-CN')}
                      </p>
                    )}
                    {v.evidence.filter((e) => e.quote).map((e, i) => (
                      <blockquote key={i} className="mt-1 border-l-2 border-ink-4 pl-2 font-prose text-ink-2">
                        <span className="mr-1 text-micro text-ink-3">{e.role === 'user' ? '你说' : 'AI 说'}</span>
                        {e.quote}
                      </blockquote>
                    ))}
                    {v.note && <p className="mt-1 text-micro text-ink-3">备注：{v.note}</p>}
                  </li>
                ))}
              </ol>
            </section>
            {detail.proposals.length > 0 && (
              <section>
                <Heading level={3} className="mb-2">候选记录</Heading>
                <ul className="space-y-1 text-ui-sm">
                  {detail.proposals.map((p) => (
                    <li key={p.proposalId} className="text-ink-2">
                      {operationLabels[p.operation]} · {stanceLabels[p.stance]} · {proposalStatusLabels[p.status]} · <time>{new Date(p.createdAt).toLocaleString('zh-CN')}</time>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </article>
        )}
      </div></div>
      {editing && (
        <AssetEditor
          title={editing === 'new' ? `新建${meta.label}` : `编辑：${detail?.asset.name}`}
          kind={editing === 'new' ? kinds[0] : detail?.asset.kind}
          kindLocked={editing === 'edit' || kinds.length === 1}
          showStatus={editing === 'new'}
          initial={editing === 'edit' ? detail?.asset : undefined}
          chapters={chapters}
          busy={busy}
          error={error}
          note={editing === 'edit' ? '保存会生成新版本，旧版本保留在历史中。' : undefined}
          submitLabel="保存"
          onClose={() => setEditing(null)}
          onSubmit={(v) => void save(v)}
        />
      )}
    </div>
  )
}
