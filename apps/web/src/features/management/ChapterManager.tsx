import { useMemo, useState } from 'react'
import type { ManagedChapter, ManagedBook } from '@writer-agent/contracts'
import type { useStudioController } from '../vnext/useStudioController'
import { useManagement } from './ManagedStudio'
import StudioPage, { useWorkNavigation } from './StudioPage'
import { Btn, Dialog, Field, Icon, IconBtn, Seg, Select, TextInput } from '../../components/vnext/ui'

type Filter = 'all' | 'blank' | 'archived'
export default function ChapterManager({ studio }: { studio: ReturnType<typeof useStudioController> }) {
  const management = useManagement()
  const navigation = useWorkNavigation()!
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string; title: string; volume?: boolean } | null>(null)
  const [archive, setArchive] = useState<string[] | null>(null)
  const [volume, setVolume] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const book = management?.book
  const counts = useMemo(() => new Map(studio.chapters.map((chapter) => [chapter.id, chapter.wordCount])), [studio.chapters])
  const chapters: ManagedChapter[] = book?.chapters ?? studio.chapters.map((chapter) => ({ chapterId: chapter.id, title: chapter.title, archived: false }))
  const active = chapters.filter((chapter) => !chapter.archived)
  const archived = chapters.filter((chapter) => chapter.archived)
  const numbers = new Map(active.map((chapter, i) => [chapter.chapterId, i + 1]))
  const groups = [{ volumeId: '', title: '未分卷' }, ...(book?.volumes.filter((item) => filter === 'archived' || !item.archived) ?? [])]
  const needle = query.trim().toLocaleLowerCase()
  const displayed = (filter === 'archived' ? archived : active).filter((chapter) =>
    (!needle || chapter.title.toLocaleLowerCase().includes(needle) || String(numbers.get(chapter.chapterId) ?? '').includes(needle)) &&
    (filter !== 'blank' || counts.get(chapter.chapterId) === 0),
  )
  const writable = !!management && !book?.readOnly && !pending && !management.busy
  const mutate = async (next: ManagedChapter[], volumes: ManagedBook['volumes'] = management?.book.volumes ?? []) => {
    if (!management || !writable) return false
    setPending(true)
    setMessage('')
    try {
      const result = await management.change({ operation: 'structure', chapters: next, volumes })
      if (!result) return false
      setSelected(new Set())
      return true
    } finally { setPending(false) }
  }
  const changeArchive = async (ids: string[], value: boolean) => {
    if (await mutate(chapters.map((chapter) => ids.includes(chapter.chapterId) ? { ...chapter, archived: value } : chapter))) {
      setArchive(null)
      setMessage(value ? '章节已归档，正文和历史仍然保留。' : '章节已恢复。')
    }
  }
  const rename = async () => {
    if (!editing?.title.trim()) return
    const updated = editing.volume
      ? await mutate(chapters, book!.volumes.map((item) => item.volumeId === editing.id ? { ...item, title: editing.title.trim() } : item))
      : await mutate(chapters.map((chapter) => chapter.chapterId === editing.id ? { ...chapter, title: editing.title.trim() } : chapter))
    if (updated) setEditing(null)
  }
  const move = (chapter: ManagedChapter, direction: number) => {
    const peers = active.filter((item) => item.volumeId === chapter.volumeId)
    const other = peers[peers.findIndex((item) => item.chapterId === chapter.chapterId) + direction]
    if (!other) return
    const next = [...chapters]
    const a = next.indexOf(chapter), b = next.indexOf(other)
    ;[next[a], next[b]] = [next[b], next[a]]
    void mutate(next)
  }
  const openChapter = (id: string, write = false) => {
    studio.switchChapter(id)
    if (write) studio.enterCompose()
    else studio.setView('read')
    navigation.open(null)
  }
  return (
    <StudioPage eyebrow="章节管理" title={`《${studio.workspace.projectTitle}》的章节`}
      meta={`${book?.volumes.filter((item) => !item.archived).length ?? 0} 卷 · ${active.length} 章${archived.length ? ` · 归档 ${archived.length} 章` : ''}`}
      onBack={() => navigation.open('desk')}
      actions={<><Btn variant="outline" disabled={!writable} onClick={() => void management?.change({ operation: 'volume' })}><Icon name="folder" />新建卷</Btn><Btn variant="primary" disabled={!writable} onClick={() => void management?.change({ operation: 'chapter' }, 'new')}><Icon name="plus" />新建章节</Btn></>}>
      <div className="sticky top-0 z-10 bg-page py-4">
        <div className="flex flex-wrap items-center gap-3">
          <TextInput label="查找章节" placeholder="章号或标题" value={query} onChange={setQuery} className="w-full sm:w-56" />
          <Seg size="sm" label="筛选章节" value={filter} onChange={(value) => { setFilter(value); setSelected(new Set()) }} options={[[ 'all', '全部' ], [ 'blank', '空白' ], [ 'archived', `已归档 ${archived.length}` ]]} />
          <div className="flex items-center gap-1 sm:ml-auto"><Btn size="sm" onClick={() => setClosed({})}>全部展开</Btn><Btn size="sm" onClick={() => setClosed(Object.fromEntries(groups.map((group) => [group.volumeId, true])))}>全部收起</Btn></div>
        </div>
        {book?.readOnly && <p className="mt-2 text-ui-sm text-ink-3">外部作品资料的章节结构只读。</p>}
        {filter === 'blank' && <p className="mt-2 text-micro text-ink-3">仅显示已有字数记录且正文为空的章节。</p>}
        {selected.size > 0 && <div role="toolbar" aria-label="批量操作" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <span className="text-ui-sm">{selected.size} 章已选</span>
          <Btn size="sm" onClick={() => setSelected(new Set(displayed.map((chapter) => chapter.chapterId)))}>全选筛选结果</Btn>
          <span className="flex-1" />
          {filter !== 'archived' && <><Select hideLabel label="移动到卷" className="w-36" value={volume} onChange={setVolume} disabled={!writable} options={[{ value: '', label: '未分卷' }, ...(book?.volumes.filter((item) => !item.archived).map((item) => ({ value: item.volumeId, label: item.title })) ?? [])]} /><Btn variant="outline" size="sm" disabled={!writable} onClick={() => void mutate(chapters.map((chapter) => selected.has(chapter.chapterId) ? { ...chapter, volumeId: volume || undefined } : chapter))}>移动</Btn></>}
          <Btn variant="outline" size="sm" disabled={!writable} onClick={() => filter === 'archived' ? void changeArchive([...selected], false) : setArchive([...selected])}>{filter === 'archived' ? '恢复章节' : '归档章节'}</Btn>
          <IconBtn icon="x" label="取消选择" onClick={() => setSelected(new Set())} />
        </div>}
      </div>
      {(message || pending) && <p role="status" className="mb-4 text-ui-sm text-ink-3">{pending ? '正在更新章节…' : message}</p>}
      {displayed.length === 0 && !(filter === 'all' && !needle && book?.volumes.some((item) => !item.archived)) ? <div className="border-y border-dashed border-line py-14 text-center"><p className="font-prose text-read text-ink-2">{filter === 'archived' ? '没有符合条件的归档章节。' : active.length ? '没有符合条件的章节。' : '还没有章节。'}</p>{query && <Btn className="mt-4" onClick={() => setQuery('')}>清除查找</Btn>}</div> : <div className="space-y-8">
        {groups.map((group) => {
          const list = displayed.filter((chapter) => (chapter.volumeId ?? '') === group.volumeId)
          if (!list.length && (!group.volumeId || needle || filter !== 'all')) return null
          const collapsed = closed[group.volumeId] && !needle
          const limit = limits[group.volumeId] ?? 120
          return <section key={group.volumeId}>
            <div className="flex items-center gap-2 border-b border-line"><button type="button" aria-expanded={!collapsed} className="btn flex min-w-0 flex-1 items-center gap-3 py-3 text-left" onClick={() => setClosed((old) => ({ ...old, [group.volumeId]: !collapsed }))}><Icon name="chevron" className={collapsed ? '' : 'rotate-90'} /><span className="min-w-0 flex-1 truncate font-prose text-h3">{group.title}</span><span className="shrink-0 text-ui-sm text-ink-3">{list.length} 章</span></button>{group.volumeId && <IconBtn icon="edit" label={`重命名${group.title}`} disabled={!writable} onClick={() => setEditing({ id: group.volumeId, title: group.title, volume: true })} />}</div>
            {!collapsed && <><ol>{list.slice(0, limit).map((chapter) => <li key={chapter.chapterId} className={`flex items-center gap-3 border-b border-line-soft py-3 ${selected.has(chapter.chapterId) ? 'bg-accent-soft/50' : chapter.chapterId === studio.current ? 'bg-surface-2/60' : ''}`}>
              {management && !book?.readOnly && <input type="checkbox" aria-label={`选择${chapter.title}`} checked={selected.has(chapter.chapterId)} disabled={!writable} className="ml-1 accent-current" onChange={(event) => { const checked = event.target.checked; setSelected((old) => { const next = new Set(old); if (checked) next.add(chapter.chapterId); else next.delete(chapter.chapterId); return next }) }} />}
              <span className="w-8 shrink-0 text-right text-ui-sm tabular-nums text-ink-3">{numbers.get(chapter.chapterId) ?? '—'}</span>
              <button type="button" className="btn min-w-0 flex-1 truncate text-left font-prose text-ui-lg hover:text-accent" onClick={() => openChapter(chapter.chapterId)} disabled={chapter.archived}>{chapter.title || '未命名'}</button>
              <span className="hidden shrink-0 text-ui-sm tabular-nums text-ink-3 sm:inline">{counts.get(chapter.chapterId) === undefined ? '—' : `${counts.get(chapter.chapterId)!.toLocaleString('zh-CN')} 字`}</span>
              <div className="flex shrink-0 items-center gap-0.5">
                {!chapter.archived && <IconBtn size="sm" icon="pen" label={`写作：${chapter.title}`} onClick={() => openChapter(chapter.chapterId, true)} />}
                {chapter.archived ? <Btn size="sm" disabled={!writable} onClick={() => void changeArchive([chapter.chapterId], false)}>恢复</Btn> : <details className="relative"><summary aria-label={`${chapter.title}更多操作`} className="btn cursor-pointer list-none rounded-md p-2 hover:bg-surface-2">···</summary><div className="absolute right-0 z-20 grid w-36 gap-1 rounded-lg border border-line bg-surface p-2 shadow-soft">
                  <Btn size="sm" disabled={!writable} onClick={() => setEditing({ id: chapter.chapterId, title: chapter.title })}>重命名</Btn>
                  <Btn size="sm" disabled={!writable || !!needle || filter !== 'all'} onClick={() => move(chapter, -1)}>上移</Btn><Btn size="sm" disabled={!writable || !!needle || filter !== 'all'} onClick={() => move(chapter, 1)}>下移</Btn>
                  {navigation.historyAvailable && <Btn size="sm" onClick={() => { studio.switchChapter(chapter.chapterId); navigation.open('history') }}>历史版本</Btn>}
                  <Btn size="sm" disabled={!writable} onClick={() => setArchive([chapter.chapterId])}>归档</Btn>
                </div></details>}
              </div>
            </li>)}</ol>{list.length > limit && <Btn className="mt-3" variant="outline" onClick={() => setLimits((old) => ({ ...old, [group.volumeId]: limit + 120 }))}>再显示 {Math.min(120, list.length - limit)} 章</Btn>}</>}
          </section>
        })}
      </div>}
      {editing && <Dialog title={editing.volume ? '重命名卷' : '重命名章节'} label={editing.volume ? '重命名卷' : '重命名章节'} onClose={() => setEditing(null)} actions={<><Btn disabled={pending} onClick={() => setEditing(null)}>取消</Btn><Btn variant="primary" loading={pending} disabled={!editing.title.trim()} onClick={() => void rename()}>保存名称</Btn></>}><Field label={editing.volume ? '卷名称' : '章节名称'} autoFocus maxLength={200} value={editing.title} onChange={(title) => setEditing({ ...editing, title })} onEnter={() => void rename()} disabled={pending} /></Dialog>}
      {archive && <Dialog title={`归档 ${archive.length} 章？`} label="归档章节" onClose={() => setArchive(null)} actions={<><Btn disabled={pending} onClick={() => setArchive(null)}>保留</Btn><Btn variant="primary" loading={pending} onClick={() => void changeArchive(archive, true)}>确认归档</Btn></>}>章节将从目录中移出，正文和历史版本保留，可以恢复。已公开的章节可能仍可被阅读，撤回请前往发布管理。</Dialog>}
    </StudioPage>
  )
}
