import { useEffect, useState } from 'react'
import type { ChapterRevisionSummaryV04 } from '@writer-agent/contracts'
import { listChapterRevisions } from '../../services/api/chapterApi'
import type { useStudioController } from '../vnext/useStudioController'
import { useManagement } from './ManagedStudio'
import StudioPage, { StudioSection, useWorkNavigation } from './StudioPage'
import { Btn, Icon, Row } from '../../components/vnext/ui'

export default function WorkOverview({ studio, demo }: { studio: ReturnType<typeof useStudioController>; demo: boolean }) {
  const management = useManagement()
  const navigation = useWorkNavigation()!
  const { workspace, chapter, current, chapters, notes, nextUp, bridge } = studio
  const tail = (bridge.paragraphs ?? workspace.doc[current] ?? []).filter(Boolean).slice(-2)
  const currentLoaded = workspace.chapterLoadState.status === 'loaded'
  const [revisions, setRevisions] = useState<ChapterRevisionSummaryV04[]>([])
  const [revisionState, setRevisionState] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    if (demo || !current) return
    const abort = new AbortController()
    setRevisions([]); setRevisionState('loading')
    listChapterRevisions(workspace.projectId, current, undefined, abort.signal).then((page) => {
      if (!abort.signal.aborted) { setRevisions(page.items.slice(0, 3)); setRevisionState('ready') }
    }).catch(() => { if (!abort.signal.aborted) setRevisionState('error') })
    return () => abort.abort()
  }, [demo, current, workspace.projectId])
  const openBook = (section: 'notes' | 'inbox' | 'analysis') => {
    studio.setBookNav({ section })
    studio.setView('book')
    navigation.open(null)
  }
  const continueWriting = () => { studio.setView('read'); navigation.open(null); studio.enterCompose() }
  const openChapter = (id: string) => { studio.switchChapter(id); studio.setView('read'); navigation.open(null) }
  return (
    <StudioPage eyebrow="作品总览 · Writer Studio" title={`《${workspace.projectTitle}》`}
      meta={`${chapters.length} 章${management?.book.readOnly ? ' · 外部作品资料' : ''}`}
      onBack={() => navigation.open(null)} backLabel="回到工作区"
      actions={chapter.id && <><Btn variant="outline" onClick={() => { studio.setView('read'); navigation.open(null) }}><Icon name="book" />阅读</Btn><Btn variant="primary" disabled={!currentLoaded || studio.readonly} onClick={continueWriting}><Icon name="pen" />继续写作</Btn></>}>
      <div className="mt-10 grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-12">
          <StudioSection title="从这里继续" action={!demo && chapter.id && <Btn size="sm" variant="link" onClick={() => navigation.open('history')}>历史版本</Btn>}>
            {chapter.id ? <div className="pt-5">
              <div className="text-ui-sm text-ink-3">{chapter.volume}</div>
              <button type="button" className="btn mt-1 block text-left font-prose text-h2 font-medium text-ink hover:text-accent" onClick={continueWriting}>{chapter.title || '未命名'}</button>
              {!currentLoaded ? <p role="status" className="mt-4 text-ui text-ink-3">{workspace.chapterLoadState.status === 'error' ? '正文暂时无法读取，请回到工作区重试。' : '正在读取正文…'}</p> : tail.length ? <div className="mt-5 border-l-2 border-sand pl-5 font-prose text-read text-ink-2">{tail.map((text, i) => <p key={i} className={i ? 'mt-3' : ''}>{text}</p>)}</div> : <p className="mt-4 text-ui text-ink-3">这一章还是空白。</p>}
              {nextUp && <p className="mt-5 whitespace-pre-wrap text-ui-sm text-ink-2"><span className="text-ink-3">你留给自己的话：</span>{nextUp.content}</p>}
            </div> : <div className="py-10"><p className="font-prose text-read text-ink-2">这部作品还没有章节。可以写第一章，也可以先去灵感里把人物和世界想清楚。</p><Btn className="mt-6" variant="primary" onClick={() => navigation.open('chapters')}>管理章节</Btn></div>}
          </StudioSection>
          <StudioSection title="章节" action={<Btn size="sm" variant="link" onClick={() => navigation.open('chapters')}>管理全部 {chapters.length} 章</Btn>}>
            <ol className="divide-y divide-line-soft">{chapters.slice(-6).reverse().map((item) => <li key={item.id}><Row active={item.id === current} onClick={() => openChapter(item.id)} className="flex items-baseline gap-4 px-2 py-3 sm:-mx-2"><span className="w-12 shrink-0 text-ui-sm tabular-nums text-ink-3">第 {chapters.indexOf(item) + 1} 章</span><span className="min-w-0 flex-1 truncate font-prose text-ui-lg">{item.title || '未命名'}</span><span className="shrink-0 text-ui-sm text-ink-3">{item.wordCount === undefined ? '—' : `${item.wordCount.toLocaleString('zh-CN')} 字`}</span></Row></li>)}</ol>
          </StudioSection>
        </div>
        <aside className="space-y-10 lg:border-l lg:border-line-soft lg:pl-10">
          <StudioSection title="等你决定"><div className="space-y-3 pt-4"><p className="text-ui-sm text-ink-3">查看书里的待确认设定与变更，由你决定是否采用。</p><Btn variant="link" size="sm" onClick={() => openBook('inbox')}>查看待确认设定</Btn>{workspace.recoveryDraft && <p className="text-ui-sm text-warn">有本地草稿等待恢复。</p>}{workspace.saveState.s === 'error' && <p className="text-ui-sm text-danger">{workspace.saveState.message}</p>}</div></StudioSection>
          <StudioSection title="创作笔记"><div className="pt-3"><p className="text-ui text-ink-2">{notes.items.filter((note) => note.status === 'active').length} 条进行中的笔记</p><Btn size="sm" variant="link" className="mt-2" onClick={() => openBook('notes')}>整理笔记</Btn></div></StudioSection>
          {!demo && current && <StudioSection title="本章最近版本" action={<Btn size="sm" variant="link" onClick={() => navigation.open('history')}>查看版本</Btn>}><div className="pt-3">{revisionState === 'loading' ? <p role="status" className="text-ui-sm text-ink-3">正在读取版本…</p> : revisionState === 'error' ? <p className="text-ui-sm text-danger">版本列表暂时无法读取，可进入历史版本重新读取。</p> : revisions.length ? <ol className="divide-y divide-line-soft">{revisions.map((revision) => <li key={revision.revisionId} className="flex justify-between gap-3 py-2 text-ui-sm"><span className="text-ink-2">{revision.createdAt ? new Date(revision.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '初始版本'}</span><span className="text-ink-3">{revision.wordCount ?? 0} 字</span></li>)}</ol> : <p className="text-ui-sm text-ink-3">这一章还没有可读取的历史版本。</p>}</div></StudioSection>}
          <StudioSection title="工具"><div className="flex flex-col items-start gap-1 pt-2"><Btn className="-ml-3" onClick={() => navigation.open('chapters')}><Icon name="layers" />章节管理</Btn>{!demo && chapter.id && <Btn className="-ml-3" onClick={() => navigation.open('history')}><Icon name="revision" />历史版本</Btn>}{!demo && <Btn className="-ml-3" onClick={() => openBook('analysis')}><Icon name="review" />小说分析</Btn>}<Btn className="-ml-3" onClick={() => { studio.setView('inspire'); navigation.open(null) }}><Icon name="think" />灵感</Btn></div></StudioSection>
        </aside>
      </div>
    </StudioPage>
  )
}
