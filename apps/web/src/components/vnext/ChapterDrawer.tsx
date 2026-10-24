import { useMemo, useState } from 'react'
import type { Chapter } from '../../features/vnext/model'
import type { RelatedGroups } from '../../mocks/vnextRelevance'
import { Btn, Dot, Heading, IconBtn, Row, Seg, TextInput, cn } from './ui'

export default function ChapterDrawer({
  chapters,
  current,
  onOpen,
  onClose,
  related,
  onEntry,
  tab,
  setTab,
  onAllKnowledge,
  unavailable,
}: {
  unavailable?: boolean
  chapters: Chapter[]
  current: string
  onOpen: (id: string) => void
  onClose: () => void
  related: RelatedGroups
  onEntry: (id: string) => void
  tab: 'toc' | 'related'
  setTab: (t: 'toc' | 'related') => void
  onAllKnowledge: () => void
}) {
  const [q, setQ] = useState('')
  const cur = chapters.find((c) => c.id === current)
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    cur ? { [cur.volume]: true } : {},
  )
  const volumes = useMemo(() => {
    const m = new Map<string, Chapter[]>()
    for (const c of chapters) {
      if (q && !(`${c.no}`.includes(q) || c.title.includes(q))) continue
      m.set(c.volume, [...(m.get(c.volume) ?? []), c])
    }
    return [...m.entries()]
  }, [chapters, q])

  return (
    <nav aria-label="书的地图" className="slide-l flex h-full w-full flex-col bg-paper">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <Seg
          size="sm"
          label="左侧内容"
          value={tab}
          onChange={setTab}
          options={[
            ['toc', '目录'],
            ['related', '本章相关'],
          ]}
        />
        <IconBtn icon="x" label="收起" shortcut="⌘⇧E" onClick={onClose} className="ml-auto" />
      </div>
      {tab === 'toc' ? (
        <>
          <div className="px-4 pb-2">
            <TextInput
              label="查找章节"
              value={q}
              onChange={setQ}
              placeholder={`在 ${chapters.length} 章中查找`}
            />
          </div>
          <div className="scroll flex-1 overflow-auto px-2 pb-6">
            {volumes.map(([vol, list]) => {
              const expanded = open[vol] || !!q
              return (
                <div key={vol} className="mt-2">
                  <Row
                    onClick={() => setOpen((o) => ({ ...o, [vol]: !expanded }))}
                    className="flex items-center gap-2 px-2 py-1.5"
                  >
                    <span className="text-ui-sm font-medium text-ink-2">{vol}</span>
                    <span className="ml-auto text-micro tabular-nums text-ink-3">
                      {list[0].no === list[list.length - 1].no
                        ? cn(list[0].no)
                        : `${list[0].no}–${list[list.length - 1].no}`}
                    </span>
                  </Row>
                  {expanded &&
                    list.map((c) => (
                      <Row
                        key={c.id}
                        active={c.id === current}
                        onClick={() => onOpen(c.id)}
                        className="flex items-baseline gap-3 px-2 py-1.5"
                      >
                        <span className="w-6 shrink-0 text-right text-micro tabular-nums text-ink-3">
                          {c.no}
                        </span>
                        <span
                          className={`min-w-0 flex-1 truncate font-prose text-ui ${c.placeholder ? 'text-ink-3' : 'text-ink'}`}
                        >
                          {c.title || '未命名'}
                        </span>
                        {c.placeholder && (
                          <span
                            className="text-micro text-ink-3"
                            title="长篇规模演示：原型未包含此章正文"
                          >
                            演示
                          </span>
                        )}
                      </Row>
                    ))}
                </div>
              )
            })}
            {volumes.length === 0 && (
              <p className="px-2 py-6 text-ui text-ink-3">没有匹配的章节。</p>
            )}
          </div>
        </>
      ) : (
        <div className="scroll flex-1 overflow-auto px-4 pb-6">
          <p className="mb-4 text-ui-sm text-ink-3">
            写{cur ? cn(cur.no) : '这一章'}时值得记住的。每条都写明为什么出现在这里。
          </p>
          <p hidden={!unavailable} className="text-ui text-ink-3">
            本章相关知识查询尚未接入，不显示推测关联。
          </p>
          {!unavailable && <RelatedList related={related} onEntry={onEntry} compact />}
          <Btn variant="link" className="mt-4" onClick={onAllKnowledge}>
            查看书中全部知识
          </Btn>
        </div>
      )}
    </nav>
  )
}

export function RelatedList({
  related,
  onEntry,
  compact,
}: {
  related: RelatedGroups
  onEntry: (id: string) => void
  compact?: boolean
}) {
  const groups: [string, RelatedGroups['people']][] = [
    ['人物', related.people],
    ['当前生效的规则与地点', related.rules],
    ['相关的历史事实', related.facts],
    ['到了回收时机的伏笔', related.threads],
  ]
  const total = groups.reduce((n, [, l]) => n + l.length, 0)
  if (total === 0)
    return (
      <p className="py-6 text-ui text-ink-3">
        这一章还没有可依据的关联。写下正文后，这里会根据正文和已确认的设定聚合。
      </p>
    )
  return (
    <div className={compact ? 'space-y-5' : 'grid gap-x-10 gap-y-8 md:grid-cols-2'}>
      {groups
        .filter(([, l]) => l.length)
        .map(([title, list]) => (
          <section key={title}>
            <Heading level={3} className="mb-1.5">
              {title}
            </Heading>
            <ul>
              {list.map(({ entry, why }) => (
                <li key={entry.id}>
                  <Row onClick={() => onEntry(entry.id)} className="-mx-2 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      {entry.kind === 'thread' && <Dot tone="ai" />}
                      <span className="font-prose text-ui-lg text-ink">{entry.name}</span>
                      {entry.status === 'tentative' && (
                        <span className="text-micro text-ink-3">暂定</span>
                      )}
                    </div>
                    <div className="text-ui-sm text-ink-2">{entry.summary}</div>
                    <div className="mt-0.5 text-micro text-ink-3">依据：{why}</div>
                  </Row>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {related.more > 0 && (
        <p className="text-micro text-ink-3">另有 {related.more} 条相关度较低，已折叠。</p>
      )}
    </div>
  )
}
