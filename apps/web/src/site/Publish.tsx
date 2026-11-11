import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  PublicationManagement,
  PublicationMetadata,
  PublicationPreview,
  PublicationVersion,
} from '@writer-agent/contracts'
import { publicationMetadataSchema } from '@writer-agent/contracts'
import { Btn, Choice, Dialog, Heading, Icon, TextArea } from '../components/vnext/ui'
import {
  getPublication,
  previewPublication,
  commitPublication,
  suggestPublication,
  transitionPublication,
} from '../services/api/publicationApi'
import { A, Cover } from './kit'
import { mapBook, volumeTitle } from './mapper'
import { Markdown } from './Markdown'
import { prefs } from './store'
import { readScopedSession } from '../services/storageScope'

type Loaded = {
  management: PublicationManagement
  drafts: PublicationManagement['drafts']
}
const message = (e: unknown) =>
  e instanceof Error ? e.message : '请求失败，请重试。'
const initial: PublicationMetadata = {
  slug: '',
  title: '',
  penName: '',
  authorBio: '',
  tagline: '',
  description: '',
  category: '',
  serialStatus: 'ongoing',
  coverUrl: '',
}
const fieldLabels: Record<string, string> = {
  slug: '公开地址',
  title: '书名',
  penName: '笔名',
  tagline: '一句话简介',
  description: '作品简介',
  category: '题材',
  coverUrl: '封面地址',
}
const slugFor = (book: string) =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(book) && book.length <= 80
    ? book
    : `book-${crypto.randomUUID().slice(0, 8)}`
