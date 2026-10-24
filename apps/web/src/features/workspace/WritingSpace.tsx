import ManagedDirectory from '../management/ManagedDirectory'
import { useManagement } from '../management/ManagedStudio'
import type { useStudioController } from '../vnext/useStudioController'
import { ReviewConsentDialog } from '../reviews/ReviewConsentDialog'
import { ReviewMarginPanel } from '../reviews/ReviewMarginPanel'
import ChapterDrawer from '../../components/vnext/ChapterDrawer'
import StoryConflictView from '../../components/vnext/StoryConflictView'
import WritingCanvas from '../workspace/WritingCanvas'
import Resume from '../../components/vnext/Resume'
import MarginPanel from '../../components/vnext/MarginPanel'
import { Btn, IconBtn, Icon, Seg, Kbd } from '../../components/vnext/ui'
import type { WriterAgentAdapter } from '../../services/writerAgent'
import ThinkingSpace from '../vnext/ThinkingSpace'
import { ComposeBar, ReadingBar } from './ComposeBar'
import WritingContextPanel from '../creative/WritingContextPanel'
import { useEffect } from 'react'
export default function WritingSpace({
  studio,
  adapter,
}: {
  studio: ReturnType<typeof useStudioController>
  adapter: WriterAgentAdapter
}) {
  const management = useManagement()
  const {
    reviews,
    reviewAnnotations,
    reviewFlash,
    locateReview,
    selectReview,
    view,
    setView,
    leftTab,
    setLeftTab,
    rightTab,
    setRightTab,
    setBookNav,
    resume,
    setResume,
    setQuick,
    selection,
    setSelection,
    marksHidden,
    setMarksHidden,
    activeMargin,
    setConflictId,
    setCandidateContext,
    flash,
    backTo,
    setBackTo,
    setTyping,
    scroll,
    workspace,
    current,
    doc,
    layout,
    setLayout,
    bridge,
    editor,
    ready,
    chapters,
    chapter,
    viewChapters,
    currentViewChapter,
    prototype,
    notesEnabled,
    nextUp,
    conflict,
    openThink,
    switchChapter,
    openSource,
    downloadLocalDraft,
    annotations,
    selectMargin,
    saveNote,
    liveMargins,
    resumePending,
    toast,
    compose,
    setCompose,
    typewriter,
    assetsOpen,
    setAssetsOpen,
  } = studio
  // Compose is immersive: entering it focuses the page; leaving restores chrome.
  useEffect(() => {
    setLayout((l) => (compose ? { ...l, focus: true, leftOpen: false, rightOpen: false } : l.focus ? { ...l, focus: false } : l))
  }, [compose, setLayout])
  const api = adapter.mode === 'api'
  const thinkView = (wide = false) => (
    <ThinkingSpace studio={studio} demo={adapter.mode === 'demo'} wide={wide} />
  )
  return (
    <>
      {adapter.mode === 'api' && (
        <ReviewConsentDialog
          review={reviews}
          onStarted={() => {
            setRightTab('margin')
            setLayout((prior) => ({ ...prior, rightOpen: true, focus: false }))
          }}
        />
      )}
      <div
        hidden={view !== 'read'}
        className={view === 'read' ? 'relative flex min-h-0 flex-1' : ''}
      >
        {view === 'read' && layout.leftOpen && !layout.focus && (
          <>
            <button
              aria-label="关闭章节遮罩"
              className="fixed inset-0 top-12 z-20 bg-scrim lg:hidden"
              onClick={() => setLayout((l) => ({ ...l, leftOpen: false }))}
            />
            <aside
              className="fixed inset-y-0 top-12 left-0 z-30 max-w-full shadow-soft lg:static lg:z-auto lg:shadow-none"
              style={{ width: layout.leftW }}
            >
              {management && !management.book.readOnly ? (
                <ManagedDirectory
                  current={current}
                  onOpen={(id) =>
                    management.protect(async () => {
                      switchChapter(id)
                    })
                  }
                  onClose={() => setLayout((l) => ({ ...l, leftOpen: false }))}
                />
              ) : (
                <ChapterDrawer
                  chapters={viewChapters}
                  current={current}
                  onOpen={switchChapter}
                  onClose={() => setLayout((l) => ({ ...l, leftOpen: false }))}
                  related={prototype.related}
                  tab={leftTab}
                  setTab={setLeftTab}
                  onEntry={(entryId) => {
                    setView('book')
                    setBookNav({ section: 'chapter', entryId })
                  }}
                  onAllKnowledge={() => setView('book')}
                  unavailable={adapter.mode === 'api'}
                />
              )}
            </aside>
          </>
        )}
        <main
          className="flex min-w-0 flex-1 flex-col"
          onKeyDownCapture={(event) => {
            if ((event.target as HTMLElement).closest('.manuscript') && event.key.length === 1)
              setTyping(true)
          }}
        >
          {conflict ? (
            <StoryConflictView
              conflict={conflict}
              onBack={() => setConflictId(null)}
              onSource={openSource}
              onResolve={(resolution) => {
                if (resolution === 'edit-text') {
                  if (conflict.a.state === 'ok') openSource(conflict.a)
                  else {
                    setConflictId(null)
                    if (conflict.a.chapterId) switchChapter(conflict.a.chapterId)
                    toast('引用需要重新核对，已回到对应章节，未自动定位段落。')
                  }
                  return
                }
                if (resolution === 'edit-canon') {
                  setCandidateContext({
                    entryId: conflict.extra?.entryId,
                    sources: [conflict.a, conflict.b],
                    reason: `作者从故事冲突“${conflict.title}”发起的演示候选，变更内容由作者填写。`,
                  })
                  return
                }
                const done = () => {
                  prototype.setConflicts((all) =>
                    all.map((c) => (c.id === conflict.id ? { ...c, resolution } : c)),
                  )
                  prototype.setIgnored((all) => [
                    ...all,
                    ...prototype.margins
                      .filter((m) => m.conflictId === conflict.id)
                      .map((m) => m.id),
                  ])
                  setConflictId(null)
                }
                if (resolution === 'growth')
                  void saveNote(`作者判断：${conflict.title}是人物成长或认知变化。`)
                    .then(done)
                    .catch((e: unknown) => toast(e instanceof Error ? e.message : '笔记保存失败'))
                else done()
              }}
            />
          ) : (
            <>
              {backTo && (
                <Btn
                  className="self-start"
                  onClick={() => {
                    const target = backTo
                    switchChapter(target.chapterId)
                    setBackTo(null)
                    window.setTimeout(() => scroll.current?.scrollTo({ top: target.scroll }), 100)
                  }}
                >
                  回到正文原位置
                </Btn>
              )}
              <ReadingBar studio={studio} api={api} />
              <WritingCanvas
                editable={compose}
                typewriter={typewriter}
                workspace={workspace}
                chapters={chapters}
                chapter={chapter}
                displayTitle={
                  adapter.mode === 'demo' ? currentViewChapter?.title || '未命名' : chapter.title
                }
                chapterNumber={adapter.mode === 'demo' ? currentViewChapter?.no : undefined}
                scrollRef={scroll}
                annotations={adapter.mode === 'api' ? reviewAnnotations : annotations}
                flash={
                  adapter.mode === 'api'
                    ? !reviews.stale && reviewFlash?.runId === reviews.run?.runId
                      ? reviewFlash
                      : null
                    : flash
                }
                downloadLocalDraft={downloadLocalDraft}
                selectIssue={adapter.mode === 'api' ? selectReview : selectMargin}
                handleEditorReady={ready}
                setSelection={setSelection}
                resume={
                  resume &&
                  !layout.focus &&
                  currentViewChapter &&
                  (bridge.paragraphs ?? doc[current] ?? []).some(Boolean) ? (
                    <Resume
                      chapter={{ ...currentViewChapter, title: chapter.title }}
                      tail={(bridge.paragraphs ?? doc[current] ?? []).filter(Boolean).slice(-3)}
                      pending={resumePending}
                      nextUp={
                        nextUp
                          ? {
                              id: nextUp.noteId,
                              text: nextUp.content,
                              origin: 'quick',
                              at: Date.parse(nextUp.updatedAt),
                            }
                          : undefined
                      }
                      onContinue={() => {
                        setResume(false)
                        setCompose(true)
                        window.setTimeout(() => editor.current?.commands.focus('end'), 0)
                      }}
                      onThink={() => openThink(nextUp?.content)}
                      onSkip={() => setResume(false)}
                    />
                  ) : null
                }
              />
            </>
          )}
        </main>
        {view === 'read' && assetsOpen && api && chapter.id && (
          <div className="fixed inset-y-0 top-12 right-0 z-30 w-full max-w-sm border-l border-line bg-surface shadow-soft">
            <WritingContextPanel
              key={current}
              bookId={workspace.projectId}
              chapterId={current}
              chapters={chapters.map((c) => ({ id: c.id, title: c.title }))}
              onClose={() => setAssetsOpen(false)}
              onFlushSave={() => workspace.flushSave()}
            />
          </div>
        )}
        {view === 'read' && <ComposeBar studio={studio} api={api} />}
        {view === 'read' && layout.rightOpen && !layout.focus && (
          <>
            <button
              aria-label="关闭辅助遮罩"
              className="fixed inset-0 top-12 z-20 bg-scrim xl:hidden"
              onClick={() => setLayout((l) => ({ ...l, rightOpen: false }))}
            />
            <aside
              aria-label="辅助"
              className="fixed inset-y-0 top-12 right-0 z-30 flex max-w-full flex-col bg-paper shadow-soft xl:static xl:z-auto xl:shadow-none"
              style={{ width: layout.rightW }}
            >
              <div className="flex items-center gap-1 px-4 pt-3 pb-3">
                <Seg
                  size="sm"
                  label="辅助内容"
                  value={rightTab}
                  onChange={setRightTab}
                  options={[
                    ['margin', '注记'],
                    ['think', '思考'],
                  ]}
                />
                {rightTab === 'think' && (
                  <IconBtn
                    icon="expand"
                    label="展开为完整思考空间"
                    onClick={() => setView('inspire')}
                  />
                )}
                <IconBtn
                  icon="x"
                  label="收起辅助"
                  className="ml-auto"
                  onClick={() => setLayout((l) => ({ ...l, rightOpen: false }))}
                />
              </div>
              <div className="scroll min-h-0 flex-1 overflow-auto">
                {rightTab === 'think' ? (
                  thinkView()
                ) : adapter.mode === 'api' ? (
                  <ReviewMarginPanel
                    review={reviews}
                    locate={(id) => void locateReview(id)}
                    select={selectReview}
                    saveNote={saveNote}
                    marksHidden={marksHidden}
                    setMarksHidden={setMarksHidden}
                    emptyChapter={!(workspace.markdownByChapter[current] ?? '').trim()}
                  />
                ) : (
                  <MarginPanel
                    margins={liveMargins}
                    ignored={prototype.margins.filter((m) => prototype.ignored.includes(m.id))}
                    activeId={activeMargin}
                    onSelect={selectMargin}
                    onSource={openSource}
                    onIgnore={(id) => prototype.setIgnored((all) => [...all, id])}
                    onRestore={(id) => prototype.setIgnored((all) => all.filter((x) => x !== id))}
                    onNote={(m) => {
                      void saveNote(`AI 推断（演示，未确认）：${m.inference}`)
                        .then(() => toast('已保存为创作笔记'))
                        .catch((e: unknown) => toast(e instanceof Error ? e.message : '保存失败'))
                    }}
                    onConflict={(m) => setConflictId(m.conflictId ?? null)}
                    onThink={(m) => openThink(m.question)}
                    marksHidden={marksHidden}
                    setMarksHidden={setMarksHidden}
                    emptyChapter={!(doc[current] ?? []).some(Boolean)}
                  />
                )}
              </div>
            </aside>
          </>
        )}
        {!resume && !layout.rightOpen && !conflict && (
          <div className="chrome pointer-events-none fixed bottom-4 left-1/2 z-0 hidden -translate-x-1/2 text-micro text-ink-3 lg:block">
            <Kbd>⌘;</Kbd> 随手记 <Kbd>⌘\</Kbd> 注记 <Kbd>⌘⇧E</Kbd> 目录 <Kbd>⌘⇧F</Kbd> 专注
          </div>
        )}
        <footer className="chrome pointer-events-none fixed inset-x-0 bottom-0 z-10 flex items-end justify-between px-4 pb-4">
          <span className="hidden text-micro text-ink-3 sm:inline">
            {bridge.words ?? (doc[current] ?? []).join('').replace(/\s/g, '').length} 字
          </span>
          {(!layout.rightOpen || layout.focus) && (
            <div className="pointer-events-auto ml-auto flex gap-0.5 rounded-lg bg-page/80 p-0.5 backdrop-blur">
              <Btn size="sm" disabled={!notesEnabled} onClick={() => setQuick(true)}>
                <Icon name="pen" />
                随手记
              </Btn>
              {adapter.mode === 'api' && (
                <Btn
                  size="sm"
                  disabled={
                    !reviews.available ||
                    !!reviews.busy ||
                    !current ||
                    !(workspace.markdownByChapter[current] ?? '').trim() ||
                    reviews.run?.status === 'running'
                  }
                  onClick={() => void reviews.prepare()}
                >
                  {reviews.busy === 'preview'
                    ? '准备审查…'
                    : reviews.run?.status === 'completed'
                      ? '重新审查'
                      : '审查本章'}
                </Btn>
              )}
              <Btn size="sm" onClick={() => openThink(selection)}>
                思考
              </Btn>
              <Btn
                size="sm"
                onClick={() => {
                  setRightTab('margin')
                  setLayout((l) => ({ ...l, rightOpen: true, focus: false }))
                }}
              >
                注记
              </Btn>
            </div>
          )}
        </footer>
      </div>
    </>
  )
}
