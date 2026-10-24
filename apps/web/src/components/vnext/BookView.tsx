import { useMemo, useState, type ReactNode } from 'react'
import type { CanonChange, Chapter, Entry, Note, Source } from '../../features/vnext/model'
import { kindLabel, statusLabel, type RelatedGroups } from '../../mocks/vnextRelevance'
import { RelatedList } from './ChapterDrawer'
import { Btn, Dot, Heading, Icon, Proto, Quote, Row, TextInput, ago, cn } from './ui'

export type BookSection =
  | 'chapter'
  | 'people'
  | 'world'
  | 'timeline'
  | 'plot'
  | 'threads'
  | 'notes'
  | 'history'
export type BookNav = { section: BookSection; entryId?: string; changeId?: string }

const SECTIONS: {
  id: BookSection
  label: string
  icon: 'target' | 'users' | 'globe' | 'clock' | 'layers' | 'thread' | 'note' | 'history'
  desc: string
  search?: string
}[] = [
  {
    id: 'chapter',
    label: '本章相关',
    icon: 'target',
    desc: '写这一章时值得记住的人物、事件、设定与伏笔，每条都附有原文依据。',
  },
  {
    id: 'people',
    label: '人物',
    icon: 'users',
    desc: '从正文整理出的人物档案，区分正文写明的、角色自己说的和 AI 的推测。',
    search: '按名字、别名或身份查找',
  },
  {
    id: 'world',
    label: '世界与规则',
    icon: 'globe',
    desc: '地点、组织与世界规则。没有原文依据的条目会明确标出。',
    search: '查找地点、组织或规则',
  },
  {
    id: 'timeline',
    label: '时间线',
    icon: 'clock',
    desc: '按章节顺序排列的事件。时间不明确的地方，不会替你补上日期。',
    search: '查找事件、人物或地点',
  },
  {
    id: 'plot',
    label: '剧情结构',
    icon: 'layers',
    desc: '剧情线与线索，以及支撑它们的章节和原文证据。',
    search: '查找剧情线或线索',
  },
  {
    id: 'threads',
    label: '伏笔',
    icon: 'thread',
    desc: 'AI 发现的候选伏笔和后续相关原文。是否回收、何时回收，由你判断。',
    search: '查找伏笔',
  },
  {
    id: 'notes',
    label: '创作笔记',
    icon: 'note',
    desc: '你的想法与下一章计划。笔记不会自动成为作品设定。',
    search: '查找笔记',
  },
  {
    id: 'history',
    label: '变更历史',
    icon: 'history',
    desc: '知识整理、引用失效、你的纠正和任务失败，都按时间记在这里。',
    search: '查找记录',
  },
]

type P = {
  knowledgeContent?: ReactNode
  historyContent?: ReactNode
  noteContent?: ReactNode
  unavailable?: boolean
  nav: BookNav
  setNav: (n: BookNav) => void
  entries: Entry[]
  chapters: Chapter[]
  current?: Chapter
  related: RelatedGroups
  notes: Note[]
  changes: CanonChange[]
  onChapter: (no: number, para?: number) => void
  onSource: (s: Source) => void
  onThink: (topic: string, quote?: string) => void
  onPropose: (noteId: string) => void
  onDecide: (id: string, s: CanonChange['status']) => void
  onArchive: (id: string) => void
  onBackToWriting: () => void
  workTitle?: string
}