const missingFields = (meta: PublicationMetadata) => {
  const parsed = publicationMetadataSchema.safeParse(meta)
  if (parsed.success) return []
  return [
    ...new Set(
      parsed.error.issues.map(
        (issue) => fieldLabels[String(issue.path[0])] ?? String(issue.path[0]),
      ),
    ),
  ]
}
function selectedStudioBook() {
  try {
    return readScopedSession('writer-agent:selected-book') || ''
  } catch {
    return ''
  }
}
export default function Publish() {
  const sitePrefs = prefs.use()
  useEffect(() => {
    document.documentElement.classList.toggle('dark', sitePrefs.dark)
  }, [sitePrefs.dark])
  const project =
    new URLSearchParams(window.location.search).get('book') ||
    selectedStudioBook() ||
    import.meta.env.VITE_WRITER_AGENT_PROJECT_ID?.trim() ||
    ''
  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [error, setError] = useState(''),
    [epoch, setEpoch] = useState(0)
  const [wizard, setWizard] = useState(false),
    [step, setStep] = useState(0),
    [meta, setMeta] = useState<PublicationMetadata>(initial),
    [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<PublicationPreview | null>(null),
    [busy, setBusy] = useState(false),
    [suggesting, setSuggesting] = useState(false),
    [success, setSuccess] = useState<PublicationVersion | null>(null)
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState<
    | { kind: 'unlist' | 'relist' }
    | { kind: 'withdraw'; chapterId: string; title: string }
    | null
  >(null)
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [ack, setAck] = useState({ rights: false, scope: false }),
    [key, setKey] = useState(() => crypto.randomUUID())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let active = true
    setLoaded(null)
    void (async () => {
      if (!project) throw Error('缺少作品配置，无法读取发布资料。')
      const management = await getPublication(project)
      const drafts = management.drafts
      if (!active) return
      setLoaded({ management, drafts })
      const version = management.publication?.versions.at(-1)
      setMeta(
        version?.metadata ?? {
          ...initial,
          title: management.bookTitle,
          slug: slugFor(project),
        },
      )
      setSelected(version?.chapters.map((c) => c.chapterId) ?? [])
      setWizard(!version)
    })().catch((e) => {
      if (active) setError(message(e))
    })
    return () => {
      active = false
    }
  }, [project, epoch])
  const base = loaded?.management.publication?.currentVersionId ?? null,
    current = loaded?.management.publication?.versions.at(-1)
  const drafts = loaded?.drafts ?? []
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { id: string; title: string; drafts: typeof drafts }
    >()
    for (const draft of loaded?.drafts ?? []) {
      const id = draft.volumeId || ''
      const group = map.get(id) ?? {
        id,
        title: draft.volumeTitle?.trim() || draft.volumeId || '未分卷',
        drafts: [],
      }
      group.drafts.push(draft)
      map.set(id, group)
    }
    return [...map.values()]
  }, [loaded])
  const needle = query.trim().toLowerCase()
  const matches = (draft: (typeof drafts)[number]) =>
    !needle || draft.title.toLowerCase().includes(needle)
  const selectable = drafts.filter((draft) => !draft.isEmpty)
  const matched = drafts.filter(matches)
  const visible = selectable.filter(matches)
  const selectedSet = new Set(selected)
  const selectedDrafts = drafts.filter((draft) => selectedSet.has(draft.chapterId))
  const selectedWords = selectedDrafts.reduce((sum, draft) => sum + draft.words, 0)
  const visibleSelected =
    visible.length > 0 && visible.every((draft) => selectedSet.has(draft.chapterId))
  const publishedSet = new Set(
    current?.chapters.map((chapter) => chapter.chapterId) ?? [],
  )
  const choose = (ids: string[], on: boolean) => {
    setSelected((current) =>
      on
        ? [...new Set([...current, ...ids])]
        : current.filter((id) => !ids.includes(id)),
    )
    setPreview(null)
    setAck({ rights: false, scope: false })
  }
  const open = (ids: string[]) => {
    setSelected(ids)
    setStep(0)
    setPreview(null)
    setAck({ rights: false, scope: false })
    setKey(crypto.randomUUID())
    setWizard(true)
    setError('')
    setSuccess(null)
    setConfirm(null)
    setQuery('')
    setCollapsed({})
  }
  const changeMeta = (patch: Partial<PublicationMetadata>) => {
    setMeta((m) => ({ ...m, ...patch }))
    setNotice('')
    setPreview(null)
    setAck({ rights: false, scope: false })
  }
  const suggest = async () => {
    const blank = (value: string) => !value.trim()
    if (
      !blank(meta.title) &&
      !blank(meta.penName) &&
      !blank(meta.tagline) &&
      !blank(meta.description) &&
      !blank(meta.authorBio) &&
      !blank(meta.category)
    ) {
      setNotice('发布资料都已填写；清空需要重写的字段后再生成。')
      return
    }
    setSuggesting(true)
    setError('')
    setNotice('')
    try {
      const value = await suggestPublication(project)
      setMeta((m) => ({
        ...m,
        title: m.title.trim() ? m.title : value.title,
        slug: m.slug.trim() ? m.slug : slugFor(project),
        penName: m.penName.trim() ? m.penName : value.penName,
        tagline: m.tagline.trim() ? m.tagline : value.tagline,
        description: m.description.trim() ? m.description : value.description,
        authorBio: m.authorBio.trim() ? m.authorBio : value.authorBio,
        category: m.category.trim() ? m.category : value.category,
        categories: m.categories?.length
          ? m.categories
          : value.category
            ? [value.category]
            : m.categories,
      }))
      setPreview(null)
      setAck({ rights: false, scope: false })
      setNotice('已填入空白字段，可继续修改。')
    } catch (e) {
      setError(message(e))
    } finally {
      setSuggesting(false)
    }
  }
  const next = async () => {
    setError('')
    if (step === 0) {
      const missing = missingFields(meta)
      if (missing.length > 0) {
        setError(`还需要填写：${missing.join('、')}。`)
        return
      }
      setStep(1)
      return
    }
    if (step === 1) {
      if (selected.length === 0 && !current) {
        setError('请至少选择一个章节。')
        return
      }
      setBusy(true)
      try {
        const fresh = await getPublication(project)
        const selections = fresh.drafts
          .filter((d) => selected.includes(d.chapterId))
          .map(
            ({
              chapterId,
              revisionId,
              contentHash,
              volumeId,
              chapterOrder,
            }) => ({
              chapterId,
              revisionId,
              contentHash,
              volumeId,
              chapterOrder,
            }),
          )
        if (selections.length !== selected.length)
          throw Error('章节目录已变化，请重新载入后选择章节。')
        const value = await previewPublication(project, {
          baseVersionId: base,
          metadata: meta,
          chapters: selections,
        })
        if (mounted.current) {
          setPreview(value)
          setKey(crypto.randomUUID())
          setStep(2)
        }
      } catch (e) {
        if (mounted.current) setError(message(e))
      } finally {
        if (mounted.current) setBusy(false)
      }
    } else setStep((s) => s + 1)
  }
  const publish = async () => {
    if (!preview || !ack.rights || !ack.scope) return
    setBusy(true)
    setError('')
    try {
      const value = await commitPublication(
        project,
        { baseVersionId: base, previewId: preview.previewId, note },
        key,
      )
      if (mounted.current) {
        setSuccess(value)
        setKey(crypto.randomUUID())
      }
    } catch (e) {
      if (mounted.current)
        setError(
          message(e) +
            ' 如章节或公开版本发生变化，请返回选择章节并重新预览；网络故障可用同一请求安全重试。',
        )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const transition = async (action: 'unlist' | 'relist') => {
    if (!base) return
    setBusy(true)
    setError('')
    try {
      await transitionPublication(project, action, base, key)
      if (mounted.current) {
        setConfirm(null)
        setKey(crypto.randomUUID())
        setEpoch((v) => v + 1)
      }
    } catch (e) {
      if (mounted.current) setError(message(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const coverBook = mapBook({
    slug: meta.slug,
    title: meta.title || '书名',
    penName: meta.penName,
    authorSlug: 'preview',
    tagline: meta.tagline,
    description: meta.description,
    category: meta.category,
    categories: meta.categories,
    serialStatus: meta.serialStatus,
    coverUrl: meta.coverUrl,
    cover: meta.cover,
    firstPublishedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    chapterCount: 1,
    chapters: [],
  })
  const boundary = (
    <div>
      <Heading level={2}>公开与私密的边界</Heading>
      <div className="mt-4 grid grid-cols-2 gap-6 text-ui">
        <div>
          <div className="text-ok">读者能看到</div>
          <ul className="mt-2 space-y-1 text-ink-2">
            <li>你填写的公开资料与笔名</li>
            <li>
              {wizard ? preview?.chapters.length ?? selected.length : current?.chapters.length ?? 0}{' '}
              个已确认章节的正文快照
            </li>
          </ul>
        </div>
        <div>
          <div className="text-ink-3">永远不会公开</div>
          <ul className="mt-2 space-y-1 text-ink-2">
            <li>未选章节与之后修改的草稿</li>
            <li>创作笔记、人物、世界观与伏笔</li>
            <li>AI 注记、审查、思考与修订历史</li>
            <li>账户邮箱与身份信息</li>
          </ul>
        </div>
      </div>
    </div>
  )
  return (
    <div className="min-h-screen bg-page">
      <header className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-2">
        <A to="/studio" variant="quiet" className="h-7 px-2 text-ui-sm">
          <Icon name="back" />回到写作
        </A>
        <span className="text-ui-sm text-ink-3">Writer Studio · 发布</span>
        <A to="/" className="ml-auto text-ui-sm text-ink-2 hover:text-ink">
          story2u 首页
        </A>
      </header>
      {!loaded ? (
        <main className="p-10">
          <p role="status">{error || '正在加载已保存章节…'}</p>
          {error && (
            <Btn
              onClick={() => {
                setError('')
                setEpoch((v) => v + 1)
              }}
            >
              重试
            </Btn>
          )}
        </main>
      ) : success ? (
        <main className="mx-auto max-w-xl px-6 pt-20 text-center">
          <Icon name="check" className="mx-auto h-6 w-6 text-ok" />
          <Heading level={1} className="mt-4">
            《{success.metadata.title}》
            {success.state === 'listed' ? '已发布' : '已撤回全部章节'}
          </Heading>
          <p className="mt-3 text-ui text-ink-2">
            公开版本 v{success.versionNumber} · {success.chapters.length} 章。
          </p>
          <p className="mt-2 text-ui-sm text-ink-3">
            {success.state === 'listed'
              ? '读者现在可以在 story2u 阅读这个公开版本。之后修改草稿不会自动更新它。'
              : '作品和章节已对读者隐藏，私人草稿与公开版本历史仍然保留。'}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {success.state === 'listed' && <>
              <A to="/" variant="primary">在首页查看</A>
              <A to={success.publicUrl} variant="outline">作品页</A>
            </>}
            <Btn
              variant={success.state === 'listed' ? 'quiet' : 'primary'}
              onClick={() => {
                setSuccess(null)
                setWizard(false)
                setEpoch((v) => v + 1)
              }}
            >
              管理发布
            </Btn>
          </div>
        </main>
      ) : !wizard && current ? (
        <main className="mx-auto max-w-4xl px-6 pt-8 pb-24">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm">
            <span className={current.state === 'listed' ? 'text-ok' : 'text-warn'}>
              {current.state === 'listed' ? '● 公开中' : '已下架 · 读者不可见'}
            </span>
            <span className="text-ink-3">
              公开版本 v{current.versionNumber} · {new Date(current.createdAt).toLocaleString('zh-CN')}
            </span>
          </div>
          <Heading level={1} className="mt-2">
            {current.metadata.title}
          </Heading>
          <p className="mt-1 break-all text-ui-sm text-ink-3">
            公开地址：{window.location.origin}/books/{current.metadata.slug}
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {current.state === 'listed' && (
              <A to={`/books/${current.metadata.slug}`} variant="outline">以读者身份查看</A>
            )}
            <Btn variant="quiet" onClick={() => open(current.chapters.map((c) => c.chapterId))}>
              修改公开资料与章节…
            </Btn>
            <Btn
              disabled={busy}
              variant={current.state === 'listed' ? 'quiet' : 'primary'}
              onClick={() => {
                setError('')
                setConfirm({ kind: current.state === 'listed' ? 'unlist' : 'relist' })
              }}
            >
              {current.state === 'listed' ? '下架作品…' : '重新上架'}
            </Btn>
          </div>
          <section className="mt-12">
            <Heading level={2}>章节</Heading>
            <p className="mt-2 text-ui-sm text-ink-3">
              自动保存永远不会改变公开快照。更新或撤回都需重新预览和确认。
            </p>
            <div className="mt-5 hidden grid-cols-[minmax(0,1fr)_12rem_15rem] gap-3 pb-2 text-ui-sm text-ink-3 md:grid" aria-hidden>
              <span>章节</span><span>状态</span><span className="text-right">操作</span>
            </div>
            <div className="divide-y divide-line-soft border-t border-line-soft">
              {loaded.drafts.map((d) => {
                const published = current.chapters.find(
                    (c) => c.chapterId === d.chapterId,
                  ),
                  changed = loaded.management.changedChapterIds.includes(
                    d.chapterId,
                  )
                return (
                  <div
                    key={d.chapterId}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 text-ui md:grid-cols-[minmax(0,1fr)_12rem_15rem]"
                  >
                    <div className="min-w-0">
                      <span className="block break-words font-prose text-ink">{d.title}</span>
                      {d.volumeTitle && <span className="text-micro text-ink-3">{d.volumeTitle}</span>}
                    </div>
                    <span
                      className={`col-start-1 row-start-2 text-ui-sm md:col-auto md:row-auto ${
                        changed
                          ? 'text-warn'
                          : published
                            ? 'text-ok'
                            : 'text-ink-3'
                      }`}
                    >
                      {published
                        ? changed
                          ? '已公开 · 草稿有新的修改'
                          : '已公开 · 与草稿一致'
                        : !d.isEmpty
                          ? '草稿 · 未公开'
                          : '空章节'}
                    </span>
                    <div className="col-start-2 row-span-2 row-start-1 flex flex-col items-end gap-1 md:col-auto md:row-span-1 md:row-auto md:flex-row md:justify-end">
                      {(!published || changed) && (
                        <Btn
                          size="sm"
                          disabled={!!d.isEmpty}
                          variant="outline"
                          onClick={() =>
                            open([
                              ...new Set([
                                ...current.chapters.map((c) => c.chapterId),
                                d.chapterId,
                              ]),
                            ])
                          }
                        >
                          {published ? '更新公开版本…' : '发布此章…'}
                        </Btn>
                      )}
                      {published && (
                        <Btn
                          size="sm"
                          variant="quiet"
                          onClick={() => {
                            setError('')
                            setConfirm({ kind: 'withdraw', chapterId: d.chapterId, title: d.title })
                          }}
                        >
                          取消公开
                        </Btn>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
          <section className="mt-12 grid gap-10 md:grid-cols-2">
            <div>
              <Heading level={2}>公开版本历史</Heading>
              <ol className="mt-4 space-y-3">
                {[...loaded.management.publication!.versions]
                  .reverse()
                  .map((v) => (
                    <li key={v.versionId} className="grid grid-cols-[3rem_1fr] gap-2 text-ui">
                      <span className="text-ink-3">v{v.versionNumber}</span>
                      <div className="min-w-0">
                        <span className="break-words text-ink">{v.note || (v.state === 'listed' ? '发布作品' : '下架作品')}</span>
                        <span className="mt-0.5 block text-micro text-ink-3">
                          {new Date(v.createdAt).toLocaleString('zh-CN')} · {v.chapters.length} 章 · {v.state === 'listed' ? '公开' : '下架'}
                        </span>
                      </div>
                    </li>
                  ))}
              </ol>
            </div>
            {boundary}
          </section>
          {error && !confirm && (
            <p role="alert" className="mt-5 text-danger">
              {error}
            </p>
          )}
        </main>
      ) : (
        <main className="mx-auto max-w-4xl px-6 pt-6 pb-24">
          <ol
            aria-label="发布步骤"
            className="flex flex-wrap gap-x-6 gap-y-2 text-ui-sm"
          >
            {['公开资料', '选择章节', '预览', '确认发布'].map((s, i) => (
              <li
                key={s}
                aria-current={i === step ? 'step' : undefined}
                className={i === step ? 'font-medium text-ink' : i < step ? 'text-ink-2' : 'text-ink-3'}
              >
                {i + 1}. {s}
              </li>
            ))}
          </ol>
          {step === 0 && (
            <section className="mt-10 grid gap-10 md:grid-cols-[1fr_12rem]">
              <div className="space-y-6">
                <div className="flex flex-wrap items-center gap-3">
                  <Heading level={1}>读者会看到的资料</Heading>
                  <Btn
                    className="ml-auto"
                    disabled={suggesting || busy}
                    onClick={() => void suggest()}
                  >
                    <Icon name="think" className="h-4 w-4" />
                    {suggesting ? '正在生成…' : 'AI 帮我填'}
                  </Btn>
                </div>
                <p className="-mt-3 text-ui-sm text-ink-3">
                  写作助手会阅读章节目录与正文节选，生成空白字段；已填写的内容不会被覆盖，生成后仍可修改。
                </p>
                {(
                  [
                    ['title', '书名'],
                    ['slug', '公开地址'],
                    ['penName', '笔名'],
                    ['tagline', '一句话简介'],
                    ['description', '作品简介'],
                    ['authorBio', '作者介绍'],
                  ] as const
                ).map(([field, label]) => (
                  <div key={field}>
                    <label className="text-ui-sm text-ink-2" htmlFor={field}>
                      {label}
                    </label>
                    <div className="mt-2 rounded-md bg-surface-2 px-3 py-2">
                      <TextArea
                        label={label}
                        rows={
                          field === 'description'
                            ? 4
                            : field === 'authorBio'
                              ? 2
                              : 1
                        }
                        value={meta[field]}
                        maxLength={{ title: 160, slug: 80, penName: 100, tagline: 250, description: 10000, authorBio: 2000 }[field]}
                        onChange={(value) => changeMeta({ [field]: field === 'description' || field === 'authorBio' ? value : value.replace(/\n/g, '') })}
                      />
                    </div>
                    {field === 'slug' && <p className="mt-1 break-all text-micro text-ink-3">{window.location.origin}/books/{meta.slug || '…'}</p>}
                    {field === 'penName' && <p className="mt-1 text-micro text-ink-3">读者看到的作者名，不会显示你的账户信息。</p>}
                    {field === 'tagline' && <p className="mt-1 text-micro text-ink-3">{meta.tagline.length} 字 · 建议 40 字以内，出现在首页和分享卡片上。</p>}
                  </div>
                ))}
                <div>
                  <div className="mb-2 text-ui-sm text-ink-2">题材</div>
                  <div className="flex flex-wrap gap-1">
                    {['科幻', '奇幻', '悬疑', '历史', '都市', '其他原创'].map(
                      (category) => {
                        const values =
                          meta.categories ??
                          (meta.category ? [meta.category] : [])
                        const selected = values.includes(category)
                        return (
                          <Btn
                            key={category}
                            size="sm"
                            variant={selected ? 'primary' : 'outline'}
                            pressed={selected}
                            onClick={() => {
                              const categories = selected
                                ? values.filter((c) => c !== category)
                                : [...values, category]
                              changeMeta({
                                category: categories[0] ?? '',
                                categories,
                              })
                            }}
                          >
                            {category}
                          </Btn>
                        )
                      },
                    )}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-ui-sm text-ink-2">状态</div>
                  <div role="group" aria-label="作品连载状态" className="flex flex-wrap gap-1">
                    {(['ongoing', 'completed', 'paused'] as const).map(
                      (status, i) => (
                        <Btn
                          key={status}
                          size="sm"
                          variant={meta.serialStatus === status ? 'primary' : 'outline'}
                          pressed={meta.serialStatus === status}
                          onClick={() => changeMeta({ serialStatus: status })}
                        >
                          {['连载中', '已完结', '暂停中'][i]}
                        </Btn>
                      ),
                    )}
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-2 text-ui-sm text-ink-3">封面</div>
                <Cover book={coverBook} />
                <div className="mt-4">
                  <div className="mb-1.5 text-ui-sm text-ink-2">封面图片地址（可选）</div>
                  <div className="rounded-md bg-surface-2 px-3 py-2">
                    <TextArea
                      label="公开封面 HTTPS 地址（可选）"
                      rows={2}
                      value={meta.coverUrl}
                      placeholder="https://…"
                      onChange={(value) => changeMeta({ coverUrl: value.replace(/\n/g, '') })}
                    />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {[
                    undefined,
                    { bg: '#41505a', fg: '#e9e4d8', mark: 'wave' as const },
                    { bg: '#5d3a2f', fg: '#f2e4d0', mark: 'rule' as const },
                    { bg: '#2c3b34', fg: '#e4e6da', mark: 'grid' as const },
                    { bg: '#e2dccf', fg: '#2c2822', mark: 'circle' as const },
                  ].map((palette, i) => (
                    <Btn
                      key={i}
                      size="sm"
                      variant="outline"
                      ariaLabel={palette ? `封面配色 ${i}` : '不设置封面'}
                      pressed={meta.cover?.bg === palette?.bg}
                      onClick={() => changeMeta({ cover: palette })}
                      className={`w-8 px-0 ${meta.cover?.bg === palette?.bg ? 'border-ink' : ''}`}
                    >
                      {palette ? (
                        <span
                          className="h-4 w-4 rounded-sm"
                          style={{ background: palette.bg }}
                        />
                      ) : (
                        '无'
                      )}
                    </Btn>
                  ))}
                </div>
                <p className="mt-2 text-micro text-ink-3">
                  不上传封面也可以发布，会使用排版封面。图片上传暂不提供。
                </p>
              </div>
            </section>
          )}
          {step === 1 && (
            <section className="mt-10 max-w-2xl">
              <Heading level={1}>选择要公开的章节</Heading>
              <p className="mt-2 text-ui text-ink-2">
                仅发布已保存修订的固定快照。之后修改草稿不会改变读者看到的内容。
              </p>
              <div className="sticky top-0 z-10 mt-6 -mx-2 border-b border-line-soft bg-page/95 px-2 py-3 backdrop-blur">
                <div className="flex flex-wrap items-center gap-2">
                  <p
                    role="status"
                    aria-label="已选章节统计"
                    className="text-ui-sm text-ink-2"
                  >
                    已选{' '}
                    <span className="font-mono-num text-ink">
                      {selectedDrafts.length}
                    </span>{' '}
                    / {selectable.length} 章 ·{' '}
                    {selectedWords.toLocaleString('zh-CN')} 字
                  </p>
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <input
                      type="search"
                      aria-label="查找章节"
                      placeholder={`在 ${selectable.length} 章中查找`}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="w-36 rounded border border-line bg-page px-2 py-1 text-ui-sm"
                    />
                    <Btn
                      size="sm"
                      variant="outline"
                      disabled={visible.length === 0}
                      onClick={() =>
                        choose(
                          visible.map((draft) => draft.chapterId),
                          !visibleSelected,
                        )
                      }
                    >
                      {visibleSelected ? '取消全选' : needle ? '全选结果' : '全选'}
                    </Btn>
                    <Btn
                      size="sm"
                      variant="outline"
                      disabled={selectedDrafts.length === 0}
                      onClick={() => choose(selected, false)}
                    >
                      清空选择
                    </Btn>
                  </div>
                </div>
                {needle && (
                  <p className="mt-2 text-micro text-ink-3">
                    找到 {matched.length} 章；全选只作用于当前结果。
                  </p>
                )}
              </div>
              {matched.length === 0 ? (
                <p className="py-8 text-ui text-ink-3">
                  {drafts.length === 0
                    ? '还没有章节，请先保存正文。'
                    : '没有匹配的章节。'}
                </p>
              ) : (
                groups.map((group) => {
                  const rows = group.drafts.filter(matches)
                  const ids = rows
                    .filter((draft) => !draft.isEmpty)
                    .map((draft) => draft.chapterId)
                  if (needle && rows.length === 0) return null
                  const isCollapsed = !needle && !!collapsed[group.id]
                  const all =
                    ids.length > 0 &&
                    ids.every((id) => selectedSet.has(id))
                  return (
                    <section key={group.id} className="mt-4">
                      <div className="flex items-center gap-2 py-2">
                        <button
                          type="button"
                          aria-expanded={!isCollapsed}
                          aria-label={`${isCollapsed ? '展开' : '收起'}${group.title}`}
                          className="px-1 text-ui-sm text-ink-2"
                          onClick={() =>
                            setCollapsed((value) => ({
                              ...value,
                              [group.id]: !isCollapsed,
                            }))
                          }
                        >
                          {isCollapsed ? '▸' : '▾'}
                        </button>
                        <h3 className="font-prose text-ui">{group.title}</h3>
                        <span className="text-micro text-ink-3">
                          {
                            group.drafts.filter((draft) => !draft.isEmpty)
                              .length
                          }{' '}
                          章
                        </span>
                        {ids.length > 0 && (
                          <Btn
                            size="sm"
                            variant="outline"
                            className="ml-auto"
                            onClick={() => choose(ids, !all)}
                          >
                            {all ? '取消本卷' : '选择本卷'}
                          </Btn>
                        )}
                      </div>
                      {!isCollapsed && (
                        <div className="divide-y divide-line-soft">
                          {rows.map((d) => (
                            <Choice
                              key={d.chapterId}
                              checked={selectedSet.has(d.chapterId)}
                              onChange={(yes) => {
                                if (!d.isEmpty) choose([d.chapterId], yes)
                              }}
                              className={`py-3 ${d.isEmpty ? 'opacity-50' : ''}`}
                            >
                              <span className="flex flex-wrap items-baseline gap-2">
                                <span className="font-prose text-ui">
                                  {d.title}
                                </span>
                                {publishedSet.has(d.chapterId) && (
                                  <span className="text-micro text-ok">
                                    已公开
                                  </span>
                                )}
                              </span>
                              <span className="block text-micro text-ink-3">
                                {d.isEmpty
                                  ? '空章节 · 保存正文后才能公开'
                                  : `${d.words.toLocaleString('zh-CN')} 字`}
                              </span>
                            </Choice>
                          ))}
                        </div>
                      )}
                    </section>
                  )
                })
              )}
            </section>
          )}
          {step === 2 && preview && (
            <section className="mt-10">
              <Heading level={1}>读者将看到</Heading>
              <div className="mt-6 rounded-xl border border-line p-6 sm:p-10">
                <div className="mb-6 text-micro text-ink-3">预览 · 作品页</div>
                <div className="grid gap-8 sm:grid-cols-[9rem_1fr]">
                  <Cover book={coverBook} />
                  <div>
                    <h2 className="font-prose text-display text-ink">
                      {preview.metadata.title}
                    </h2>
                    <div className="mt-1 text-ui-sm text-ink-3">
                      {preview.metadata.penName} · {(preview.metadata.categories ?? [preview.metadata.category]).join(' / ')} · {coverBook.status}
                    </div>
                    <p className="mt-4 font-prose text-ui-lg">
                      {preview.metadata.tagline}
                    </p>
                    <p className="mt-2 text-ui text-ink-2">
                      {preview.metadata.description}
                    </p>
                    <div className="mt-6 text-ui-sm text-ink-3">目录 · {preview.chapters.length} 章</div>
                    <ol className="mt-1">
                      {preview.chapters.map((c) => (
                        <li
                          key={c.chapterId}
                          className="border-b border-line-soft py-2 font-prose"
                        >
                          {volumeTitle(c) && (
                            <span className="mr-2 text-ui-sm text-ink-3">
                              {volumeTitle(c)}
                            </span>
                          )}
                          {c.title}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
                {preview.chapters[0] && (
                  <div className="mt-10 border-t border-line-soft pt-8">
                    <div className="mb-4 text-micro text-ink-3">预览 · 阅读页 · 第 1 章</div>
                    <h3 className="mx-auto mb-6 max-w-read font-prose text-title text-ink">{preview.chapters[0].title}</h3>
                    <div className="reader-text mx-auto max-w-read font-prose text-read text-ink">
                      <Markdown markdown={preview.chapters[0].markdown.split(/\n\s*\n/).slice(0, 3).join('\n\n')} />
                    </div>
                  </div>
                )}
              </div>
              {preview.chapters.length > 0 && (
                <section className="mt-10">
                  <Heading level={2}>完整章节与更新对照</Heading>
                  <p className="mt-1 text-ui-sm text-ink-3">展开查看本次已冻结的正文快照。内容发生变化的章节会并排显示当前公开版本。</p>
                  <div className="mt-4 divide-y divide-line-soft">
                    {preview.chapters.map((chapter) => {
                      const previous = preview.previousChapters.find((old) => old.chapterId === chapter.chapterId)
                      const changed = !!current?.chapters.some((old) => old.chapterId === chapter.chapterId && old.contentHash !== chapter.contentHash)
                      return (
                        <details key={chapter.chapterId} open={changed} className="py-4">
                          <summary className="cursor-pointer font-prose text-ui-lg text-ink">
                            {volumeTitle(chapter) && <span className="mr-2 font-ui text-ui-sm text-ink-3">{volumeTitle(chapter)}</span>}
                            {chapter.title}
                            {changed && <span className="ml-3 font-ui text-ui-sm text-warn">公开内容将更新</span>}
                          </summary>
                          <div className={`mt-4 grid gap-4 ${changed ? 'md:grid-cols-2' : ''}`}>
                            {changed && (
                              <div>
                                <div className="mb-2 text-ui-sm text-ink-3">当前公开版本</div>
                                <div className="reader-text scroll max-h-96 overflow-auto rounded-md bg-surface-2 p-4 font-prose text-read text-ink-2">
                                  <Markdown markdown={previous?.markdown ?? ''} />
                                </div>
                              </div>
                            )}
                            <div>
                              <div className="mb-2 text-ui-sm text-ink-3">{changed ? '草稿快照（将公开）' : '本次公开快照'}</div>
                              <div className="reader-text scroll max-h-96 overflow-auto rounded-md bg-surface-2 p-4 font-prose text-read text-ink">
                                <Markdown markdown={chapter.markdown} />
                              </div>
                            </div>
                          </div>
                        </details>
                      )
                    })}
                  </div>
                </section>
              )}
              <div className="mt-10">{boundary}</div>
            </section>
          )}
          {step === 3 && (
            <section className="mt-10 max-w-xl">
              <Heading level={1}>{preview?.chapters.length === 0 ? '确认撤回全部章节' : '确认发布'}</Heading>
              <p className="mt-2 text-ui text-ink-2">
                《{preview?.metadata.title}》· {preview?.chapters.length} 章
              </p>
              <p className="mt-1 break-all text-ui-sm text-ink-3">
                公开地址：{window.location.origin}/books/{preview?.metadata.slug}
              </p>
              {preview?.chapters.length === 0 && <p className="mt-4 text-ui text-warn">确认后，作品页和全部章节将对读者隐藏。草稿与公开版本历史会保留。</p>}
              <div className="mt-8 space-y-4 text-ui">
                <Choice
                  checked={ack.rights}
                  onChange={(rights) => setAck((a) => ({ ...a, rights }))}
                >
                  我拥有这些内容的发布权利，并同意 story2u 的版权与内容政策。
                </Choice>
                <Choice
                  checked={ack.scope}
                  onChange={(scope) => setAck((a) => ({ ...a, scope }))}
                >
                  {preview?.chapters.length === 0
                    ? '我了解：确认后，作品与全部章节将无法公开访问；已被他人保存的副本无法收回。私人草稿不会删除。'
                    : '我了解：发布后任何人都可以阅读和分享这些章节，搜索引擎可以收录。笔记、设定和未选草稿不会公开。'}
                </Choice>
              </div>
              <div className="mt-6">
                <div className="mb-1.5 text-ui-sm text-ink-2">这次发布的说明（仅你可见）</div>
                <div className="rounded-md bg-surface-2 px-3 py-2">
                  <TextArea
                    label="发布说明（仅你可见）"
                    value={note}
                    maxLength={2000}
                    disabled={busy}
                    onChange={(value) => {
                      setNote(value)
                      setKey(crypto.randomUUID())
                    }}
                  />
                </div>
              </div>
              <p className="mt-6 text-micro text-ink-3">
                发布只由你手动完成。Agent 不会替你发布。
              </p>
            </section>
          )}
          {notice && (
            <p role="status" className="mt-6 text-ui text-ink-2">
              {notice}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="mt-6 rounded-md bg-danger-soft p-3 text-ui text-danger"
            >
              {error}
            </p>
          )}
          <div className="mt-12 flex flex-wrap items-center gap-2 border-t border-line-soft pt-6">
            <Btn
              disabled={busy}
              onClick={() => {
                if (step) {
                  setStep((s) => s - 1)
                  setAck({ rights: false, scope: false })
                } else if (current) setWizard(false)
                else location.assign('/studio')
              }}
            >
              {step ? '上一步' : '取消'}
            </Btn>
            <span className="ml-auto text-ui-sm text-ink-3">
              {step === 3 && (!ack.rights || !ack.scope) ? '请确认以上两项' : ''}
            </span>
            {step < 3 ? (
              <Btn
                variant="primary"
                disabled={busy || suggesting}
                onClick={() => void next()}
              >
                {busy ? '生成预览…' : '下一步'}
              </Btn>
            ) : (
              <Btn
                variant="primary"
                disabled={busy || !ack.rights || !ack.scope || !preview}
                onClick={() => void publish()}
              >
                {busy ? (preview?.chapters.length === 0 ? '正在撤回…' : '正在发布…') : error ? '重试提交' : preview?.chapters.length === 0 ? '确认撤回' : current ? '发布更新' : '发布'}
              </Btn>
            )}
          </div>
        </main>
      )}
      {confirm && current && (
        <Dialog
          label={confirm.kind === 'withdraw' ? '取消公开章节' : confirm.kind === 'unlist' ? '下架作品' : '重新上架'}
          title={confirm.kind === 'withdraw' ? `取消公开《${confirm.title}》？` : confirm.kind === 'unlist' ? '下架整部作品？' : '重新上架这部作品？'}
          onClose={() => { if (!busy) setConfirm(null) }}
          actions={<>
            <Btn variant="outline" disabled={busy} onClick={() => setConfirm(null)}>返回</Btn>
            <Btn
              variant={confirm.kind === 'relist' ? 'primary' : 'danger'}
              loading={busy}
              onClick={() => {
                if (confirm.kind === 'withdraw') {
                  const chapterId = confirm.chapterId
                  open(current.chapters.filter((chapter) => chapter.chapterId !== chapterId).map((chapter) => chapter.chapterId))
                } else void transition(confirm.kind)
              }}
            >
              {confirm.kind === 'withdraw' ? '继续预览与确认' : confirm.kind === 'unlist' ? '下架作品' : '重新上架'}
            </Btn>
          </>}
        >
          <p>
            {confirm.kind === 'withdraw'
              ? '读者将无法再打开这一章，目录中也不再显示。接下来请预览新的公开范围并确认发布；你的草稿不受影响，之后可以重新发布。已被他人保存的副本无法收回。'
              : confirm.kind === 'unlist'
                ? '作品页、所有章节和作者页中的这部作品将对读者不可见，并从公开索引中移除。私人草稿与公开版本历史会保留，你可以重新上架。已被他人保存的副本无法收回。'
                : '读者将重新看到上一次确认的公开快照。新草稿和之后的修改不会随之公开。'}
          </p>
          {error && <p role="alert" className="mt-4 rounded-md bg-danger-soft p-3 text-danger">{error}</p>}
        </Dialog>
      )}
    </div>
  )
}
