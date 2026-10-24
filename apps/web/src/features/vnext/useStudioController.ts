import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthorNote, WorkspaceSnapshot } from '@writer-agent/contracts'
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
import type { Chapter as ViewChapter, Source, CanonCandidateContext } from './model'

export function useStudioController(
  adapter: WriterAgentAdapter,
  initialWorkspace: WorkspaceSnapshot,
) {
  const [view, setView] = useState<'write' | 'book' | 'think'>('write')
  const [leftTab, setLeftTab] = useState<'toc' | 'related'>('toc')
  const [rightTab, setRightTab] = useState<'margin' | 'think'>('margin')
  const [bookNav, setBookNav] = useState<BookNav>({ section: 'chapter' })
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
  const workspace = useWorkspaceController({
    adapter,
    initialWorkspace,
    toast,
    requestConfirm: setConfirm,
  })
  const { current, doc, layout, setLayout, dark, setDark, saveState } = workspace
  const bridge = useManuscriptBridge(current)
  const { editor, onReady: ready } = bridge
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
  const thinking = useThinking(initialWorkspace.projectId, adapter.mode === 'api' && (view === 'think' || (view === 'write' && layout.rightOpen && rightTab === 'think')))
  const notesEnabled = initialWorkspace.capabilities?.notes === true && !!adapter.notes
  const notes = useNotes(adapter.notes, initialWorkspace.projectId, notesEnabled)
  const reviews = useReviewController({ adapter, workspace, available: initialWorkspace.capabilities?.evidenceReview === true,
    paneOpen: view === 'write' && layout.rightOpen && rightTab === 'margin', toast })
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
  const openThink = (seed = '') => {
    setThinkingSeed(seed)
    setRightTab('think')
    setLayout((l) => ({ ...l, rightOpen: true, focus: false }))
  }
  const switchChapter = (id: string) => {
    workspace.switchChapter(id)
    setResume(false)
    setView('write')
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
