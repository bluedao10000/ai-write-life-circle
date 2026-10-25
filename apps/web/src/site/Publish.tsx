import { useEffect, useRef, useState } from 'react'
import type {
  PublicationManagement,
  PublicationMetadata,
  PublicationPreview,
  PublicationVersion,
} from '@writer-agent/contracts'
import { publicationMetadataSchema } from '@writer-agent/contracts'
import { Btn, Choice, Heading, Icon, TextArea } from '../components/vnext/ui'
import {
  getPublication,
  previewPublication,
  commitPublication,
  transitionPublication,
} from '../services/api/publicationApi'
import { Cover } from './kit'
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
    [success, setSuccess] = useState<PublicationVersion | null>(null)
  const [note, setNote] = useState('')
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
      setMeta(version?.metadata ?? initial)
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
  const open = (ids: string[]) => {
    setSelected(ids)
    setStep(0)
    setPreview(null)
    setAck({ rights: false, scope: false })
    setKey(crypto.randomUUID())
    setWizard(true)
    setError('')
    setSuccess(null)
  }
  const changeMeta = (patch: Partial<PublicationMetadata>) => {
    setMeta((m) => ({ ...m, ...patch }))
    setPreview(null)
    setAck({ rights: false, scope: false })
  }
  const next = async () => {
    setError('')
    if (step === 1) {
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
      if (mounted.current) setSuccess(value)
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
    if (
      !base ||
      !window.confirm(
        action === 'unlist'
          ? '下架整部作品？读者将无法访问，草稿不受影响。已被他人保存的副本无法收回。'
          : '重新上架上一次确认的公开快照？不会自动发布新草稿。',
      )
    )
      return
    setBusy(true)
    setError('')
    try {
      await transitionPublication(project, action, base, key)
      if (mounted.current) {
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
              {preview?.chapters.length ?? selected.length}{' '}
              个选中章节的已保存正文快照
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
      <header className="flex h-12 items-center gap-2 px-3">
        <a href="/studio" className="text-ui text-ink-2">
          ← 回到写作
        </a>
        <span className="text-ui-sm text-ink-3">Writer Studio · 发布</span>
        <a href="/" className="ml-auto text-ui-sm text-ink-2">
          story2u 首页
        </a>
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
          <div className="mt-8 flex justify-center gap-4">
            <a href="/" className="text-accent">
              在首页查看
            </a>
            <a href={success.publicUrl} className="text-accent">
              作品页
            </a>
            <Btn
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
          <div className="text-ui-sm text-ink-3">
            {current.state === 'listed' ? '● 公开中' : '已下架 · 读者不可见'} ·
            公开版本 v{current.versionNumber}
          </div>
          <Heading level={1} className="mt-2">
            {current.metadata.title}
          </Heading>
          <div className="mt-6 flex flex-wrap gap-2">
            <a
              href={`/books/${current.metadata.slug}`}
              className="rounded-md border border-line px-3 py-2 text-ui"
            >
              以读者身份查看
            </a>
            <Btn onClick={() => open(current.chapters.map((c) => c.chapterId))}>
              修改公开资料与章节…
            </Btn>
            <Btn
              disabled={busy}
              onClick={() =>
                void transition(
                  current.state === 'listed' ? 'unlist' : 'relist',
                )
              }
            >
              {current.state === 'listed' ? '下架作品…' : '重新上架'}
            </Btn>
          </div>
          <section className="mt-12">
            <Heading level={2}>章节</Heading>
            <p className="mt-2 text-ui-sm text-ink-3">
              自动保存永远不会改变公开快照。更新或撤回都需重新预览和确认。
            </p>
            <div className="mt-5 divide-y divide-line-soft">
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
                    className="flex flex-wrap items-center gap-3 py-3 text-ui"
                  >
                    <span className="font-prose">{d.title}</span>
                    <span
                      className={
                        changed
                          ? 'text-warn'
                          : published
                            ? 'text-ok'
                            : 'text-ink-3'
                      }
                    >
                      {published
                        ? changed
                          ? '已公开 · 草稿有新的修改'
                          : '已公开 · 与草稿一致'
                        : !d.isEmpty
                          ? '草稿 · 未公开'
                          : '空章节'}
                    </span>
                    <div className="ml-auto flex gap-2">
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
                          onClick={() => {
                            if (
                              window.confirm(
                                '取消公开此章？将进入重新预览与确认流程，草稿不受影响。',
                              )
                            )
                              open(
                                current.chapters
                                  .filter((c) => c.chapterId !== d.chapterId)
                                  .map((c) => c.chapterId),
                              )
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
                    <li key={v.versionId} className="text-ui">
                      v{v.versionNumber} · {v.chapters.length}章{' '}
                      {v.note ? `· ${v.note}` : ''} ·{' '}
                      {v.state === 'listed' ? '公开' : '下架'}
                      <span className="block text-micro text-ink-3">
                        {v.createdAt}
                      </span>
                    </li>
                  ))}
              </ol>
            </div>
            {boundary}
          </section>
          {error && (
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
                className={i === step ? 'font-medium text-ink' : 'text-ink-3'}
              >
                {i + 1}. {s}
              </li>
            ))}
          </ol>
          {step === 0 && (
            <section className="mt-10 grid gap-10 md:grid-cols-[1fr_12rem]">
              <div className="space-y-6">
                <Heading level={1}>读者会看到的资料</Heading>
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
                        onChange={(v) => changeMeta({ [field]: v })}
                      />
                    </div>
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
                <div className="flex gap-2">
                  {(['ongoing', 'completed', 'paused'] as const).map(
                    (status, i) => (
                      <Btn
                        key={status}
                        variant={
                          meta.serialStatus === status ? 'primary' : 'outline'
                        }
                        onClick={() => changeMeta({ serialStatus: status })}
                      >
                        {['连载中', '已完结', '暂停中'][i]}
                      </Btn>
                    ),
                  )}
                </div>
              </div>
              <div>
                <div className="mb-2 text-ui-sm text-ink-3">封面</div>
                <Cover book={coverBook} />
                <div className="mt-3 rounded-md bg-surface-2 p-2">
                  <TextArea
                    label="公开封面 HTTPS 地址（可选）"
                    value={meta.coverUrl}
                    onChange={(v) => changeMeta({ coverUrl: v })}
                  />
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
                      className="w-8 px-0"
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
              <div className="mt-6 divide-y divide-line-soft">
                {loaded.drafts.map((d) => (
                  <Choice
                    key={d.chapterId}
                    checked={selected.includes(d.chapterId)}
                    onChange={(yes) => {
                      if (!d.isEmpty)
                        setSelected((ids) =>
                          yes
                            ? [...ids, d.chapterId]
                            : ids.filter((id) => id !== d.chapterId),
                        )
                      setPreview(null)
                      setAck({ rights: false, scope: false })
                    }}
                    className={`py-3 ${!d.isEmpty ? '' : 'opacity-50'}`}
                  >
                    <span className="block font-prose text-ui">{d.title}</span>
                    <span className="block break-all text-micro text-ink-3">
                      {(d.volumeTitle ?? d.volumeId) || '未分卷'} · {d.words}字
                      · {d.revisionId}
                    </span>
                  </Choice>
                ))}
              </div>
            </section>
          )}
          {step === 2 && preview && (
            <section className="mt-10">
              <Heading level={1}>读者将看到</Heading>
              <div className="mt-6 rounded-xl border border-line p-6 sm:p-10">
                <div className="grid gap-8 sm:grid-cols-[9rem_1fr]">
                  <Cover book={coverBook} />
                  <div>
                    <h2 className="font-prose text-display text-ink">
                      {preview.metadata.title}
                    </h2>
                    <div className="mt-1 text-ui-sm text-ink-3">
                      {preview.metadata.penName} · {preview.metadata.category}
                    </div>
                    <p className="mt-4 font-prose text-ui-lg">
                      {preview.metadata.tagline}
                    </p>
                    <p className="mt-2 text-ui text-ink-2">
                      {preview.metadata.description}
                    </p>
                    <ol className="mt-6">
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
                {preview.chapters.map((c) => (
                  <div
                    key={c.chapterId}
                    className="mt-10 border-t border-line-soft pt-8"
                  >
                    {volumeTitle(c) && (
                      <p className="mb-2 text-ui-sm text-ink-3">
                        {volumeTitle(c)}
                      </p>
                    )}
                    <h3 className="mb-4 font-prose text-title">{c.title}</h3>
                    {current?.chapters.find(
                      (old) =>
                        old.chapterId === c.chapterId &&
                        old.contentHash !== c.contentHash,
                    ) && (
                      <details className="mb-4">
                        <summary className="text-ui text-ink-3">
                          查看当前公开版本，与下方草稿快照对照
                        </summary>
                        <Markdown
                          markdown={
                            preview.previousChapters.find(
                              (old) => old.chapterId === c.chapterId,
                            )?.markdown ?? ''
                          }
                        />
                      </details>
                    )}
                    <div className="reader-text mx-auto max-w-read font-prose text-read">
                      <Markdown markdown={c.markdown} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-10">{boundary}</div>
            </section>
          )}
          {step === 3 && (
            <section className="mt-10 max-w-xl">
              <Heading level={1}>确认发布</Heading>
              <p className="mt-2 text-ui text-ink-2">
                《{preview?.metadata.title}》· {preview?.chapters.length}章
              </p>
              <div className="mt-8 space-y-4 text-ui">
                <Choice
                  checked={ack.rights}
                  onChange={(rights) => setAck((a) => ({ ...a, rights }))}
                >
                  我拥有这些内容的发布权利。
                </Choice>
                <Choice
                  checked={ack.scope}
                  onChange={(scope) => setAck((a) => ({ ...a, scope }))}
                >
                  我了解：发布后任何人都可以阅读和分享这些章节，搜索引擎可以收录。笔记、设定和未选草稿不会公开。
                </Choice>
              </div>
              <div className="mt-6 rounded-md bg-surface-2 p-3">
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
              <p className="mt-6 text-micro text-ink-3">
                发布只由你手动完成。Agent 不会替你发布。
              </p>
            </section>
          )}
          {error && (
            <p
              role="alert"
              className="mt-6 rounded-md bg-danger-soft p-3 text-ui text-danger"
            >
              {error}
            </p>
          )}
          <div className="mt-12 flex items-center gap-2 border-t border-line-soft pt-6">
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
            <span className="ml-auto" />
            {step < 3 ? (
              <Btn
                variant="primary"
                disabled={
                  busy ||
                  (step === 0 &&
                    !publicationMetadataSchema.safeParse(meta).success) ||
                  (step === 1 && selected.length === 0 && !current)
                }
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
                {busy ? '正在发布…' : error ? '重试发布' : '发布'}
              </Btn>
            )}
          </div>
        </main>
      )}
    </div>
  )
}
