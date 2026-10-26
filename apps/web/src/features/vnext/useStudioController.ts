import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { studioEntry, rememberResume, readResume } from '../../services/workspaceResume'
import type { AuthorNote, WorkspaceSnapshot, WorkspaceResume } from '@writer-agent/contracts'
import type { WriterAgentAdapter } from '../../services/writerAgent'
import {
  useWorkspaceController,
  type WorkspaceConfirmAction,
} from '../workspace/useWorkspaceController'
import { useThinking } from '../thinking/useThinking'
import { useReviewController } from '../reviews/useReviewController'
import { reviewAnchorRanges } from '../../lib/reviewAnchor'
import { useNotes } from '../notes/useNotes'
import { usePrototype } from './usePrototype'
import { useManuscriptBridge } from '../../hooks/useManuscriptBridge'
import { findUnsupportedMarkdown } from '../../lib/manuscriptMarkdown'
import type { Annotation, Flash } from '../../components/ManuscriptEditor'
import type { BookNav } from '../../components/vnext/BookView'
import type { Chapter as ViewChapter, Source, CanonCandidateContext, StudioView } from './model'

const legacyViews: Record<string, StudioView> = { write: 'read', think: 'inspire' }
/** Reads ?view=, mapping pre-V3 values; the inspiration space is the default. */
export function readView(search = window.location.search): StudioView {
  const raw = new URLSearchParams(search).get('view') ?? ''
  const value = legacyViews[raw] ?? raw
  return value === 'read' || value === 'book' || value === 'inspire' ? value : 'inspire'
}
export function readCompose(search = window.location.search) {
  const params = new URLSearchParams(search)
  return params.get('compose') === '1' && readView(search) === 'read'
}
function writeLocation(view: StudioView, compose: boolean, book: string, chapter: string) {
  const url = new URL(window.location.href)
  const before = url.search
  url.searchParams.set('view', view)
  url.searchParams.set('book', book)
  if (chapter) url.searchParams.set('chapter', chapter)
  if (compose) url.searchParams.set('compose', '1')
  else url.searchParams.delete('compose')
  if (url.search !== before) window.history.pushState(window.history.state, '', url)
}