export default function BookView(p: P) {
  const { nav, setNav } = p
  const section = SECTIONS.find((item) => item.id === nav.section) ?? SECTIONS[0]
  const entry = nav.entryId ? p.entries.find((e) => e.id === nav.entryId) : undefined
  const change = nav.changeId ? p.changes.find((c) => c.id === nav.changeId) : undefined
  const apiPanel =
    p.knowledgeContent && !entry && !change && nav.section !== 'notes'
      ? p.knowledgeContent
      : null
  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="书的分区"
        className="scroll hidden w-56 shrink-0 flex-col overflow-auto border-r border-line-soft px-3 py-6 md:flex"
      >
        <div className="px-3 pb-3 text-micro text-ink-3">知识分类</div>
        {SECTIONS.map((item) => (
          <Row
            key={item.id}
            active={nav.section === item.id && !entry && !change}
            onClick={() => setNav({ section: item.id })}
            className="flex items-center gap-2.5 px-3 py-2 text-ui"
          >
            <Icon
              name={item.icon}
              className={nav.section === item.id ? 'text-accent' : 'text-ink-3'}
            />
            <span
              className={
                nav.section === item.id ? 'font-medium text-ink' : 'text-ink-2'
              }
            >
              {item.label}
            </span>
            {item.id === 'chapter' && p.current && (
              <span className="ml-auto text-micro tabular-nums text-ink-3">
                {cn(p.current.no)}
              </span>
            )}
          </Row>
        ))}
        <div className="mt-auto px-3 pt-8">
          <Btn variant="link" className="text-ui-sm" onClick={p.onBackToWriting}>
            <Icon name="back" className="h-3 w-3" />
            回到正文
          </Btn>
          <p className="mt-3 text-micro text-ink-3">
            知识由 AI 从已保存正文整理，不会修改正文。
          </p>
        </div>
      </nav>
      <main
        className={`min-w-0 flex-1 ${
          apiPanel ? 'min-h-0 overflow-hidden' : 'scroll overflow-auto'
        }`}
      >
        {apiPanel ? (
          apiPanel
        ) : (
          <>
            <header className="border-b border-line-soft px-5 pt-5 pb-4 md:px-8 md:pt-7">
              <div className="mx-auto max-w-3xl">
                <p className="truncate text-ui-sm text-ink-3">
                  {p.workTitle || '当前作品'} <span className="text-ink-4">/</span> 书
                </p>
                <label className="mt-3 block md:hidden">
                  <span className="sr-only">知识分类</span>
                  <select
                    aria-label="知识分类"
                    value={nav.section}
                    onChange={(event) =>
                      setNav({ section: event.target.value as BookSection })
                    }
                    className="w-full rounded-md border border-line bg-surface px-3 py-2 text-ui text-ink"
                  >
                    {SECTIONS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Heading level={1}>
                    {section.id === 'chapter' && p.current
                      ? `${cn(p.current.no)}${p.current.title ? ` · ${p.current.title}` : ''}`
                      : section.label}
                  </Heading>
                </div>
                <p className="mt-1 text-ui text-ink-3">
                  {section.id === 'chapter' ? '本章相关 · ' : ''}
                  {section.desc}
                </p>
              </div>
            </header>
            <div className="mx-auto max-w-3xl px-5 pt-6 pb-24 md:px-8">
              {change ? (
                <CanonChangePage
                  c={change}
                  entry={p.entries.find((e) => e.id === change.entryId)}
                  {...p}
                />
              ) : entry ? (
                <EntryPage e={entry} {...p} />
              ) : (
                <Section {...p} />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function Section(p: P) {
  const s = p.nav.section
  const [q, setQ] = useState('')
  const open = (id: string) => p.setNav({ ...p.nav, entryId: id })
  const filter = (l: Entry[]) =>
    q ? l.filter((e) => e.name.includes(q) || e.summary.includes(q)) : l
  if (s === 'notes' && p.noteContent) return <>{p.noteContent}</>
  if (p.knowledgeContent) return <>{p.knowledgeContent}</>
  if (p.unavailable)
    return (
      <>
        <Header
          title={SECTIONS.find((item) => item.id === s)?.label ?? '作品记忆'}
          sub="作品知识与来源查询尚未接入。此处不会以演示资料填充真实作品。"
        />
        <p className="text-ui text-ink-3">尚未实现 · 不调用 Agent，也不修改正式设定。</p>
      </>
    )
  if (s === 'chapter')
    return (
      <>
        <Header
          title={`写${p.current ? cn(p.current.no) : '这一章'}时，需要记住的`}
          sub="根据本章正文与已确认设定聚合。每类最多五条，每条都写明依据。"
        />
        <RelatedList related={p.related} onEntry={open} />
      </>
    )
  if (s === 'people' || s === 'world') {
    const list = filter(
      p.entries.filter((e) =>
        s === 'people'
          ? e.kind === 'person'
          : e.kind === 'rule' || e.kind === 'place' || e.kind === 'fact',
      ),
    ).sort((a, b) => (b.lastConfirmed ?? 0) - (a.lastConfirmed ?? 0))
    return (
      <>
        <Header
          title={s === 'people' ? '人物' : '世界与规则'}
          sub={`${list.length} 条 · 按最近确认排序`}
        />
        <TextInput
          label="查找"
          value={q}
          onChange={setQ}
          placeholder={s === 'people' ? '按名字或描述查找' : '查找规则、地点或事实'}
          className="mb-6 max-w-sm"
        />
        <EntryList list={list} onOpen={open} />
      </>
    )
  }
  if (s === 'threads') {
    const now = p.current?.no ?? 0
    const open_ = p.entries.filter((e) => e.kind === 'thread' && e.thread?.state === 'open')
    const due = open_.filter((e) => now >= e.thread!.window[0] && now <= e.thread!.window[1])
    const overdue = open_.filter((e) => now > e.thread!.window[1])
    const later = open_.filter((e) => now < e.thread!.window[0])
    const paid = p.entries.filter((e) => e.kind === 'thread' && e.thread?.state === 'paid')
    return (
      <>
        <Header
          title="伏笔"
          sub="只有到了你自己定下的回收时机，伏笔才会出现在“本章相关”里。其余的安静地留在这里。"
        />
        {[
          ['到了回收时机', due],
          ['已经过了你定的时机', overdue],
          ['还没到时机', later],
          ['已回收', paid],
        ].map(
          ([t, l]) =>
            (l as Entry[]).length > 0 && (
              <section key={t as string} className="mb-10">
                <Heading level={3} className="mb-2">
                  {t as string} · {(l as Entry[]).length}
                </Heading>
                <ul>
                  {(l as Entry[]).map((e) => (
                    <li key={e.id}>
                      <Row
                        onClick={() => open(e.id)}
                        className="-mx-2 flex items-baseline gap-3 px-2 py-2"
                      >
                        <span className="font-prose text-ui-lg text-ink">{e.name}</span>
                        <span className="ml-auto shrink-0 text-micro tabular-nums text-ink-3">
                          埋于{cn(e.thread!.planted)} · 时机 {e.thread!.window[0]}–
                          {e.thread!.window[1]}
                        </span>
                      </Row>
                    </li>
                  ))}
                </ul>
              </section>
            ),
        )}
      </>
    )
  }
  if (s === 'timeline') {
    const named = p.chapters.filter((c) => !c.placeholder && c.setting)
    return (
      <>
        <Header title="时间线" sub="来自章节的时间地点，以及已确认的事实。只列出有依据的条目。" />
        <ol className="border-l border-line pl-6">
          {named.map((c) => (
            <li key={c.id} className="relative mb-7">
              <span className="absolute top-2 -left-[1.6rem]">
                <Dot tone="quiet" />
              </span>
              <div className="text-ui-sm text-ink-3">{c.setting}</div>
              <Btn
                variant="link"
                className="font-prose text-ui-lg text-ink"
                onClick={() => p.onChapter(c.no)}
              >
                {cn(c.no)} {c.title}
              </Btn>
              {p.entries
                .filter((e) => e.kind === 'fact' && e.firstSeen === c.no)
                .map((e) => (
                  <p key={e.id} className="mt-1 text-ui text-ink-2">
                    事实：{e.summary}
                  </p>
                ))}
            </li>
          ))}
        </ol>
        <p className="text-ui-sm text-ink-3">
          长篇规模演示中的其余 {p.chapters.filter((c) => c.placeholder).length}{' '}
          章没有时间信息，不在此臆造。
        </p>
      </>
    )
  }
  if (s === 'plot') {
    const vols = [...new Set(p.chapters.map((c) => c.volume))]
    return (
      <>
        <Header title="剧情结构" sub="卷与主线、支线。" />
        <EntryList list={p.entries.filter((e) => e.kind === 'plot')} onOpen={open} />
        <Heading level={3} className="mt-10 mb-2">
          分卷
        </Heading>
        <ul className="space-y-1">
          {vols.map((v) => {
            const cs = p.chapters.filter((c) => c.volume === v)
            return (
              <li key={v} className="flex items-baseline gap-3 py-1.5">
                <span className="font-prose text-ui-lg text-ink">{v}</span>
                <span className="ml-auto text-micro tabular-nums text-ink-3">
                  {cn(cs[0].no)} — {cn(cs[cs.length - 1].no)} · {cs.length} 章
                </span>
              </li>
            )
          })}
        </ul>
      </>
    )
  }
  if (s === 'notes') return <NotesPage {...p} />
  return <HistoryPage {...p} />
}

function Header({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="mb-8">
      <Heading level={1}>{title}</Heading>
      {sub && <p className="mt-1 text-ui text-ink-3">{sub}</p>}
    </header>
  )
}

function EntryList({ list, onOpen }: { list: Entry[]; onOpen: (id: string) => void }) {
  if (!list.length) return <p className="text-ui text-ink-3">没有条目。</p>
  return (
    <ul>
      {list.map((e) => (
        <li key={e.id}>
          <Row onClick={() => onOpen(e.id)} className="-mx-2 px-2 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="font-prose text-ui-lg text-ink">{e.name}</span>
              {e.status !== 'confirmed' && (
                <span className="text-micro text-ink-3">{statusLabel[e.status]}</span>
              )}
              {e.demo && <span className="text-micro text-ink-3">演示</span>}
              <span className="ml-auto shrink-0 text-micro text-ink-3">
                {e.firstSeen ? `首次出现：${cn(e.firstSeen)}` : ''}
                {e.lastConfirmed ? ` · 最后确认：${cn(e.lastConfirmed)}` : ''}
              </span>
            </div>
            <div className="mt-0.5 truncate text-ui-sm text-ink-2">{e.summary}</div>
          </Row>
        </li>
      ))}
    </ul>
  )
}

function EntryPage({ e, ...p }: P & { e: Entry }) {
  const related = e.related
    .map((id) => p.entries.find((x) => x.id === id))
    .filter(Boolean) as Entry[]
  const back = () => p.setNav({ section: p.nav.section })
  return (
    <article className="fade">
      <Btn variant="quiet" className="-ml-3 mb-6" onClick={back}>
        <Icon name="back" />
        {SECTIONS.find((item) => item.id === p.nav.section)?.label}
      </Btn>
      <div className="text-ui-sm text-ink-3">
        {kindLabel[e.kind]} · {statusLabel[e.status]}
        {e.demo && ' · 演示数据'}
      </div>
      <Heading level={1} className="mt-1">
        {e.name}
      </Heading>
      <p className="mt-3 font-prose text-read text-ink-2">{e.summary}</p>

      <dl className="mt-8 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2.5 text-ui">
        {e.firstSeen && (
          <>
            <dt className="text-ink-3">首次出现</dt>
            <dd>
              <Btn variant="link" onClick={() => p.onChapter(e.firstSeen!)}>
                {cn(e.firstSeen)}
              </Btn>
            </dd>
          </>
        )}
        {e.lastConfirmed && (
          <>
            <dt className="text-ink-3">最后确认</dt>
            <dd className="text-ink">{cn(e.lastConfirmed)}</dd>
          </>
        )}
        {e.thread && (
          <>
            <dt className="text-ink-3">回收时机</dt>
            <dd className="text-ink">
              你定在第 {e.thread.window[0]}–{e.thread.window[1]} 章 ·{' '}
              {e.thread.state === 'paid' ? '已回收' : '未回收'}
            </dd>
          </>
        )}
        {e.chapters.length > 0 && (
          <>
            <dt className="text-ink-3">出现在</dt>
            <dd className="flex flex-wrap gap-x-3">
              {e.chapters.map((n) => (
                <Btn key={n} variant="link" onClick={() => p.onChapter(n)}>
                  {cn(n)}
                </Btn>
              ))}
            </dd>
          </>
        )}
        {related.length > 0 && (
          <>
            <dt className="text-ink-3">关联</dt>
            <dd className="flex flex-wrap gap-x-3">
              {related.map((r) => (
                <Btn
                  key={r.id}
                  variant="link"
                  onClick={() => p.setNav({ ...p.nav, entryId: r.id })}
                >
                  {r.name}
                </Btn>
              ))}
            </dd>
          </>
        )}
        {e.fields.map((f) => (
          <div key={f.label} className="contents">
            <dt className="text-ink-3">{f.label}</dt>
            <dd className={f.value === '未确定' ? 'text-ink-3' : 'text-ink'}>
              {f.value}
              {f.source && (
                <Btn
                  variant="link"
                  className="ml-2 text-micro"
                  onClick={() => p.onSource(f.source!)}
                >
                  {f.source.label}
                </Btn>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <section className="mt-12">
        <Heading level={3} className="mb-3">
          来源
        </Heading>
        {e.sources.length ? (
          <div className="space-y-4">
            {e.sources.map((s, i) => (
              <Quote
                key={i}
                label={s.label}
                state={s.state}
                onOpen={s.chapterId ? () => p.onSource(s) : undefined}
              >
                {s.quote}
              </Quote>
            ))}
          </div>
        ) : (
          <p className="text-ui text-ink-3">没有登记原文来源。这条知识目前只有你的设定描述。</p>
        )}
      </section>

      <section className="mt-12">
        <Heading level={3} className="mb-3">
          变更历史
        </Heading>
        {e.history.length ? (
          <ol className="space-y-2">
            {e.history.map((h, i) => (
              <li key={i} className="grid grid-cols-[6rem_1fr] gap-3 text-ui">
                <span className="text-ink-3">{h.at}</span>
                <span className="text-ink">
                  {h.text}
                  {h.chapter && <span className="text-ink-3"> · 依据{cn(h.chapter)}</span>}
                  {h.simulated && (
                    <span className="ml-2">
                      <Proto>模拟写入</Proto>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-ui text-ink-3">尚无变更。</p>
        )}
      </section>

      <div className="mt-12 flex flex-wrap gap-2">
        <Btn variant="outline" onClick={() => p.onThink(`关于${e.name}`, e.summary)}>
          就此思考
        </Btn>
      </div>
      <p className="mt-3 text-micro text-ink-3">
        要修改这条已确认的知识，请先记一条笔记，再从笔记提出定稿变更。
      </p>
    </article>
  )
}

function NotesPage(p: P) {
  const [archived, setArchived] = useState(false)
  const list = useMemo(
    () => p.notes.filter((n) => !!n.archived === archived).sort((a, b) => b.at - a.at),
    [p.notes, archived],
  )
  const originLabel = {
    quick: '随手记',
    margin: '来自注记',
    thinking: '思考结论',
    conflict: '来自冲突判断',
  }
  return (
    <>
      <Header
        title="创作笔记"
        sub="念头、疑问和结论。笔记不是设定，不需要审批，也不会被 AI 当作作品事实。"
      />
      <div className="mb-6 flex gap-3 text-ui-sm">
        <Btn size="sm" variant={archived ? 'quiet' : 'outline'} onClick={() => setArchived(false)}>
          进行中
        </Btn>
        <Btn size="sm" variant={archived ? 'outline' : 'quiet'} onClick={() => setArchived(true)}>
          已归档
        </Btn>
      </div>
      <ul className="space-y-8">
        {list.map((n) => {
          const ch = p.chapters.find((c) => c.id === n.chapterId)
          const cc = n.canonChangeId ? p.changes.find((c) => c.id === n.canonChangeId) : undefined
          return (
            <li key={n.id} className="border-l-2 border-ink-4 pl-4">
              <p className="font-prose text-read text-ink">{n.text}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-micro text-ink-3">
                {n.nextUp && <span className="text-ink-2">下次要写</span>}
                <span>{originLabel[n.origin]}</span>
                {ch && (
                  <span>
                    · {cn(ch.no)}
                    {n.para !== undefined && ` 第 ${n.para + 1} 段`}
                  </span>
                )}
                <span>· {ago(n.at)}</span>
                {cc && (
                  <span className={cc.status === 'confirmed' ? 'text-ok' : 'text-warn'}>
                    · 定稿变更
                    {
                      {
                        draft: '待你确认',
                        confirmed: '已确认（模拟）',
                        deferred: '已暂缓',
                        abandoned: '已放弃',
                      }[cc.status]
                    }
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {ch && (
                  <Btn size="sm" onClick={() => p.onChapter(ch.no, n.para)}>
                    回到原文
                  </Btn>
                )}
                <Btn size="sm" onClick={() => p.onThink(n.text, n.quote)}>
                  继续讨论
                </Btn>
                {cc ? (
                  <Btn size="sm" onClick={() => p.setNav({ section: 'notes', changeId: cc.id })}>
                    查看定稿变更
                  </Btn>
                ) : n.id === 'n-know' ? (
                  <Btn size="sm" onClick={() => p.onPropose(n.id)}>
                    这是一个设定变更…
                  </Btn>
                ) : null}
                <Btn size="sm" onClick={() => p.onArchive(n.id)}>
                  {n.archived ? '取消归档' : '归档'}
                </Btn>
              </div>
            </li>
          )
        })}
        {list.length === 0 && (
          <li className="text-ui text-ink-3">
            {archived ? '没有归档的笔记。' : '还没有笔记。写作时按 ⌘; 随手记下。'}
          </li>
        )}
      </ul>
      <p className="mt-10 text-micro text-ink-3">
        原型说明：只有“林氏其实早就知道……”这条笔记接入了定稿变更的演示数据。
      </p>
    </>
  )
}

function HistoryPage(p: P) {
  const rows = [
    ...p.changes
      .filter((c) => c.status !== 'draft')
      .map((c) => ({
        at: c.decidedAt ? ago(c.decidedAt) : '',
        who: p.entries.find((e) => e.id === c.entryId)?.name ?? '',
        text: `${c.field}：${{ confirmed: '确认变更', deferred: '暂缓', abandoned: '放弃', draft: '' }[c.status]}`,
        sim: c.status === 'confirmed',
        id: c.id,
      })),
    ...p.entries.flatMap((e) =>
      e.history
        .filter((h) => !h.simulated)
        .map((h) => ({ at: h.at, who: e.name, text: h.text, sim: false, id: '' })),
    ),
  ]
  return (
    <>
      <Header
        title="变更历史"
        sub="每一次对已确认知识的改变，都由你决定，并记在这里。原先的“决策记录”已并入此处。"
      />
      <ol className="space-y-3">
        {rows.map((r, i) => (
          <li key={i} className="grid grid-cols-[6rem_8rem_1fr] gap-3 text-ui">
            <span className="text-ink-3">{r.at}</span>
            <span className="truncate font-prose text-ink">{r.who}</span>
            <span className="text-ink-2">
              {r.text}
              {r.sim && (
                <span className="ml-2">
                  <Proto>模拟写入</Proto>
                </span>
              )}
              {r.id && (
                <Btn
                  variant="link"
                  className="ml-2 text-ui-sm"
                  onClick={() => p.setNav({ section: 'history', changeId: r.id })}
                >
                  详情
                </Btn>
              )}
            </span>
          </li>
        ))}
      </ol>
      {p.historyContent}
    </>
  )
}

function CanonChangePage({ c, entry, ...p }: P & { c: CanonChange; entry?: Entry }) {
  const decided = c.status !== 'draft'
  const unavailableEvidence = c.sources.some((source) => source.state !== 'ok')
  return (
    <article className="fade" aria-label="定稿变更">
      <Btn
        variant="quiet"
        className="-ml-3 mb-6"
        onClick={() => p.setNav({ section: p.nav.section })}
      >
        <Icon name="back" />
        返回
      </Btn>
      <div className="flex flex-wrap items-center gap-3 text-ui-sm text-ink-3">
        <span>定稿变更 · {entry?.name}</span>
        <Proto>原型 · 不会写入真实知识库</Proto>
      </div>
      <Heading level={1} className="mt-1">
        {c.field}
      </Heading>
      <p className="mt-2 text-ui text-ink-3">{c.reason}</p>

      <div className="mt-10 overflow-hidden rounded-lg border border-line">
        <div className="grid sm:grid-cols-2">
          <div className="border-b border-line p-5 sm:border-r sm:border-b-0">
            <div className="text-micro text-ink-3">现在已确认的</div>
            <p className="mt-2 font-prose text-ui-lg text-ink-3 line-through decoration-ink-4">
              {c.current}
            </p>
          </div>
          <div className="bg-surface p-5">
            <div className="text-micro text-ink-3">变更为</div>
            <p className="mt-2 font-prose text-ui-lg text-ink">{c.proposed}</p>
          </div>
        </div>
      </div>

      <section className="mt-10">
        <Heading level={3} className="mb-3">
          依据
        </Heading>
        <div className="space-y-4">
          {c.sources.map((s, i) => (
            <Quote
              key={i}
              label={s.label}
              state={s.state}
              onOpen={s.chapterId ? () => p.onSource(s) : undefined}
            >
              {s.quote}
            </Quote>
          ))}
        </div>
      </section>

      <section className="mt-10 grid gap-8 sm:grid-cols-[10rem_1fr]">
        <div>
          <Heading level={3} className="mb-2">
            涉及章节
          </Heading>
          <div className="flex flex-wrap gap-x-3">
            {c.chapters.map((n) => (
              <Btn key={n} variant="link" onClick={() => p.onChapter(n)}>
                {cn(n)}
              </Btn>
            ))}
          </div>
        </div>
        <div>
          <Heading level={3} className="mb-2">
            可能的影响 · AI 推断
          </Heading>
          <ul className="space-y-1.5">
            {c.impact.map((t, i) => (
              <li key={i} className="border-l-2 border-dashed border-ai pl-3 text-ui text-ink-2">
                {t}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="mt-12 border-t border-line pt-6">
        {decided ? (
          <p className="flex items-center gap-2 text-ui text-ink">
            <Icon name="check" />
            {
              {
                confirmed: '你已确认此变更。原型中已模拟更新该条目，并记入变更历史。',
                deferred: '你已暂缓此变更。现有设定保持不变。',
                abandoned: '你已放弃此变更。现有设定保持不变，笔记仍保留。',
                draft: '',
              }[c.status]
            }
            {c.status !== 'confirmed' && (
              <Btn variant="link" className="ml-2" onClick={() => p.onDecide(c.id, 'draft')}>
                重新考虑
              </Btn>
            )}
          </p>
        ) : (
          <>
            <p className="mb-4 text-ui text-ink-2">
              确认后，“{entry?.name}”的「{c.field}
              」将更新，并在变更历史中记下这次决定。正文不会被修改。
            </p>
            {unavailableEvidence && (
              <p className="mb-4 text-ui-sm text-warn">
                存在过期或未核验依据，确认暂不可用；可以先暂缓或放弃这份演示候选。
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Btn
                variant="primary"
                disabled={unavailableEvidence}
                onClick={() => p.onDecide(c.id, 'confirmed')}
              >
                确认变更
              </Btn>
              <Btn variant="outline" onClick={() => p.onDecide(c.id, 'deferred')}>
                暂缓
              </Btn>
              <Btn variant="quiet" onClick={() => p.onDecide(c.id, 'abandoned')}>
                放弃
              </Btn>
            </div>
          </>
        )}
      </div>
    </article>
  )
}
