import { useManagement } from '../management/ManagedStudio'
import type { ReactNode, RefObject } from 'react'
import type { Chapter } from '@writer-agent/contracts'
import type { Editor } from '@tiptap/react'
import ManuscriptEditor, { type Annotation, type Flash } from '../../components/ManuscriptEditor'
import { Btn, Empty } from '../../components/ui'
import type { useWorkspaceController } from './useWorkspaceController'

type Props = {
  workspace: ReturnType<typeof useWorkspaceController>
  chapters: Chapter[]
  chapter: Chapter
  displayTitle?: string
  chapterNumber?: number
  scrollRef: RefObject<HTMLDivElement | null>
  resume: ReactNode
  annotations: Annotation[]
  flash: Flash
  downloadLocalDraft: () => void
  selectIssue: (id: string) => void
  handleEditorReady: (editor: Editor | null) => void
  setSelection: (text: string) => void
}
export default function WritingCanvas({
  workspace,
  chapters,
  chapter,
  displayTitle,
  chapterNumber,
  scrollRef,
  resume,
  annotations,
  flash,
  downloadLocalDraft,
  selectIssue,
  handleEditorReady,
  setSelection,
}: Props) {
  const management = useManagement()
  const {
    current,
    layout,
    doc,
    markdownByChapter,
    chapterLoadState,
    recoveryDraft,
    restoreLocalDraft,
    reloadServerVersion,
    retryLoadChapter,
    exportLocalDraft,
    saveState,
    editorGeneration,
    onChange,
  } = workspace
  return (
    <div ref={scrollRef} className="scroll relative min-h-0 flex-1 overflow-auto">
      {chapters.length === 0 ? (
        <Empty
          title={
            management && !management.book.readOnly ? '还没有章节' : '作品资料中还没有正式章节'
          }
          desc={
            management && !management.book.readOnly
              ? '写下第一句话，慢慢整理你的故事。'
              : '这是外部作品资料，目录只读。可以从顶部菜单新建在线作品。'
          }
          action={
            management && !management.book.readOnly ? (
              <Btn onClick={() => void management.change({ operation: 'chapter' }, 'new')}>
                新建第一章
              </Btn>
            ) : undefined
          }
        />
      ) : chapterLoadState.status === 'loading' || chapterLoadState.status === 'idle' ? (
        <Empty title="正在读取章节原文…" desc="正文读取完成后即可编辑。" />
      ) : chapterLoadState.status === 'error' ? (
        <Empty
          title="章节加载失败"
          desc={chapterLoadState.message}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Btn variant="outline" onClick={() => retryLoadChapter()}>
                重试读取
              </Btn>
              {exportLocalDraft() !== null && <Btn onClick={downloadLocalDraft}>导出本地草稿</Btn>}
            </div>
          }
        />
      ) : recoveryDraft ? (
        <section
          role="alert"
          aria-label="本地草稿恢复"
          className="mx-auto mt-10 max-w-[680px] rounded-lg border p-4"
          style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
        >
          <div className="text-[13px] font-medium">发现尚未确认保存的本地草稿</div>
          <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
            {recoveryDraft.conflict
              ? '本地草稿基于较旧的服务器版本。服务器正文未被覆盖；先导出草稿，再选择如何继续。'
              : '服务器版本与本地草稿不同。服务器正文未被覆盖；请选择恢复草稿或使用服务器版本。'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn variant="primary" onClick={() => void restoreLocalDraft()}>
              恢复本地草稿
            </Btn>
            <Btn variant="outline" onClick={downloadLocalDraft}>
              导出本地草稿
            </Btn>
            <Btn onClick={() => reloadServerVersion()}>使用服务器版本…</Btn>
          </div>
        </section>
      ) : (
        <article
          className={`mx-auto w-full max-w-page px-8 pb-48 sm:px-12 ${layout.focus ? 'pt-28' : 'pt-14 sm:pt-20'}`}
        >
          {resume}
          <div className="mb-2 text-ui-sm text-ink-3">
            {chapter.volume}
            {chapterNumber ? ` · 第 ${chapterNumber} 章` : ''}
          </div>
          <h1 className="font-prose text-display font-medium">{displayTitle ?? chapter.title}</h1>
          <div className="mt-2 mb-12 text-ui-sm" style={{ color: 'var(--ink-3)' }}>
            {chapter.meta}
          </div>
          {saveState.s === 'error' && saveState.conflict && (
            <section
              role="alert"
              className="mb-5 rounded-lg border p-4 text-[12px]"
              style={{
                borderColor: 'var(--danger)',
                background: 'var(--danger-soft)',
                color: 'var(--ink-2)',
              }}
            >
              <div className="font-medium" style={{ color: 'var(--danger)' }}>
                检测到版本冲突
              </div>
              <p className="mt-1">
                {saveState.message} 本地正文仍保留在编辑器和浏览器恢复草稿中，没有自动重试覆盖。
              </p>
              <div className="mt-3 flex gap-2">
                <Btn small variant="outline" onClick={downloadLocalDraft}>
                  导出本地草稿
                </Btn>
                <Btn small onClick={() => reloadServerVersion()}>
                  重新读取服务器版本…
                </Btn>
              </div>
            </section>
          )}
          <ManuscriptEditor
            key={`${current}:${editorGeneration}`}
            chapterId={current}
            initial={doc[current] ?? ['']}
            initialMarkdown={markdownByChapter[current]}
            annotations={annotations}
            flash={flash}
            onChange={onChange}
            onSelectIssue={selectIssue}
            onSelection={(t) => setSelection(t.trim())}
            onReady={handleEditorReady}
          />
        </article>
      )}
    </div>
  )
}