export function useStudioController(
  adapter: WriterAgentAdapter,
  initialWorkspace: WorkspaceSnapshot,
) {
  // The space lives in the URL so reload and browser back/forward keep it.
  // Compose intent survives switching to 灵感/书 and back within this tab.
  const [entry] = useState(() => studioEntry(initialWorkspace, window.location.search))
  const [view, setViewState] = useState<StudioView>(entry.view)
  const [intent, setIntent] = useState(entry.compose)
  const chapterRef = useRef(entry.chapterId)
  const intentRef = useRef(intent)
  const compose = view === 'read' && intent
  const rememberIntent = useCallback((next: boolean) => {
    intentRef.current = next
    setIntent(next)
  }, [])
  const setView = useCallback((next: StudioView) => {
    setViewState(next)
    writeLocation(next, next === 'read' && intentRef.current, initialWorkspace.projectId, chapterRef.current)
  }, [initialWorkspace.projectId])
  const setCompose = useCallback((next: boolean) => {
    rememberIntent(next)
    setViewState('read')
    writeLocation('read', next, initialWorkspace.projectId, chapterRef.current)
  }, [rememberIntent, initialWorkspace.projectId])
  useEffect(() => {
    const sync = () => {
      const next = readView()
      setViewState(next)
      if (next === 'read') rememberIntent(readCompose())
    }
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [rememberIntent])
  const [leftTab, setLeftTab] = useState<'toc' | 'related'>('toc')
  const [rightTab, setRightTab] = useState<'margin' | 'think' | 'context' | 'review'>('margin')
  const [bookNav, setBookNav] = useState<BookNav>({ section: 'people' })
  const [resume, setResume] = useState(true)
  const [quick, setQuick] = useState(false)
  const [selection, setSelection] = useState('')
  const [marksHidden, setMarksHidden] = useState(false)
  const [activeMargin, setActiveMargin] = useState<string | null>(null)
  const [candidateNote, setCandidateNote] = useState<AuthorNote | null>(null)
  const [candidateContext, setCandidateContext] = useState<CanonCandidateContext | null>(null)
  const [saveDialog, setSaveDialog] = useState(false)
  const [conflictId, setConflictId] = useState<string | null>(null)
  const [flash, setFlash] = useState<Flash>(null)
  const [reviewFlash, setReviewFlash] = useState<(NonNullable<Flash> & { runId: string }) | null>(null)
  const locationRequest = useRef(0)
  const [backTo, setBackTo] = useState<{ chapterId: string; scroll: number } | null>(null)
  const [confirm, setConfirm] = useState<WorkspaceConfirmAction | null>(null)
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([])
  const [typing, setTyping] = useState(false)
  const [width, setWidth] = useState(window.innerWidth)
  const scroll = useRef<HTMLDivElement>(null)
  const toast = useCallback((text: string) => {
    const id = crypto.randomUUID()
    setToasts((all) => [...all, { id, text }])
    window.setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 4000)
  }, [])
  const resumeWorkspace = useMemo(() => ({ ...initialWorkspace, currentChapterId: entry.chapterId }), [initialWorkspace, entry.chapterId])
  const workspace = useWorkspaceController({
    adapter,
    initialWorkspace: resumeWorkspace,
    toast,
    requestConfirm: setConfirm,
  })
  const { current, doc, layout, setLayout, dark, setDark, saveState } = workspace
  useEffect(() => {
    const syncChapter = () => {
      const params = new URLSearchParams(window.location.search)
      if (!params.has('book') || params.get('book') === initialWorkspace.projectId) {
        const chapter = params.get('chapter')
        if (chapter) workspace.switchChapter(chapter)
      }
    }
    window.addEventListener('popstate', syncChapter)
    return () => window.removeEventListener('popstate', syncChapter)
  }, [workspace.switchChapter, initialWorkspace.projectId])
  const bridge = useManuscriptBridge(current)
  const { editor } = bridge
  const versionsRef = useRef(workspace.chapterVersions)
  versionsRef.current = workspace.chapterVersions
  chapterRef.current = current
  const navigationRef = useRef({ view, intent })
  navigationRef.current = { view, intent }
  const restored = useRef(new WeakSet<Editor>())
  const ready = useCallback((next: Editor | null) => {
    bridge.onReady(next)
    if (!next) return
    const saved = readResume(initialWorkspace.projectId) ?? initialWorkspace.preferences?.resume
    const chapterId = current
    const sameVersion = saved?.chapterId === chapterId && saved.revisionId === (versionsRef.current[chapterId]?.mode === 'api' ? versionsRef.current[chapterId].revisionId : undefined)
    requestAnimationFrame(() => {
      if (editor.current !== next || next.isDestroyed || restored.current.has(next)) return
      restored.current.add(next)
      if (sameVersion && saved) {
        const end = next.state.doc.content.size
        next.commands.setTextSelection({ from: Math.max(1, Math.min(saved.from, end)), to: Math.max(1, Math.min(saved.to, end)) })
        if (scroll.current) scroll.current.scrollTop = saved.scroll
      }
      if (navigationRef.current.view === 'read' && navigationRef.current.intent && !document.activeElement?.matches('input,textarea,select')) next.view.focus()
    })
  }, [bridge.onReady, current, editor, initialWorkspace.projectId, initialWorkspace.preferences?.resume])
  const choseDefault = useRef(false)
  useEffect(() => {
    if (!entry.automatic || choseDefault.current || workspace.chapterLoadState.status !== 'loaded') return
    choseDefault.current = true
    if ((workspace.markdownByChapter[current] ?? '').trim()) { setViewState('read'); rememberIntent(true) }
  }, [entry.automatic, current, workspace.chapterLoadState.status, workspace.markdownByChapter, rememberIntent])
  const updateResume = workspace.updateResume
  const loaded = workspace.chapterLoadState.status === 'loaded' && !workspace.recoveryDraft
  useEffect(() => {
    if (!current || !loaded) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const persist = (server = true) => {
      const mounted = editor.current
      const version = versionsRef.current[current]
      const metadata: WorkspaceResume = {
        schema: 1, chapterId: current, view, compose: intent,
        scroll: Math.max(0, Math.round(scroll.current?.scrollTop ?? 0)),
        from: mounted && !mounted.isDestroyed ? mounted.state.selection.from : 0,
        to: mounted && !mounted.isDestroyed ? mounted.state.selection.to : 0,
        ...(version?.mode === 'api' ? { revisionId: version.revisionId } : {}), updatedAt: new Date().toISOString(),
      }
      rememberResume(initialWorkspace.projectId, metadata)
      if (server) updateResume(metadata)
    }
    const queue = () => { clearTimeout(timer); timer = setTimeout(() => persist(), 500) }
    const leaving = () => persist(false)
    const container = scroll.current
    const mounted = editor.current
    container?.addEventListener('scroll', queue, { passive: true })
    mounted?.on('selectionUpdate', queue)
    window.addEventListener('pagehide', leaving)
    queue()
    return () => {
      clearTimeout(timer)
      persist()
      container?.removeEventListener('scroll', queue)
      mounted?.off('selectionUpdate', queue)
      window.removeEventListener('pagehide', leaving)
    }
  }, [current, loaded, view, intent, editor, initialWorkspace.projectId, updateResume])
  const { chapters } = initialWorkspace
  const chapter = chapters.find((c) => c.id === current) ?? {
    id: '',
    title: '',
    volume: '',
    meta: '',
  }
  const viewChapters: ViewChapter[] = useMemo(
    () =>
      chapters.map((c, i) => ({
        id: c.id,
        title: c.title.replace(/^第\s*\d+\s*章\s*/, '') || c.title,
        volume: c.volume,
        setting: c.meta,
        no: Number(c.title.match(/^第\s*(\d+)\s*章/)?.[1] ?? i + 1),
        words: c.wordCount ?? 0,
      })),
    [chapters],
  )
  const currentViewChapter = viewChapters.find((c) => c.id === current)
  const prototype = usePrototype(adapter.mode === 'demo', currentViewChapter, doc)
  const thinking = useThinking(initialWorkspace.projectId, adapter.mode === 'api' && (view === 'inspire' || (view === 'read' && layout.rightOpen && rightTab === 'think')))
  const [typewriter, setTypewriter] = useState(() => {
    try { return localStorage.getItem('writer-agent:typewriter') === '1' } catch { return false }
  })
  const toggleTypewriter = () => setTypewriter((on) => {
    try { localStorage.setItem('writer-agent:typewriter', on ? '0' : '1') } catch { /* optional preference */ }
    return !on
  })
  /** Opens a right-drawer tab (本章设定 / 注记 / 审查). */
  const openRight = (tab: 'margin' | 'think' | 'context' | 'review') => {
    setRightTab(tab === 'review' ? 'margin' : tab)
    setLayout((l) => ({ ...l, rightOpen: true, focus: false, leftOpen: window.innerWidth < 1280 ? false : l.leftOpen }))
  }
  // Words written since entering 写作 for this chapter.
  const composeStart = useRef<{ chapter: string; words: number } | null>(null)
  if (!compose) composeStart.current = null
  else if (bridge.words !== null && composeStart.current?.chapter !== current) composeStart.current = { chapter: current, words: bridge.words }
  const composeDelta = compose && composeStart.current && bridge.words !== null ? bridge.words - composeStart.current.words : 0
  // 写作 is the same editor made editable; leaving flushes the save queue first.
  const enterCompose = () => {
    setCompose(true)
    // Focus is a per-session choice made inside 写作 (as in the design), never restored on entry.
    setLayout((l) => (l.focus ? { ...l, focus: false } : l))
    setResume(false)
    setSelection('')
    window.setTimeout(() => { const current = editor.current; if (current && !current.isDestroyed) current.commands.focus() }, 60)
  }
  const leaveCompose = () => {
    void workspace.flushSave().finally(() => {
      setCompose(false)
      setLayout((l) => (l.focus ? { ...l, focus: false } : l))
    })
  }
  const notesEnabled = initialWorkspace.capabilities?.notes === true && !!adapter.notes
  const notes = useNotes(adapter.notes, initialWorkspace.projectId, notesEnabled)
  const reviews = useReviewController({ adapter, workspace, available: initialWorkspace.capabilities?.evidenceReview === true,
    paneOpen: view === 'read' && layout.rightOpen && rightTab === 'margin', toast })
  const locateReview = async (id: string) => {
    const request = ++locationRequest.current
    const value = await reviews.revalidate(id)
    if (!value || request !== locationRequest.current) return
    const finding = value.findings.find((item) => item.findingId === id)
    const target = value.sources.find((item) => item.kind === 'target')
    const mounted = editor.current
    if (!finding || !target || !mounted || mounted.isDestroyed || finding.anchor.status !== 'unique'
      || reviewAnchorRanges(mounted.state.doc, target.excerpt, finding.anchor).length === 0) {
      toast('此引用暂不能精确定位。可以查看只读证据快照。'); return
    }
    setReviewFlash({ paraIndex: 0, quote: finding.anchor.quote, nonce: Date.now(), reviewAnchor: finding.anchor,
      reviewMarkdown: target.excerpt, runId: value.runId })
    reviews.setActiveId(id)
    setRightTab('margin'); setLayout((prior) => ({ ...prior, rightOpen: true, focus: false }))
  }
  const selectReview = (id: string | null) => {
    reviews.setActiveId(id)
    if (!id) { locationRequest.current++; setReviewFlash(null); return }
    if (reviews.finding(id)?.anchor.status === 'unique' && !reviews.stale) void locateReview(id)
  }
  const reviewTarget = reviews.run?.sources.find((source) => source.kind === 'target')
  const reviewAnnotations: Annotation[] = !marksHidden && !reviews.stale && reviews.run?.status === 'completed'
    ? reviews.run.findings.filter((finding) => finding.feedback?.choice !== 'ignored' && finding.anchor.status === 'unique').map((finding) => ({
      id: finding.findingId, kind: 'suggestion', paraIndex: 0, quote: finding.anchor.quote,
      active: finding.findingId === reviews.activeId, reviewAnchor: finding.anchor, reviewMarkdown: reviewTarget?.excerpt,
    })) : []
  const nextUp = notes.items.find((n) => n.status === 'active' && n.purpose === 'next_writing')
  const conflict = prototype.conflicts.find((c) => c.id === conflictId)
  const [thinkingSeed, setThinkingSeed] = useState('')
  /** Jump target inside 灵感 (from 书 or a proposal's 回到对话). */
  const [ideaFocus, setIdeaFocus] = useState<{ sessionId: string; messageId?: string; nonce: number } | null>(null)
  const [composer, setComposer] = useState<{
    draft: string
    mode: 'idle' | 'correct' | 'conclude'
  }>({ draft: '', mode: 'idle' })
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const openNotes = () => {
    setView('book')
    setBookNav({ section: 'notes' })
  }
  // V3: every 思考 entry goes to 灵感; a quote travels with it. Demo keeps the drawer prototype.
  const openThink = (seed = '') => {
    setThinkingSeed(seed)
    if (adapter.mode === 'api') {
      setView('inspire')
      return
    }
    setRightTab('think')
    setLayout((l) => ({ ...l, rightOpen: true, focus: false }))
  }
  const switchChapter = (id: string) => {
    workspace.switchChapter(id)
    chapterRef.current = id
    setResume(false)
    setView('read')
    setSelection('')
    if (width < 1024) setLayout((l) => ({ ...l, leftOpen: false }))
  }
  const openSource = (source: Source) => {
    if (!source.chapterId || source.state !== 'ok') {
      toast('来源未核验或已过期，无法定位。')
      return
    }
    const matches = (doc[source.chapterId] ?? []).flatMap((p, i) =>
      source.quote && p.split(source.quote).length === 2 ? [i] : [],
    )
    const quoteCount = (doc[source.chapterId] ?? []).reduce(
      (n, p) => n + (source.quote ? p.split(source.quote).length - 1 : 0),
      0,
    )
    if (matches.length !== 1 || quoteCount !== 1) {
      toast('引用不存在或匹配多处，未跳转。')
      return
    }
    setBackTo((prev) => prev ?? { chapterId: current, scroll: scroll.current?.scrollTop ?? 0 })
    switchChapter(source.chapterId)
    setConflictId(null)
    setFlash({ paraIndex: matches[0], quote: source.quote, nonce: Date.now() })
  }
  const downloadLocalDraft = () => {
    const text = workspace.exportLocalDraft()
    if (text === null) return
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${current || 'chapter'}-local-draft.md`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const annotations: Annotation[] = prototype.margins
    .filter((m) => !marksHidden && !prototype.ignored.includes(m.id) && m.state !== 'stale')
    .map((m) => ({
      id: m.id,
      kind: m.tone === 'conflict' ? 'fact' : m.tone === 'ai' ? 'suggestion' : 'research',
      paraIndex: m.para,
      quote: m.quote,
      active: m.id === activeMargin,
    }))
  const selectMargin = (id: string | null) => {
    setActiveMargin(id)
    setRightTab('margin')
    setLayout((l) => ({ ...l, rightOpen: true, focus: false }))
  }
  const saveNote = async (content: string) =>
    (
      await notes.save(
        { content, chapterId: current || null, purpose: 'note' },
        crypto.randomUUID(),
      )
    ).noteId
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (quick) return // QuickNote owns its save-in-flight boundary.
        if (confirm) setConfirm(null)
        else if (layout.rightOpen) setLayout((l) => ({ ...l, rightOpen: false }))
        else if (layout.leftOpen) setLayout((l) => ({ ...l, leftOpen: false }))
        else if (layout.focus) setLayout((l) => ({ ...l, focus: false }))
      }
      if (!event.metaKey && !event.ctrlKey) return
      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        void workspace.flushSave().then((saved) => {
          if (saved) toast('已保存')
        })
      } else if (event.key === ';' && notesEnabled) {
        event.preventDefault()
        setQuick(true)
      } else if (event.key === '\\') {
        event.preventDefault()
        setLayout((l) => ({ ...l, rightOpen: !l.rightOpen, focus: false }))
      } else if (event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        setLayout((l) => ({ ...l, leftOpen: !l.leftOpen, focus: false }))
      } else if (!event.shiftKey && event.key.toLowerCase() === 'e' && view === 'read' && chapter.id) {
        event.preventDefault()
        if (compose) leaveCompose()
        else if (!readonly) enterCompose()
      } else if (event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setLayout((l) => ({ ...l, focus: !l.focus }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const readonly = findUnsupportedMarkdown(workspace.markdownByChapter[current] ?? '').length > 0
  const failedLoad = workspace.chapterLoadState.status === 'error'
  const pinned = readonly || failedLoad || saveState.s === 'error' || saveState.s === 'recovery'
  const status = readonly
    ? '只读保护'
    : failedLoad
      ? '章节读取失败'
      : workspace.chapterLoadState.status === 'loading'
        ? '正在打开章节…'
        : saveState.s === 'saved'
          ? `已保存 ${new Date(saveState.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
          : saveState.s === 'saving'
            ? '保存中…'
            : saveState.s === 'dirty'
              ? '有未保存修改'
              : saveState.s === 'recovery'
                ? '有待恢复草稿'
                : saveState.conflict
                  ? '版本冲突'
                  : '保存失败'
  const liveMargins = prototype.margins.filter((m) => !prototype.ignored.includes(m.id))
  const resumePending = [
    ...liveMargins
      .filter((margin) => margin.state === 'fresh')
      .map((margin) => ({
        id: margin.id,
        text: margin.title,
        tone: margin.tone,
        run: () => selectMargin(margin.id),
      })),
    ...notes.items
      .filter(
        (note) => note.status === 'active' && note.purpose === 'note' && note.chapterId === current,
      )
      .map((note) => ({
        id: note.noteId,
        text: `你的笔记：${note.content}`,
        tone: 'quiet' as const,
        run: openNotes,
      })),
  ].slice(0, 3)
  return {
    thinking, reviews, reviewAnnotations, reviewFlash, locateReview, selectReview,
    view,
    setView,
    compose,
    setCompose,
    typewriter,
    toggleTypewriter,
    openRight,
    composeDelta,
    enterCompose,
    leaveCompose,
    leftTab,
    setLeftTab,
    rightTab,
    setRightTab,
    bookNav,
    setBookNav,
    resume,
    setResume,
    quick,
    setQuick,
    selection,
    setSelection,
    marksHidden,
    setMarksHidden,
    activeMargin,
    setActiveMargin,
    candidateNote,
    setCandidateNote,
    candidateContext,
    setCandidateContext,
    saveDialog,
    setSaveDialog,
    conflictId,
    setConflictId,
    flash,
    setFlash,
    backTo,
    setBackTo,
    confirm,
    setConfirm,
    toasts,
    setToasts,
    typing,
    setTyping,
    width,
    scroll,
    workspace,
    current,
    doc,
    layout,
    setLayout,
    dark,
    setDark,
    saveState,
    bridge,
    editor,
    ready,
    chapters,
    chapter,
    viewChapters,
    currentViewChapter,
    prototype,
    notesEnabled,
    notes,
    nextUp,
    conflict,
    thinkingSeed,
    setThinkingSeed,
    ideaFocus,
    setIdeaFocus,
    composer,
    setComposer,
    openNotes,
    openThink,
    switchChapter,
    openSource,
    downloadLocalDraft,
    annotations,
    selectMargin,
    saveNote,
    pinned,
    status,
    liveMargins,
    resumePending,
    readonly,
    toast,
  }
}
