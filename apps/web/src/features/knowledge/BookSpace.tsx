import { KnowledgePanel } from './KnowledgePanel'
import LegacyRecords from './LegacyRecords'
import type { useStudioController } from '../vnext/useStudioController'
import BookView, { isCanonSection } from '../../components/vnext/BookView'
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
          historyContent={
            <LegacyRecords proposals={workspace.proposals} decisions={workspace.decisions} />
          }
          knowledgeContent={
            adapter.mode === 'api' &&
            view === 'book' &&
            bookNav.section !== 'notes' &&
            !isCanonSection(bookNav.section) ? (
              <KnowledgePanel
                key={workspace.projectId}
                bookId={workspace.projectId}
                bookTitle={workspace.projectTitle}
                chapterId={current}
                section={bookNav.section}
                adapter={adapter}
                chapters={chapters}
                onChapter={switchChapter}
                onSection={(section) => setBookNav({ section })}
              />
            ) : undefined
          }
          creativeContent={
            view === 'book' && isCanonSection(bookNav.section) ? (
              adapter.mode === 'api' ? (
                <AssetLibrary
                  key={workspace.projectId}
                  bookId={workspace.projectId}
                  section={bookNav.section}
                  chapters={chapters.map((c) => ({ id: c.id, title: c.title }))}
                  onSection={(section) => setBookNav({ section })}
                  onDiscuss={(seed) => {
                    studio.thinking.setDraft(seed)
                    setView('inspire')
                  }}
                />
              ) : (
                <p className="px-8 py-10 text-ui text-ink-3">演示模式不包含创作设定。连接作品后可以在这里管理人物、世界规则与剧情规划。</p>
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
