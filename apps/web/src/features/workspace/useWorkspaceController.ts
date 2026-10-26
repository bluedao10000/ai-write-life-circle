import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiChapterVersion, ChallengeRound, ChatMessage, ChapterVersion, Decision, DecisionAction, Document, Proposal, UserWorkspaceStateV04, WorkspaceSnapshot, WorkspacePreferences, WorkspaceResume } from '@writer-agent/contracts'
import type { AgentTask, Layout } from '../../types'
import { ChapterRevisionConflictError, type WriterAgentAdapter } from '../../services/writerAgent'
import { useWorkspaceActions } from './useWorkspaceActions'
import { createId } from '../../lib/id'
import { hashMarkdown } from '../../lib/sourceHash'
import { plainParagraphsToMarkdown } from '../../lib/manuscriptMarkdown'
import { mapChapterDetail } from '../../services/mappers/chapterMapper'
import { clearLocalChapterDraft, createIdempotencyKey, readLocalChapterDraft, writeLocalChapterDraft, type LocalChapterDraft } from '../../services/localChapterDraft'

export const WORKSPACE_STORAGE_KEY = 'writer-agent.v2'

export type WorkspaceConfirmAction = {
  title: string
  desc: string
  confirmText: string
  danger?: boolean
  run: () => void
}

export type SaveState =
  | { s: 'dirty' }
  | { s: 'saving' }
  | { s: 'saved'; at: number }
  | { s: 'recovery' }
  | { s: 'error'; message: string; conflict: boolean }

export type ChapterLoadState =
  | { status: 'idle' | 'loading' | 'loaded' }
  | { status: 'error'; message: string }

export type RecoverableChapterDraft = LocalChapterDraft & { conflict: boolean }

type PersistedWorkspace = {
  doc: Document
  markdownByChapter?: Record<string, string>
  proposals: Proposal[]
  decisions: Decision[]
  chapterVersions: Record<string, ChapterVersion>
  layout: Layout
  layoutCustomized?: boolean
  chat: ChatMessage[]
  challenge: ChallengeRound[]
  seq: number
  current: string
  dark: boolean
}

const defaultLayout: Layout = { leftOpen: false, rightOpen: false, leftW: 280, rightW: 360, focus: false }

function getDemoPreferences() {
  if (typeof localStorage === 'undefined') return { layout: defaultLayout, layoutCustomized: false, dark: false }
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) || 'null') as Partial<PersistedWorkspace> | null
    const layoutCustomized = saved?.layoutCustomized ?? Boolean(saved?.layout)
    return saved
      ? { layout: layoutCustomized ? { ...defaultLayout, ...saved.layout } : defaultLayout, layoutCustomized, dark: saved.dark ?? false }
      : { layout: defaultLayout, layoutCustomized: false, dark: false }
  } catch {
    return { layout: defaultLayout, layoutCustomized: false, dark: false }
  }
}

function getInitialPreferences(adapterMode: WriterAgentAdapter['mode'], workspacePreferences: WorkspacePreferences | undefined) {
  if (adapterMode === 'demo') return getDemoPreferences()
  const stored = workspacePreferences
  return {
    layout: { ...defaultLayout, ...stored?.layout },
    layoutCustomized: Boolean(stored?.layout),
    dark: stored?.theme === 'dark',
  }
}

