import ManagedStudio, { useManagement } from '../features/management/ManagedStudio'
import type { ManagedBook } from '@writer-agent/contracts'
import { ApiProblemError } from '../services/writerAgent'
import StudioHeader from '../features/vnext/StudioHeader'
import WritingSpace from '../features/workspace/WritingSpace'
import BookSpace from '../features/knowledge/BookSpace'
import { useStudioController } from '../features/vnext/useStudioController'
import ThinkingPage from '../features/vnext/ThinkingPage'
import CanonCandidate from '../features/vnext/CanonCandidate'
import SaveConflictDialog from '../features/workspace/SaveConflictDialog'
import { useEffect, useState } from 'react'
import type { WorkspaceSnapshot } from '@writer-agent/contracts'
import type { WriterAgentAdapter } from '../services/writerAgent'
import { createWriterAgentAdapter } from '../services/adapterFactory'
import { ConfirmDialog, Toasts } from '../components/ui'
import QuickNote from '../features/notes/QuickNote'
type AppLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'managed'; adapter: WriterAgentAdapter; books: ManagedBook[] }
  | {
      status: 'ready'
      adapter: WriterAgentAdapter
      workspace: WorkspaceSnapshot
    }

export default function App({ adapter: providedAdapter }: { adapter?: WriterAgentAdapter } = {}) {
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState<AppLoadState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    setLoad({ status: 'loading' })
    void (async () => {
      const adapter = providedAdapter ?? (await createWriterAgentAdapter())
      if (adapter.management) {
        try {
          const books = await adapter.management.list()
          if (active) setLoad({ status: 'managed', adapter, books })
          return
        } catch (e) {
          if (!(e instanceof ApiProblemError && e.status === 404)) throw e
        }
      }
      const configuredProjectId = import.meta.env.VITE_WRITER_AGENT_PROJECT_ID?.trim()
      if (adapter.mode === 'api' && !configuredProjectId)
        throw new Error(
          'API 模式缺少 VITE_WRITER_AGENT_PROJECT_ID；请使用仓库提供的本地联调命令或配置项目 ID。',
        )
      const projectId = configuredProjectId || 'demo-writer-agent'
      const workspace = await adapter.loadWorkspace(projectId)
      if (active) setLoad({ status: 'ready', adapter, workspace })
    })().catch((cause: unknown) => {
      if (active)
        setLoad({
          status: 'error',
          message: cause instanceof Error ? cause.message : '工作区加载失败。',
        })
    })
    return () => {
      active = false
    }
  }, [providedAdapter, attempt])

  if (load.status === 'loading') return <WorkspaceLoadNotice message="正在加载作品工作区…" />
  if (load.status === 'error')
    return (
      <WorkspaceLoadNotice
        message={`工作区加载失败：${load.message}`}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    )
  if (load.status === 'managed')
    return (
      <ManagedStudio
        adapter={load.adapter}
        initialBooks={load.books}
        render={(workspace, generation) => (
          <WriterStudio
            key={`${workspace.projectId}:${generation}`}
            adapter={load.adapter}
            initialWorkspace={workspace}
          />
        )}
      />
    )
  return <WriterStudio adapter={load.adapter} initialWorkspace={load.workspace} />
}

function WorkspaceLoadNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[var(--bg)] text-sm text-[var(--ink-2)]">
      <p role="status" aria-live="polite">
        {message}
      </p>
      {onRetry && (
        <button type="button" className="btn rounded border px-3 py-2" onClick={onRetry}>
          重试加载
        </button>
      )}
    </div>
  )
}

function WriterStudio({
  adapter,
  initialWorkspace,
}: {
  adapter: WriterAgentAdapter
  initialWorkspace: WorkspaceSnapshot
}) {
  const studio = useStudioController(adapter, initialWorkspace)
  const management = useManagement()
  const { workspace: managedWorkspace, editor: managedEditor } = studio
  useEffect(() => {
    if (!management) return
    management.activeChapter.current = managedWorkspace.current
    management.preferences.current = {
      theme: managedWorkspace.dark ? 'dark' : 'light',
      layout: managedWorkspace.layout,
    }
    management.guard.current = async () => {
      await managedWorkspace.prepareStructure()
    }
    return () => {
      management.guard.current = null
    }
  }, [management, managedWorkspace])
  const isManaged = management !== null
  const composing = studio.compose
  useEffect(() => {
    if (!isManaged || !composing || managedWorkspace.chapterLoadState.status !== 'loaded') return
    // Inline names and note fields keep their own focus while the body loads.
    if (document.activeElement?.matches('input, textarea, select')) return
    managedEditor.current?.commands.focus('end')
  }, [isManaged, composing, managedWorkspace.current, managedWorkspace.chapterLoadState.status, managedEditor])
  const {
    view,
    setView,
    setBookNav,
    quick,
    setQuick,
    candidateNote,
    setCandidateNote,
    candidateContext,
    setCandidateContext,
    saveDialog,
    setSaveDialog,
    confirm,
    setConfirm,
    toasts,
    typing,
    setTyping,
    workspace,
    current,
    dark,
    editor,
    prototype,
    notes,
    downloadLocalDraft,
  } = studio
  return (
    <div
      className={`${dark ? 'dark' : ''} ${typing ? 'is-typing' : ''}`}
      onPointerMove={() => setTyping(false)}
    >
      <div className="flex h-dvh flex-col overflow-hidden bg-page text-ink">
        <StudioHeader studio={studio} demo={adapter.mode === 'demo'} />
        <WritingSpace studio={studio} adapter={adapter} />
        <BookSpace studio={studio} adapter={adapter} />
        {view === 'inspire' && <ThinkingPage studio={studio} adapter={adapter} />}
      </div>
      {quick && (
        <QuickNote
          notes={notes}
          chapterId={current}
          quote={studio.selection}
          onClose={() => {
            setQuick(false)
            editor.current?.commands.focus()
          }}
        />
      )}
      {(candidateNote || candidateContext) && adapter.mode === 'demo' && (
        <CanonCandidate
          note={candidateNote}
          context={candidateContext}
          entries={prototype.entries}
          onClose={() => {
            setCandidateNote(null)
            setCandidateContext(null)
          }}
          onCreate={(candidate) => {
            prototype.setChanges((all) => [...all, candidate])
            setCandidateNote(null)
            setCandidateContext(null)
            setView('book')
            setBookNav({ section: 'notes', changeId: candidate.id })
          }}
        />
      )}
      {saveDialog && (
        <SaveConflictDialog
          adapter={adapter}
          projectId={initialWorkspace.projectId}
          chapterId={current}
          localMarkdown={workspace.exportLocalDraft() ?? workspace.markdownByChapter[current] ?? ''}
          onExport={downloadLocalDraft}
          onKeep={() => setSaveDialog(false)}
          onUseServer={() => {
            setSaveDialog(false)
            workspace.reloadServerVersion()
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          key={confirm.title}
          {...confirm}
          requireAcknowledgement={confirm.title === '使用服务器版本？'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm.run()
            setConfirm(null)
          }}
        />
      )}
      <Toasts items={toasts} />
    </div>
  )
}
