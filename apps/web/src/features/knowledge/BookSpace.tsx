import { KnowledgePanel } from './KnowledgePanel'
import LegacyRecords from './LegacyRecords'
import type { useStudioController } from '../vnext/useStudioController'
import BookView, { SourceSwitch, isAssetSection, sourceOf } from '../../components/vnext/BookView'
import { useCreativeOverview } from '../creative/useCreativeOverview'
import { kindsOf } from '../creative/kit'
import AssetLibrary from '../creative/AssetLibrary'
import { NotesPanel } from '../notes/NotesPanel'
import type { WriterAgentAdapter } from '../../services/writerAgent'
export default function BookSpace({
  studio,
  adapter,
}: {
  studio: ReturnType<typeof useStudioController>
  adapter: WriterAgentAdapter
}) {
  const {
    view,
    workspace,
    setView,
    bookNav,
    setBookNav,
    setCandidateNote,
    current,
    chapters,
    viewChapters,
    currentViewChapter,
    prototype,
    notesEnabled,
    notes,
    openThink,
    switchChapter,
    openSource,
  } = studio
  const api = adapter.mode === 'api'
  const { overview } = useCreativeOverview(workspace.projectId, api && view === 'book')
  const section = bookNav.section
  // Demo has no creative assets: asset sections fall back to the prototype observations.
  const canon = section === 'inbox' || (api && isAssetSection(section) && sourceOf(bookNav) === 'canon')
  const sw = <SourceSwitch nav={bookNav} setNav={setBookNav} />
  const counts = overview
    ? {
        people: kindsOf.person.reduce((n, k) => n + (overview.counts[k]?.accepted ?? 0) + (overview.counts[k]?.draft ?? 0), 0),
        world: kindsOf.world.reduce((n, k) => n + (overview.counts[k]?.accepted ?? 0) + (overview.counts[k]?.draft ?? 0), 0),
        timeline: kindsOf.event.reduce((n, k) => n + (overview.counts[k]?.accepted ?? 0) + (overview.counts[k]?.draft ?? 0), 0),
        plot: kindsOf.plot.reduce((n, k) => n + (overview.counts[k]?.accepted ?? 0) + (overview.counts[k]?.draft ?? 0), 0),
        threads: kindsOf.thread.reduce((n, k) => n + (overview.counts[k]?.accepted ?? 0) + (overview.counts[k]?.draft ?? 0), 0),
        inbox: overview.pendingProposals,
      }
    : undefined
  const toSession = (sessionId: string, messageId: string) => {
    studio.setIdeaFocus({ sessionId, messageId, nonce: Date.now() })
    setView('inspire')
  }
  return (
    <>
      <div hidden={view !== 'book'} className={view === 'book' ? 'min-h-0 flex-1' : ''}>
        <BookView
          nav={bookNav}
          setNav={setBookNav}
          entries={prototype.entries}
          chapters={viewChapters}
          current={currentViewChapter}
          related={prototype.related}
          notes={[]}
          changes={prototype.changes}
          workTitle={workspace.projectTitle}
          counts={counts}
          historyContent={
            <LegacyRecords proposals={workspace.proposals} decisions={workspace.decisions} />
          }
          knowledgeContent={
            api && view === 'book' && section !== 'notes' && section !== 'inbox' && !canon ? (
              <KnowledgePanel
                key={workspace.projectId}
                bookId={workspace.projectId}
                bookTitle={workspace.projectTitle}
                chapterId={current}
                section={section}
                headerExtra={sw}
                adapter={adapter}
                chapters={chapters}
                onChapter={switchChapter}
                onSection={(next) => setBookNav({ section: next, source: 'manuscript' })}
              />
            ) : undefined
          }
          creativeContent={
            view === 'book' && canon && (section === 'inbox' || isAssetSection(section)) ? (
              api ? (
                <AssetLibrary
                  key={workspace.projectId}
                  bookId={workspace.projectId}
                  bookTitle={workspace.projectTitle}
                  section={section}
                  headerExtra={section === 'inbox' ? undefined : sw}
                  chapters={chapters.map((c) => ({ id: c.id, title: c.title }))}
                  onSection={(next) => setBookNav({ section: next })}
                  onChapter={(id) => switchChapter(id)}
                  onSession={toSession}
                  onDiscuss={(seed) => {
                    studio.thinking.setDraft(seed)
                    setView('inspire')
                  }}
                />
              ) : (
                <p className="px-8 py-10 text-ui text-ink-3">演示模式不包含创作设定。连接作品后可以在这里管理人物、世界观与剧情规划；切换到「正文观察 · AI」可以查看演示知识。</p>
              )
            ) : undefined
          }
          unavailable={adapter.mode === 'api'}
          noteContent={
            <NotesPanel
              notes={notes}
              chapters={chapters}
              currentChapterId={current}
              enabled={notesEnabled}
              demo={adapter.mode === 'demo'}
              onPropose={adapter.mode === 'demo' ? setCandidateNote : undefined}
              onClose={() => setView('read')}
            />
          }
          onChapter={(no) => {
            const c = viewChapters.find((v) => v.no === no)
            if (c) switchChapter(c.id)
          }}
          onSource={openSource}
          onThink={(seed) => {
            openThink(seed)
            setView('inspire')
          }}
          onPropose={() => {}}
          onArchive={() => {}}
          onDecide={(id, status) => {
            prototype.setChanges((all) => all.map((c) => (c.id === id ? { ...c } : c)))
            if (status === 'confirmed') {
              const change = prototype.changes.find((c) => c.id === id)
              if (change)
                prototype.setEntries((all) =>
                  all.map((entry) =>
                    entry.id !== change.entryId
                      ? entry
                      : {
                          ...entry,
                          ...(change.field === '条目描述' ? { summary: change.proposed } : {}),
                          fields: entry.fields.map((f) =>
                            f.label === change.field ? { ...f, value: change.proposed } : f,
                          ),
                          history: [
                            ...entry.history,
                            {
                              at: new Date().toLocaleDateString('zh-CN'),
                              text: change.proposed,
                              simulated: true,
                            },
                          ],
                        },
                  ),
                )
            }
          }}
          onBackToWriting={() => setView('read')}
        />
      </div>
    </>
  )
}