export function useWorkspaceController({ adapter, initialWorkspace, toast, requestConfirm }: {
  adapter: WriterAgentAdapter
  initialWorkspace: WorkspaceSnapshot
  toast: (message: string) => void
  requestConfirm: (action: WorkspaceConfirmAction) => void
}) {
  const actions = useWorkspaceActions(adapter)
  const preferences = useMemo(() => getInitialPreferences(adapter.mode, initialWorkspace.preferences), [adapter.mode, initialWorkspace.preferences])
  const chapterIds = useMemo(() => new Set(initialWorkspace.chapters.map((chapter) => chapter.id)), [initialWorkspace])
  const [doc, setDoc] = useState(initialWorkspace.document)
  const [markdownByChapter, setMarkdownByChapter] = useState(initialWorkspace.markdownByChapter ?? Object.fromEntries(
    Object.entries(initialWorkspace.document).map(([chapterId, paragraphs]) => [chapterId, plainParagraphsToMarkdown(paragraphs)]),
  ))
  const [proposals, setProposals] = useState(initialWorkspace.proposals)
  const [decisions, setDecisions] = useState(initialWorkspace.decisions)
  const [chapterVersions, setChapterVersions] = useState(initialWorkspace.chapterVersions)
  const [layout, setLayoutState] = useState(preferences.layout)
  const [layoutCustomized, setLayoutCustomized] = useState(preferences.layoutCustomized)
  const setLayout = useCallback((next: Layout | ((current: Layout) => Layout)) => {
    setLayoutState(next)
    setLayoutCustomized(true)
  }, [])
  const [chat, setChat] = useState(initialWorkspace.chat)
  const [challenge, setChallenge] = useState(initialWorkspace.challenge)
  const [seq, setSeq] = useState(initialWorkspace.sequence)
  const activeChapterRef = useRef('')
  const [current, setCurrent] = useState(chapterIds.has(initialWorkspace.currentChapterId) ? initialWorkspace.currentChapterId : initialWorkspace.chapters[0]?.id ?? '')
  activeChapterRef.current = current
  const [dark, setDark] = useState(preferences.dark)
  const [task, setTask] = useState<AgentTask>({ state: 'idle' })
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>(() => Object.fromEntries(
    initialWorkspace.chapters.map((chapter) => [chapter.id, { s: 'saved', at: Date.now() } satisfies SaveState]),
  ))
  const [chapterLoadStates, setChapterLoadStates] = useState<Record<string, ChapterLoadState>>(() => Object.fromEntries(
    initialWorkspace.chapters.map((chapter) => [chapter.id, { status: adapter.mode === 'demo' ? 'loaded' : 'idle' } satisfies ChapterLoadState]),
  ))
  const [recoveryDrafts, setRecoveryDrafts] = useState<Record<string, RecoverableChapterDraft>>({})
  const [volatileDrafts, setVolatileDrafts] = useState<Record<string, string>>({})
  const [editorGeneration, setEditorGeneration] = useState(0)

  const docRef = useRef(doc)
  docRef.current = doc
  const markdownByChapterRef = useRef(markdownByChapter)
  markdownByChapterRef.current = markdownByChapter
  const proposalsRef = useRef(proposals)
  proposalsRef.current = proposals
  const chapterVersionsRef = useRef(chapterVersions)
  const apiVersionsRef = useRef<Record<string, ApiChapterVersion>>(Object.fromEntries(
    Object.entries(initialWorkspace.chapterVersions).flatMap(([id, version]) => version.mode === 'api' ? [[id, version]] : []),
  ))
  const apiSaveBaseRevisionRef = useRef<Record<string, string | null>>(Object.fromEntries(
    Object.entries(apiVersionsRef.current).map(([id, version]) => [id, version.revisionId]),
  ))
  const editVersionsRef = useRef(new Map(initialWorkspace.chapters.map((chapter) => [chapter.id, 0])))
  const savedEditVersionsRef = useRef(new Map(initialWorkspace.chapters.map((chapter) => [chapter.id, 0])))
  const saveTimersRef = useRef(new Map<string, number>())
  const saveQueuesRef = useRef(new Map<string, Promise<boolean>>())
  const saveAttemptsRef = useRef(new Map<string, Promise<boolean>>())
  const loadedApiChaptersRef = useRef(new Set<string>())
  const pendingApiChapterLoadsRef = useRef(new Map<string, Promise<void>>())
  const conflictedChaptersRef = useRef(new Set<string>())
  const aliveRef = useRef(true)
  const workspacePatchQueueRef = useRef(Promise.resolve())
  const reviewTimer = useRef<number | undefined>(undefined)
  const reviewGeneration = useRef(0)
  const reviewInFlight = useRef(false)

  const persist = useCallback(() => {
    if (adapter.mode !== 'demo' || typeof localStorage === 'undefined') return
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      doc, markdownByChapter, proposals, decisions, chapterVersions,
      layout, layoutCustomized, chat, challenge, seq, current, dark,
    } satisfies PersistedWorkspace))
  }, [adapter.mode, doc, markdownByChapter, proposals, decisions, chapterVersions, layout, layoutCustomized, chat, challenge, seq, current, dark])
  useEffect(persist, [persist])

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const setChapterSaveState = useCallback((chapterId: string, state: SaveState) => {
    setSaveStates((states) => ({ ...states, [chapterId]: state }))
  }, [])

  const setChapterLoadState = useCallback((chapterId: string, state: ChapterLoadState) => {
    setChapterLoadStates((states) => ({ ...states, [chapterId]: state }))
  }, [])

  const updateChapterVersion = useCallback((chapterId: string, version: ChapterVersion) => {
    const next = { ...chapterVersionsRef.current, [chapterId]: version }
    chapterVersionsRef.current = next
    setChapterVersions(next)
    if (version.mode === 'api') apiVersionsRef.current = { ...apiVersionsRef.current, [chapterId]: version }
  }, [])

  const loadApiChapter = useCallback((chapterId: string, force = false, discardLocalDraft = false): Promise<void> => {
    if (adapter.mode !== 'api') return Promise.resolve()
    if (!force && loadedApiChaptersRef.current.has(chapterId)) return Promise.resolve()
    const pending = pendingApiChapterLoadsRef.current.get(chapterId)
    if (pending) return pending

    setChapterLoadState(chapterId, { status: 'loading' })
    const request = (async () => {
      const draftBeforeRead = discardLocalDraft ? null : readLocalChapterDraft(initialWorkspace.projectId, chapterId)
      if (draftBeforeRead) {
        setRecoveryDrafts((drafts) => ({ ...drafts, [chapterId]: { ...draftBeforeRead, conflict: true } }))
        setChapterSaveState(chapterId, { s: 'recovery' })
      }
      const detail = await adapter.loadChapter(initialWorkspace.projectId, chapterId)
      if (detail.chapterId !== chapterId) throw new Error('Chapter 响应的 chapterId 与请求不一致。')
      const volumeLabel = initialWorkspace.chapters.find((chapter) => chapter.id === chapterId)?.volume
      const mapped = mapChapterDetail(detail, volumeLabel)
      const actualContentHash = await hashMarkdown(mapped.markdown)
      if (actualContentHash !== mapped.version.contentHash) {
        throw new Error('章节 Markdown 与服务端 contentHash 不一致；已阻止编辑和保存。')
      }
      const currentRevisionId = mapped.version.revisionId
      const localDraft = discardLocalDraft ? null : readLocalChapterDraft(initialWorkspace.projectId, chapterId)
      let recovery: RecoverableChapterDraft | null = null
      if (localDraft) {
        const localHash = await hashMarkdown(localDraft.markdown)
        if (localHash === mapped.version.contentHash) {
          clearLocalChapterDraft(initialWorkspace.projectId, chapterId)
        } else {
          recovery = { ...localDraft, contentHash: localHash, conflict: localDraft.baseRevisionId !== currentRevisionId }
        }
      }
      if (discardLocalDraft) clearLocalChapterDraft(initialWorkspace.projectId, chapterId)
      if (!aliveRef.current) return

      apiSaveBaseRevisionRef.current = { ...apiSaveBaseRevisionRef.current, [chapterId]: currentRevisionId }
      updateChapterVersion(chapterId, mapped.version)
      const nextMarkdown = { ...markdownByChapterRef.current, [chapterId]: mapped.markdown }
      markdownByChapterRef.current = nextMarkdown
      setMarkdownByChapter(nextMarkdown)
      const nextDocument = { ...docRef.current }
      delete nextDocument[chapterId]
      docRef.current = nextDocument
      setDoc(nextDocument)
      setEditorGeneration((generation) => generation + 1)
      setRecoveryDrafts((drafts) => {
        const next = { ...drafts }
        if (recovery) next[chapterId] = recovery
        else delete next[chapterId]
        return next
      })
      if (discardLocalDraft) {
        setVolatileDrafts((drafts) => {
          const next = { ...drafts }
          delete next[chapterId]
          return next
        })
      }
      setChapterSaveState(chapterId, recovery ? { s: 'recovery' } : { s: 'saved', at: Date.now() })
      setChapterLoadState(chapterId, { status: 'loaded' })
      loadedApiChaptersRef.current.add(chapterId)
      const editVersion = editVersionsRef.current.get(chapterId) ?? 0
      savedEditVersionsRef.current.set(chapterId, editVersion)
      if (discardLocalDraft) conflictedChaptersRef.current.delete(chapterId)
    })().catch((cause: unknown) => {
      if (aliveRef.current) setChapterLoadState(chapterId, {
        status: 'error',
        message: cause instanceof Error ? cause.message : '章节加载失败。',
      })
      throw cause
    }).finally(() => {
      pendingApiChapterLoadsRef.current.delete(chapterId)
    })
    pendingApiChapterLoadsRef.current.set(chapterId, request)
    return request
  }, [adapter, initialWorkspace.chapters, initialWorkspace.projectId, setChapterLoadState, setChapterSaveState, updateChapterVersion])

  useEffect(() => {
    if (adapter.mode !== 'api' || !current) return
    void loadApiChapter(current).catch(() => undefined)
  }, [adapter.mode, current, loadApiChapter])

  useEffect(() => {
    if (adapter.mode !== 'api') return
    const timer = window.setTimeout(() => {
      const patch: UserWorkspaceStateV04 = {
        lastView: 'write',
        ...(current ? { lastChapterId: current } : {}),
        layout: { ...layout },
        theme: dark ? 'dark' : 'light',
      }
      workspacePatchQueueRef.current = workspacePatchQueueRef.current
        .catch(() => undefined)
        .then(() => adapter.updateWorkspaceState(initialWorkspace.projectId, patch))
        .then(() => undefined)
        .catch((cause: unknown) => toast(cause instanceof Error ? `工作台偏好保存失败：${cause.message}` : '工作台偏好保存失败。'))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [adapter, adapter.mode, current, dark, initialWorkspace.projectId, layout, toast])

  const updateResume = useCallback((resume: WorkspaceResume) => {
    if (adapter.mode !== 'api') return
    workspacePatchQueueRef.current = workspacePatchQueueRef.current.catch(() => undefined)
      .then(() => adapter.updateWorkspaceState(initialWorkspace.projectId, { resume, lastChapterId: resume.chapterId }))
      .then(() => undefined).catch(() => { /* Navigation preferences never block prose saving. */ })
  }, [adapter, initialWorkspace.projectId])

  const enqueueSave = useCallback((chapterId: string, paragraphs: string[], markdown: string, editVersion: number): Promise<boolean> => {
    const attemptKey = `${chapterId}:${editVersion}`
    const existingAttempt = saveAttemptsRef.current.get(attemptKey)
    if (existingAttempt) return existingAttempt

    const prior = saveQueuesRef.current.get(chapterId) ?? Promise.resolve(true)
    const attempt = prior.catch(() => false).then(async () => {
      // A newer edit may already be queued when an earlier save discovers a
      // revision conflict. Keep that edit locally until the author resolves it.
      if (conflictedChaptersRef.current.has(chapterId)) return false

      if (adapter.mode === 'api') {
        const baseVersion = apiVersionsRef.current[chapterId]
        if (!baseVersion) throw new Error('缺少服务端章节版本，无法安全保存。')
        const baseRevisionId = apiSaveBaseRevisionRef.current[chapterId] ?? baseVersion.revisionId
        const contentHash = await hashMarkdown(markdown)
        if (conflictedChaptersRef.current.has(chapterId)) return false
        const existingDraft = readLocalChapterDraft(initialWorkspace.projectId, chapterId)
        const draft: LocalChapterDraft = existingDraft
          && existingDraft.markdown === markdown
          && existingDraft.baseRevisionId === baseRevisionId
          ? { ...existingDraft, contentHash, updatedAt: new Date().toISOString() }
          : {
              projectId: initialWorkspace.projectId,
              chapterId,
              baseRevisionId,
              markdown,
              contentHash,
              idempotencyKey: createIdempotencyKey(),
              updatedAt: new Date().toISOString(),
            }
        // Persist the exact payload and key before sending; a lost response can be replayed safely.
        try {
          writeLocalChapterDraft(draft)
        } catch {
          throw new Error('浏览器无法保存本地恢复草稿；为避免请求结果丢失，本次尚未发送到服务器。')
        }
        // Recheck at the transport boundary as async hashing above can overlap
        // with a preceding queued save changing this chapter to conflicted.
        if (conflictedChaptersRef.current.has(chapterId)) return false
        const result = await adapter.saveChapterRevision({
          projectId: initialWorkspace.projectId,
          chapterId,
          revision: {
            baseRevisionId,
            markdown,
            clientSavedAt: new Date().toISOString(),
            trigger: 'autosave',
          },
          idempotencyKey: draft.idempotencyKey,
        })
        if (!result.revisionId?.trim() || result.contentHash !== contentHash) {
          throw new Error('服务器保存响应的 revisionId 或正文 Hash 与本次内容不匹配；本地草稿仍保留。')
        }
        const nextVersion = {
          mode: 'api' as const,
          revisionId: result.revisionId,
          parentRevisionId: result.parentRevisionId ?? baseRevisionId,
          contentHash: result.contentHash,
          ...(result.createdAt ? { createdAt: result.createdAt } : {}),
        }
        apiSaveBaseRevisionRef.current = { ...apiSaveBaseRevisionRef.current, [chapterId]: result.revisionId }
        conflictedChaptersRef.current.delete(chapterId)
        updateChapterVersion(chapterId, nextVersion)
        const persistedDraft = readLocalChapterDraft(initialWorkspace.projectId, chapterId)
        if (persistedDraft?.idempotencyKey === draft.idempotencyKey && persistedDraft.markdown === markdown) {
          clearLocalChapterDraft(initialWorkspace.projectId, chapterId)
          setRecoveryDrafts((drafts) => {
            const next = { ...drafts }
            delete next[chapterId]
            return next
          })
        }
        if (markdownByChapterRef.current[chapterId] === markdown) {
          setVolatileDrafts((drafts) => {
            const next = { ...drafts }
            delete next[chapterId]
            return next
          })
        }
        savedEditVersionsRef.current.set(chapterId, editVersion)
        if (editVersionsRef.current.get(chapterId) === editVersion) setChapterSaveState(chapterId, { s: 'saved', at: Date.now() })
        return true
      }

      const baseVersion = chapterVersionsRef.current[chapterId]
      if (!baseVersion || baseVersion.mode !== 'demo') throw new Error('缺少演示章节版本，无法安全保存。')
      const sourceHash = await hashMarkdown(markdown)
      const result = await actions.saveChapter({
        projectId: initialWorkspace.projectId,
        chapterId,
        paragraphs,
        markdown,
        revision: baseVersion.revision,
        sourceHash,
      })
      if (result.projectId !== initialWorkspace.projectId || result.chapterId !== chapterId || result.sourceHash !== sourceHash || result.revision <= baseVersion.revision) {
        throw new Error('保存响应与当前章节版本不匹配，草稿仍保留在本地。')
      }

      updateChapterVersion(chapterId, { mode: 'demo', revision: result.revision, sourceHash: result.sourceHash })
      savedEditVersionsRef.current.set(chapterId, editVersion)
      if (editVersionsRef.current.get(chapterId) === editVersion) setChapterSaveState(chapterId, { s: 'saved', at: result.savedAt })
      return true
    }).catch((cause: unknown) => {
      const conflict = cause instanceof ChapterRevisionConflictError
      if (conflict) {
        conflictedChaptersRef.current.add(chapterId)
        const timer = saveTimersRef.current.get(chapterId)
        if (timer !== undefined) {
          window.clearTimeout(timer)
          saveTimersRef.current.delete(chapterId)
        }
      }
      if (conflict || editVersionsRef.current.get(chapterId) === editVersion) {
        const message = cause instanceof Error ? cause.message : '保存失败。'
        setChapterSaveState(chapterId, { s: 'error', message, conflict })
        toast(message)
      }
      return false
    })

    saveAttemptsRef.current.set(attemptKey, attempt)
    saveQueuesRef.current.set(chapterId, attempt)
    void attempt.then(() => {
      if (saveAttemptsRef.current.get(attemptKey) === attempt) saveAttemptsRef.current.delete(attemptKey)
      if (saveQueuesRef.current.get(chapterId) === attempt) saveQueuesRef.current.delete(chapterId)
    })
    return attempt
  }, [actions, adapter, initialWorkspace.projectId, setChapterSaveState, toast, updateChapterVersion])

  const scheduleSave = useCallback((chapterId: string, paragraphs: string[], markdown: string, editVersion: number) => {
    const previousTimer = saveTimersRef.current.get(chapterId)
    if (previousTimer !== undefined) window.clearTimeout(previousTimer)
    if (conflictedChaptersRef.current.has(chapterId)) return
    const timer = window.setTimeout(() => {
      saveTimersRef.current.delete(chapterId)
      if (conflictedChaptersRef.current.has(chapterId)) return
      setChapterSaveState(chapterId, { s: 'saving' })
      void enqueueSave(chapterId, paragraphs, markdown, editVersion)
    }, 700)
    saveTimersRef.current.set(chapterId, timer)
  }, [enqueueSave, setChapterSaveState])

  const flushSave = useCallback(async (chapterId = current): Promise<boolean> => {
    const timer = saveTimersRef.current.get(chapterId)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      saveTimersRef.current.delete(chapterId)
    }
    const editVersion = editVersionsRef.current.get(chapterId) ?? 0
    if (editVersion === (savedEditVersionsRef.current.get(chapterId) ?? 0)) return true
    if (conflictedChaptersRef.current.has(chapterId)) return false
    setChapterSaveState(chapterId, { s: 'saving' })
    return enqueueSave(chapterId, docRef.current[chapterId] ?? [], markdownByChapterRef.current[chapterId] ?? '', editVersion)
  }, [current, enqueueSave, setChapterSaveState])

  /** Freeze a confirmed saved revision for review; never substitute an older server body. */
  const prepareReview = useCallback(async (chapterId = current) => {
    if (adapter.mode !== 'api' || !loadedApiChaptersRef.current.has(chapterId)) throw new Error('请等待真实章节读取完成。')
    if (recoveryDrafts[chapterId] || conflictedChaptersRef.current.has(chapterId)) throw new Error('先处理本地草稿恢复或版本冲突，再审查本章。')
    const editVersion = editVersionsRef.current.get(chapterId) ?? 0
    if (!await flushSave(chapterId)) throw new Error('正文尚未安全保存，审查未开始。请先解决保存问题。')
    if ((editVersionsRef.current.get(chapterId) ?? 0) !== editVersion || savedEditVersionsRef.current.get(chapterId) !== editVersion) throw new Error('正文在保存期间又有修改，请停笔保存后重新发起审查。')
    const version = apiVersionsRef.current[chapterId]
    const markdown = markdownByChapterRef.current[chapterId]
    if (!version || markdown === undefined) throw new Error('缺少已保存的章节版本，审查未开始。')
    const contentHash = await hashMarkdown(markdown)
    if ((editVersionsRef.current.get(chapterId) ?? 0) !== editVersion || version.contentHash !== contentHash) throw new Error('当前正文与已保存版本不一致，审查未开始。')
    return { chapterId, revisionId: version.revisionId, contentHash, markdown }
  }, [adapter.mode, current, flushSave, recoveryDrafts])

  /** Guard every loaded draft before a managed structure reload can unmount it. */
  const prepareStructure = useCallback(async () => {
    if (Object.keys(recoveryDrafts).length || conflictedChaptersRef.current.size) throw new Error('先处理本地草稿恢复或版本冲突，再调整作品目录。')
    const ids = new Set([...loadedApiChaptersRef.current, current].filter(Boolean))
    const versions = new Map(editVersionsRef.current)
    for (const id of ids) await prepareReview(id)
    await workspacePatchQueueRef.current
    for (const id of ids) if (editVersionsRef.current.get(id) !== versions.get(id)) throw new Error('正文在保存期间又有修改，请停笔保存后重新操作。')
  }, [current, prepareReview, recoveryDrafts])

  const onChange = useCallback((paragraphs: string[], changedMarkdown?: string) => {
    const chapterId = current
    const markdown = changedMarkdown ?? plainParagraphsToMarkdown(paragraphs)
    let storageFailure = false
    if (adapter.mode === 'api') {
      if (changedMarkdown === undefined) {
        setChapterSaveState(chapterId, { s: 'error', message: '编辑器没有提供 Markdown 序列化结果，已阻止保存以保护原格式。', conflict: false })
        return
      }
      const baseRevisionId = apiSaveBaseRevisionRef.current[chapterId] ?? apiVersionsRef.current[chapterId]?.revisionId ?? null
      const existingDraft = readLocalChapterDraft(initialWorkspace.projectId, chapterId)
      const draft: LocalChapterDraft = existingDraft
        && existingDraft.markdown === markdown
        && existingDraft.baseRevisionId === baseRevisionId
        ? { ...existingDraft, updatedAt: new Date().toISOString() }
        : {
            projectId: initialWorkspace.projectId,
            chapterId,
            baseRevisionId,
            markdown,
            idempotencyKey: createIdempotencyKey(),
            updatedAt: new Date().toISOString(),
          }
      try {
        // Write through synchronously so even an immediate refresh leaves a recoverable draft.
        writeLocalChapterDraft(draft)
        setVolatileDrafts((drafts) => {
          const next = { ...drafts }
          delete next[chapterId]
          return next
        })
      } catch {
        storageFailure = true
        setVolatileDrafts((drafts) => ({ ...drafts, [chapterId]: markdown }))
      }
    }
    const editVersion = (editVersionsRef.current.get(chapterId) ?? 0) + 1
    editVersionsRef.current.set(chapterId, editVersion)
    const nextDocument = { ...docRef.current, [chapterId]: paragraphs }
    docRef.current = nextDocument
    setDoc(nextDocument)
    const nextMarkdown = { ...markdownByChapterRef.current, [chapterId]: markdown }
    markdownByChapterRef.current = nextMarkdown
    setMarkdownByChapter(nextMarkdown)
    const blockedByConflict = conflictedChaptersRef.current.has(chapterId)
    if (storageFailure) {
      setChapterSaveState(chapterId, { s: 'error', message: '浏览器无法保存本地恢复草稿；当前页面仍保留正文，尚未发送到服务器。', conflict: false })
    } else if (blockedByConflict) {
      setChapterSaveState(chapterId, { s: 'error', message: '版本冲突尚未处理。请导出本地草稿或明确加载服务器版本。', conflict: true })
    } else {
      setChapterSaveState(chapterId, { s: 'dirty' })
      scheduleSave(chapterId, paragraphs, markdown, editVersion)
    }
  }, [adapter.mode, current, initialWorkspace.projectId, scheduleSave, setChapterSaveState])

  /** Save the current draft first, then restore through the same CAS/idempotent queue. */
  const restoreHistoricalText = useCallback(async (text: string, mode: 'replace' | 'append') => {
    const id = current
    const saved = await prepareReview(id)
    if (!aliveRef.current || activeChapterRef.current !== id) throw new Error('工作台已关闭，请重新操作。')
    // prepareReview checks edits during I/O; this continuation has no further await before onChange.
    const next = mode === 'append' ? `${saved.markdown}${saved.markdown ? '\n\n' : ''}${text}` : text
    if (next === saved.markdown) return
    onChange([], next)
    setEditorGeneration((value) => value + 1)
    if (!await flushSave(id)) throw new Error('恢复内容已保留为本地草稿，尚未安全保存。请处理保存问题后重试。')
  }, [current, prepareReview, onChange, flushSave])

  const retrySave = useCallback(() => flushSave(current), [current, flushSave])

  const restoreLocalDraft = useCallback(async (chapterId = current) => {
    if (adapter.mode !== 'api') return
    const draft = recoveryDrafts[chapterId] ?? readLocalChapterDraft(initialWorkspace.projectId, chapterId)
    const version = apiVersionsRef.current[chapterId]
    if (!draft || !version) return
    const contentHash = await hashMarkdown(draft.markdown)
    const editVersion = (editVersionsRef.current.get(chapterId) ?? 0) + 1
    editVersionsRef.current.set(chapterId, editVersion)
    apiSaveBaseRevisionRef.current = { ...apiSaveBaseRevisionRef.current, [chapterId]: draft.baseRevisionId }
    try {
      writeLocalChapterDraft({ ...draft, contentHash, updatedAt: new Date().toISOString() })
    } catch {
      setChapterSaveState(chapterId, { s: 'error', message: '无法更新本地恢复记录；原始恢复草稿仍保留。', conflict: false })
      return
    }
    const nextMarkdown = { ...markdownByChapterRef.current, [chapterId]: draft.markdown }
    markdownByChapterRef.current = nextMarkdown
    setMarkdownByChapter(nextMarkdown)
    const nextDocument = { ...docRef.current, [chapterId]: [] }
    docRef.current = nextDocument
    setDoc(nextDocument)
    setEditorGeneration((generation) => generation + 1)
    setRecoveryDrafts((drafts) => {
      const next = { ...drafts }
      delete next[chapterId]
      return next
    })
    const conflict = draft.baseRevisionId !== version.revisionId
    if (conflict) {
      conflictedChaptersRef.current.add(chapterId)
      setChapterSaveState(chapterId, { s: 'error', message: '本地草稿基于较旧版本。正文已恢复到编辑器，但不会自动覆盖服务器版本。', conflict: true })
      return
    }
    conflictedChaptersRef.current.delete(chapterId)
    savedEditVersionsRef.current.set(chapterId, editVersion - 1)
    setChapterSaveState(chapterId, { s: 'dirty' })
    scheduleSave(chapterId, [], draft.markdown, editVersion)
  }, [adapter.mode, current, initialWorkspace.projectId, recoveryDrafts, scheduleSave, setChapterSaveState])

  const reloadServerVersion = useCallback((chapterId = current) => {
    if (adapter.mode !== 'api') return
    requestConfirm({
      title: '使用服务器版本？',
      desc: '这会清除该章节浏览器中尚未确认保存的本地草稿，并重新读取服务器版本。建议先导出本地草稿。',
      confirmText: '使用服务器版本',
      danger: true,
      run: () => { void loadApiChapter(chapterId, true, true).catch((cause: unknown) => toast(cause instanceof Error ? cause.message : '章节重新加载失败。')) },
    })
  }, [adapter.mode, current, loadApiChapter, requestConfirm, toast])

  const retryLoadChapter = useCallback((chapterId = current) => {
    if (adapter.mode === 'api') void loadApiChapter(chapterId, true).catch(() => undefined)
  }, [adapter.mode, current, loadApiChapter])

  const exportLocalDraft = useCallback((chapterId = current): string | null => {
    if (adapter.mode !== 'api') return null
    return volatileDrafts[chapterId]
      ?? recoveryDrafts[chapterId]?.markdown
      ?? readLocalChapterDraft(initialWorkspace.projectId, chapterId)?.markdown
      ?? null
  }, [adapter.mode, current, initialWorkspace.projectId, recoveryDrafts, volatileDrafts])

  useEffect(() => {
    const hasUnsavedChanges = Object.values(saveStates).some((state) => state.s === 'dirty' || state.s === 'saving' || state.s === 'recovery' || state.s === 'error')
    if (!hasUnsavedChanges) return
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [saveStates])

  useEffect(() => () => {
    for (const timer of saveTimersRef.current.values()) window.clearTimeout(timer)
    if (reviewTimer.current !== undefined) window.clearInterval(reviewTimer.current)
  }, [])

  const switchChapter = useCallback((chapterId: string) => {
    if (chapterId === current || !chapterIds.has(chapterId)) return
    void flushSave(current)
    activeChapterRef.current = chapterId
    setCurrent(chapterId)
  }, [chapterIds, current, flushSave])

  const addDecision = (proposalId: string, action: DecisionAction, by: Decision['by'] = '作者', note?: string): Decision => ({
    id: createId(), proposalId, action, by, note, at: Date.now(),
  })

  const runReview = useCallback(async () => {
    if (adapter.mode !== 'demo') {
      setTask({ state: 'failed', error: '真实 Agent 审查尚未接入；API 模式不会调用演示响应。' })
      return
    }
    if (reviewInFlight.current) return
    reviewInFlight.current = true
    const runId = ++reviewGeneration.current
    const chapterId = current
    const saveOk = await flushSave(chapterId)
    if (runId !== reviewGeneration.current) {
      reviewInFlight.current = false
      return
    }
    if (!saveOk) {
      reviewInFlight.current = false
      setTask({ state: 'failed', error: '章节尚未保存，审查已暂停。修复保存问题后可重试。' })
      return
    }

    const reviewRunId = createId()
    const paragraphs = docRef.current[chapterId] ?? []
    const baseVersion = chapterVersionsRef.current[chapterId]
    if (!baseVersion || baseVersion.mode !== 'demo') {
      reviewInFlight.current = false
      setTask({ state: 'failed', error: '当前章节版本不支持演示审查。' })
      return
    }
    const markdown = markdownByChapterRef.current[chapterId] ?? plainParagraphsToMarkdown(paragraphs)
    const sourceHash = await hashMarkdown(markdown)
    const steps = ['读取本章正文', '比对时间线', '检索人物档案', '核对伏笔库', '整理证据与分析']
    let index = 0
    setTask({ state: 'running', name: `连续性审查 · ${initialWorkspace.chapters.find((chapter) => chapter.id === chapterId)?.title}`, step: steps[0], progress: 8 })
    reviewTimer.current = window.setInterval(() => {
      index++
      if (index < steps.length) {
        setTask((currentTask) => currentTask.state === 'running' ? { ...currentTask, step: steps[index], progress: 8 + (index * 84) / steps.length } : currentTask)
        return
      }
      if (reviewTimer.current !== undefined) window.clearInterval(reviewTimer.current)
      const currentParagraphs = docRef.current[chapterId] ?? []
      if (currentParagraphs.join('').replace(/\s/g, '').length < 20) {
        reviewInFlight.current = false
        setTask({ state: 'failed', error: '本章正文不足 20 字，无法进行有意义的比对。请先写一些内容。' })
        return
      }
      void actions.reviewChapter({
        projectId: initialWorkspace.projectId,
        chapterId,
        paragraphs,
        markdown,
        revision: baseVersion.revision,
        sourceHash,
        reviewRunId,
        scope: ['timeline', 'characters', 'foreshadowing', 'worldbuilding'],
        sequence: seq,
      }).then(async (result) => {
        if (runId !== reviewGeneration.current) return
        const liveHash = await hashMarkdown(markdownByChapterRef.current[chapterId] ?? '')
        const liveVersion = chapterVersionsRef.current[chapterId]
        if (liveHash !== sourceHash || liveVersion?.mode !== 'demo' || liveVersion.revision !== baseVersion.revision) {
          reviewInFlight.current = false
          setTask({ state: 'failed', error: '审查期间正文版本发生变化，旧结果已丢弃。请重新审查。' })
          return
        }
        if (result.projectId !== initialWorkspace.projectId || result.chapterId !== chapterId || result.reviewRunId !== reviewRunId || result.revision !== baseVersion.revision || result.sourceHash !== sourceHash) {
          reviewInFlight.current = false
          setTask({ state: 'failed', error: '审查结果与提交的正文版本不匹配，已丢弃。' })
          return
        }
        if (result.evidenceValidation.status === 'invalid') {
          reviewInFlight.current = false
          setTask({ state: 'failed', error: '审查证据校验失败，结果未写入提案。' })
          return
        }

        setSeq((value) => value + Math.max(result.proposals.length, 1))
        const touchedIds = new Set<string>()
        const newDecisions: Decision[] = []
        const next = proposalsRef.current.map((proposal) => ({ ...proposal }))
        for (const resultProposal of result.proposals) {
          if (resultProposal.projectId !== initialWorkspace.projectId || resultProposal.reviewRunId !== reviewRunId || resultProposal.chapterRevision !== baseVersion.revision || resultProposal.sourceHash !== sourceHash) {
            reviewInFlight.current = false
            setTask({ state: 'failed', error: '提案缺少当前审查版本信息，结果未写入。' })
            return
          }
          const existing = next.find((proposal) => proposal.chapterId === chapterId && proposal.ruleKey === resultProposal.ruleKey)
          if (!existing) { next.push(resultProposal); touchedIds.add(resultProposal.id); continue }
          touchedIds.add(existing.id)
          existing.anchor = resultProposal.anchor
          existing.projectId = resultProposal.projectId
          existing.reviewRunId = resultProposal.reviewRunId
          existing.chapterRevision = resultProposal.chapterRevision
          existing.sourceHash = resultProposal.sourceHash
          existing.evidenceRefs = resultProposal.evidenceRefs
          existing.evidence = resultProposal.evidence
          existing.updatedAt = Date.now()
          if (existing.status === 'resolved') {
            existing.status = 'pending'
            newDecisions.push(addDecision(existing.id, '复审：再次出现', '系统复审'))
          }
        }
        setProposals(next)
        setDecisions((existing) => [...existing, ...newDecisions])
        const hasHistoricalUnresolved = next.some((proposal) => proposal.status === 'pending' && !touchedIds.has(proposal.id))
        const coverageIncomplete = !result.coverage.complete
        const evidencePartial = result.evidenceValidation.status === 'partial'
        const notices = [
          coverageIncomplete ? '本次仅完成部分检查，不能认定章节不存在其他问题' : '',
          evidencePartial ? '部分证据未核验' : '',
        ].filter(Boolean)
        let summary: string
        if (result.proposals.length > 0) {
          summary = '本次审查已整理出发现，可按需查看。'
        } else if (hasHistoricalUnresolved) {
          summary = '仍有此前的发现等待判断。'
        } else if (coverageIncomplete || evidencePartial) {
          summary = '本次没有新的已核验发现；检查范围或证据尚不完整。'
        } else {
          summary = '本次未发现新问题。'
        }
        reviewInFlight.current = false
        setTask({ state: 'done', summary: [summary, ...notices].join(' · '), at: Date.now() })
      }).catch((cause: unknown) => {
        if (runId === reviewGeneration.current) {
          reviewInFlight.current = false
          setTask({ state: 'failed', error: cause instanceof Error ? cause.message : '审查请求失败。' })
        }
      })
    }, 520)
  }, [actions, adapter.mode, current, flushSave, initialWorkspace.chapters, initialWorkspace.projectId, seq])

  const cancelReview = useCallback(() => {
    reviewGeneration.current++
    reviewInFlight.current = false
    if (reviewTimer.current !== undefined) window.clearInterval(reviewTimer.current)
    setTask({ state: 'idle' })
  }, [])

  const decide = useCallback(async (id: string, action: 'adopt' | 'reject' | 'defer' | 'note' | 'reopen', optionId?: string) => {
    const proposal = proposalsRef.current.find((value) => value.id === id)
    if (!proposal) return
    if (action === 'adopt' && proposal.origin === '审查') {
      const chapterId = proposal.chapterId
      if (!chapterId || !proposal.sourceHash || proposal.chapterRevision === undefined) {
        toast('这条旧提案没有正文版本信息，请先重新审查后再采纳。')
        return
      }
      const liveHash = await hashMarkdown(markdownByChapterRef.current[chapterId] ?? '')
      const chapterVersion = chapterVersionsRef.current[chapterId]
      if (proposal.projectId !== initialWorkspace.projectId || proposal.sourceHash !== liveHash || chapterVersion?.mode !== 'demo' || proposal.chapterRevision !== chapterVersion.revision) {
        toast('这条提案对应的正文版本已变化，已阻止采纳。请重新审查后再决定。')
        return
      }
    }
    const apply = () => {
      const map = { adopt: ['adopted', '采纳'], reject: ['rejected', '拒绝'], defer: ['deferred', '暂缓'], note: ['noted', '标记为待整理参考'], reopen: ['pending', '重新打开'] } as const
      const [status, label] = map[action]
      setProposals((all) => all.map((value) => value.id === id ? {
        ...value, status, chosenOption: action === 'adopt' ? optionId : action === 'reopen' ? undefined : value.chosenOption, updatedAt: Date.now(),
      } : value))
      setDecisions((all) => [...all, addDecision(id, label, '作者', action === 'adopt' ? proposal.options.find((option) => option.id === optionId)?.label : undefined)])
      toast(action === 'adopt' ? '已采纳 · 正文保持不变，等待你修改' : action === 'note' ? '已标记为待整理参考（仅记录状态，未创建独立笔记或写入设定）' : `提案 ${id} 已${label}`)
    }
    if (action === 'reject') requestConfirm({
      title: proposal.kind === 'research' ? '忽略这条研究参考？' : '拒绝这条建议？',
      desc: '拒绝后，同一问题在复审中不会再次提醒。你可以随时在「决策」中撤回。',
      confirmText: '确认拒绝', danger: true, run: apply,
    })
    else apply()
  }, [initialWorkspace.projectId, requestConfirm, toast])

  const createProposal = useCallback((proposal: Omit<Proposal, 'id' | 'ruleKey' | 'createdAt' | 'updatedAt' | 'status'>) => {
    const id = `P-D${String(proposalsRef.current.filter((value) => value.origin !== '审查').length + 1).padStart(3, '0')}`
    const now = Date.now()
    setProposals((all) => [...all, { ...proposal, id, ruleKey: id, status: 'pending', createdAt: now, updatedAt: now }])
    setDecisions((all) => [...all, addDecision(id, '创建提案')])
    toast(`已保存为候选提案 ${id} · 见「决策」`)
    return id
  }, [toast])

  const sendChat = useCallback(async (text: string, quote?: string) => {
    const author: ChatMessage = { id: createId(), role: 'author', text, quote }
    setChat((messages) => [...messages, author])
    try {
      const reply = await actions.sendMessage({ projectId: initialWorkspace.projectId, chapterId: current, text, quote })
      setChat((messages) => [...messages, { id: createId(), role: 'agent', ...reply }])
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : '对话请求失败。')
    }
  }, [actions, current, initialWorkspace.projectId, toast])

  const markChatSaved = useCallback((message: ChatMessage, proposalId: string) => {
    setChat((messages) => messages.map((value) => value.id === message.id ? { ...value, savedAs: proposalId } : value))
  }, [])
  const requestChallenge = useCallback((intent: string, previousRounds: ChallengeRound[]) =>
    actions.challenge({ projectId: initialWorkspace.projectId, intent, previousRounds }), [actions, initialWorkspace.projectId])

  return {
    chapters: initialWorkspace.chapters,
    knowledge: initialWorkspace.knowledge,
    projectId: initialWorkspace.projectId,
    projectTitle: initialWorkspace.projectTitle ?? 'Writer Agent',
    adapterMode: adapter.mode,
    doc, markdownByChapter, chapterVersions, proposals, decisions, layout, setLayout, chat, challenge, setChallenge, seq,
    current, dark, setDark, task, saveState: saveStates[current] ?? { s: 'saved', at: Date.now() },
    chapterLoadState: chapterLoadStates[current] ?? { status: 'idle' as const },
    editorGeneration,
    recoveryDraft: recoveryDrafts[current],
    restoreLocalDraft, reloadServerVersion, retryLoadChapter, exportLocalDraft,
    updateResume, restoreHistoricalText, flushSave, prepareReview, prepareStructure, retrySave, onChange, switchChapter, runReview, cancelReview, decide,
    createProposal, sendChat, markChatSaved, requestChallenge,
  }
}
