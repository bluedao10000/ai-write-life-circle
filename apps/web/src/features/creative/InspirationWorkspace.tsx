// 「灵感」会话工作台 — layout, type and interaction from Figma Make
// (Writer Agent UI_UX Design/src/components/idea/Inspiration.tsx): collapsible
// history · a centred conversation (max 760px) · the composer at the bottom.
// Organized settings appear only as a light entry under each reply and in the
// 本次整理 drawer. Every value comes from the real Thinking and Creative APIs:
// sessions, messages, models, scopes and proposals are server state; nothing is
// simulated and no success is shown before the server confirms it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { CreativeProposal, CreativeTurn, StoryChangeReceipt, StoryContext, ThinkingMessage, ThinkingSource } from '@writer-agent/contracts'
import { Btn, Dialog, Heading, Icon, IconBtn, Row, Seg, type IconName } from '../../components/vnext/ui'
import { creativeApi } from '../../services/api/creativeApi'
import { analysisApi } from '../../services/api/analysisApi'
import BookMenu from '../management/BookMenu'
import { useManagement } from '../management/ManagedStudio'
import type { useStudioController } from '../vnext/useStudioController'
import CreativeConsent from './CreativeConsent'
import { creativeError } from './labels'
import { useCreativeOverview } from './useCreativeOverview'
import { STORY_STARTERS, StoryDrawer, StoryReceipt, StoryRecordingStatus } from './StoryContinuity'
import { AssetDrawer } from './AssetLibrary'
import { AutonomyControl, Composer, ComposerQuote, ModelPicker, Notice } from '../inspiration/Composer'
import History from '../inspiration/History'
import { AiMsg, AuthorMsg, Failure, Pending } from '../inspiration/Messages'
import { ProposalDrawer, ReviewDrawer, TurnOrganize } from '../inspiration/Organize'
import ScopeDialog, { scopeSummary } from '../inspiration/ScopeDialog'
import { reducedMotion, useKeyboard, useMedia, useSafeArea } from '../inspiration/media'

type Studio = ReturnType<typeof useStudioController>
const POLL_MS = 3000
const SIDE = 'story2u.idea.side'
const STORY = (book: string) => `story2u.idea.story.${book}`
const activeTurn = (t: CreativeTurn) => t.status === 'awaiting' || t.status === 'queued'
const unfinished = (m: ThinkingMessage) => m.role === 'assistant' && (m.status === 'accepted' || m.status === 'running')
const questionOf = (answerId: string) => answerId.replace(/-answer(-\d+)?$/, '')

/** Starters only fill the composer; the author edits before sending (Figma SUGGEST). */
const SUGGEST: { icon: IconName; label: string; fill: string }[] = [
  { icon: 'users', label: '探索一个人物的内心', fill: '有个角色我还没完全想透：' },
  { icon: 'globe', label: '讨论世界观中的矛盾', fill: '这个故事发生的地方有个规矩：' },
  { icon: 'flag', label: '梳理故事的核心冲突', fill: '有一场对手戏卡住了：' },
  { icon: 'book', label: '从历史与哲学寻找灵感', fill: '最近读到一段历史，想借来用：' },
]

export default function InspirationWorkspace({ studio }: { studio: Studio }) {
  const t = studio.thinking
  const book = studio.workspace.projectId
  const chapterTitles = useMemo(() => new Map(studio.chapters.map((chapter) => [chapter.id, chapter.title])), [studio.chapters])
  const management = useManagement()
  const wide = useMedia('(min-width: 768px)')
  const dockable = useMedia('(min-width: 1280px)')
  const kb = useKeyboard(!wide)
  useSafeArea(!wide)
  const { overview, refresh: refreshOverview } = useCreativeOverview(book, true)
  const settings = overview?.settings
  const organizingEnabled = !!settings?.enabled
  const [side, setSideRaw] = useState(() => {
    try {
      return localStorage.getItem(SIDE) !== '0'
    } catch {
      return true
    }
  })
  const [nav, setNav] = useState(false)
  const [menu, setMenu] = useState(false)
  const [review, setReview] = useState(false)
  const [storyOpen, setStoryOpenRaw] = useState(() => { try { return dockable && localStorage.getItem(STORY(book)) === '1' } catch { return false } })
  const [storyAsset, setStoryAsset] = useState<{ book: string; id: string } | null>(null)
  const [story, setStory] = useState<{ book: string; sessionId?: string; context: StoryContext | null; receipts: StoryChangeReceipt[]; receiptsRead: boolean; error: string } | null>(null)
  const [recordingBusy, setRecordingBusy] = useState<string | null>(null)
  const [recordingError, setRecordingError] = useState<{ book: string; message: string } | null>(null)
  const currentBook = useRef(book)
  currentBook.current = book
  const [access, setAccess] = useState(false)
  const [organizeConsent, setOrganizeConsent] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [include, setInclude] = useState(true)
  const [autonomyEnabled, setAutonomyEnabled] = useState(false)
  const [completionCriteria, setCompletionCriteria] = useState('')
  const [autonomySteps, setAutonomySteps] = useState(1)
  const [localError, setLocalError] = useState('')
  const [failureDetails, setFailureDetails] = useState(false)
  const [turns, setTurns] = useState<CreativeTurn[]>([])
  const [mine, setMine] = useState<CreativeProposal[]>([])
  const [allPending, setAllPending] = useState<CreativeProposal[]>([])
  const [tick, setTick] = useState(0)
  const [lit, setLit] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<CreativeProposal | null>(null)
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const seen = useRef<{ id: string | null; count: number; first?: string; last?: string; height: number }>({ id: null, count: 0, height: 0 })
  /** Scroll position captured just before older messages are requested. */
  const anchor = useRef<{ top: number; height: number } | null>(null)
  const sentAt = useRef<{ text: string; questions: number } | null>(null)
  const pin = useRef<string | null>(null)
  const session = t.session?.bookId === book ? t.session : null
  const sessionId = session?.sessionId ?? t.selected ?? undefined
  const running = session?.status === 'running'
  const seed = studio.thinkingSeed
  const messages = useMemo(() => session?.messages ?? [], [session?.messages])
  // The question being delivered stays visible, marked 正在发送, until the server
  // snapshot contains it as the latest author message.
  const questions = messages.filter((m) => m.role === 'user').length
  if (!t.outgoing) sentAt.current = null
  else if (sentAt.current?.text !== t.outgoing) sentAt.current = { text: t.outgoing, questions }
  const outgoing = t.outgoing && sentAt.current && questions <= sentAt.current.questions ? t.outgoing : ''
  const landing = !t.selected && !outgoing
  const loading = !!t.selected && !session
  const sending = !!t.outgoing
  const autonomyModel = session?.model ?? t.model
  const autonomyCeiling = Math.max(1, Math.min(8, autonomyModel?.limits?.maxToolCalls ?? 1, (autonomyModel?.limits?.maxTurnsPerRequest ?? 4) - 3))
  const autonomyAvailable = t.scopes.length > 0 && autonomyModel?.toolCalling !== false && (autonomyModel?.limits?.maxToolCalls ?? 1) >= 1 && (autonomyModel?.limits?.maxTurnsPerRequest ?? 4) >= 4
  const effectiveAutonomySteps = Math.min(autonomySteps, autonomyCeiling)
  const title = session?.title ?? t.sessions.find((s) => s.sessionId === t.selected)?.title ?? '新的讨论'
  const storyState = story?.book === book && story.sessionId === sessionId ? story : null
  const storyContext = storyState?.context
  const blankStory = storyContext && !storyState?.error && !storyContext.truncated && ![storyContext.intent, storyContext.confirmed, storyContext.alternatives, storyContext.rejected, storyContext.questions].some((items) => items.length)
  const suggestions = blankStory ? STORY_STARTERS : SUGGEST
  const recording = (story?.book === book ? story.context?.dialogueRecording : undefined) ?? settings?.dialogueRecording ?? false
  const storyLoadError = storyState?.error ? (storyState.context || storyState.receipts.length ? '故事记录暂时无法更新，当前显示上次读取的内容。' : '暂时无法读取故事记录，仍可继续对话。') : ''
  const setStoryOpen = (value: boolean) => {
    setStoryOpenRaw(value)
    if (dockable) try { localStorage.setItem(STORY(book), value ? '1' : '0') } catch { /* optional preference */ }
  }
  useEffect(() => {
    try { setStoryOpenRaw(dockable && localStorage.getItem(STORY(book)) === '1') } catch { setStoryOpenRaw(false) }
    setStoryAsset(null)
  }, [book, dockable])

  const setSide = (v: boolean) => {
    setSideRaw(v)
    try {
      localStorage.setItem(SIDE, v ? '1' : '0')
    } catch {
      /* optional */
    }
  }
  const focusInput = (end?: number) =>
    requestAnimationFrame(() => {
      const el = input.current
      if (!el) return
      el.focus()
      if (end !== undefined) el.setSelectionRange(end, end)
    })

  // One refresh loop for saved story state and organizing, including failed replies.
  useEffect(() => {
    const abort = new AbortController()
    let timer: number | undefined
    const load = async () => {
      const [context, receipts, pending, list, own] = await Promise.allSettled([
        creativeApi.storyContext(book, sessionId, abort.signal),
        sessionId ? creativeApi.changes(book, sessionId, abort.signal) : Promise.resolve({ items: [] as StoryChangeReceipt[] }),
        organizingEnabled ? creativeApi.proposals(book, { status: 'proposed', limit: 100 }, abort.signal) : Promise.resolve({ items: [] as CreativeProposal[] }),
        organizingEnabled && sessionId ? creativeApi.turns(book, sessionId, abort.signal) : Promise.resolve({ items: [] as CreativeTurn[] }),
        organizingEnabled && sessionId ? creativeApi.proposals(book, { sessionId, limit: 100 }, abort.signal) : Promise.resolve({ items: [] as CreativeProposal[] }),
      ])
      if (abort.signal.aborted) return
      setStory((previous) => {
        const same = previous?.book === book && previous.sessionId === sessionId ? previous : null
        return {
          book, sessionId,
          context: context.status === 'fulfilled' ? context.value : same?.context ?? null,
          receipts: receipts.status === 'fulfilled' ? receipts.value.items : same?.receipts ?? [],
          receiptsRead: receipts.status === 'fulfilled',
          error: context.status === 'rejected' ? creativeError(context.reason) : receipts.status === 'rejected' ? creativeError(receipts.reason) : '',
        }
      })
      if (pending.status === 'fulfilled') setAllPending(pending.value.items)
      if (list.status === 'fulfilled') setTurns(list.value.items)
      if (own.status === 'fulfilled') setMine(own.value.items)
      const failure = [pending, list, own].find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') setLocalError(creativeError(failure.reason))
      if ((running || (list.status === 'fulfilled' && list.value.items.some(activeTurn))) && document.visibilityState === 'visible') {
        timer = window.setTimeout(() => void load(), POLL_MS)
      }
    }
    void load()
    return () => {
      abort.abort()
      window.clearTimeout(timer)
    }
  }, [book, sessionId, organizingEnabled, running, messages.length, tick])
  const reloadCreative = useCallback(() => {
    setTick((n) => n + 1)
    refreshOverview()
  }, [refreshOverview])

  const setRecording = async (value: boolean) => {
    if (recordingBusy === book) return
    setRecordingBusy(book)
    setRecordingError(null)
    try {
      if (value && !t.scopes.includes('creative')) {
        const saved = await t.saveScopes([...t.scopes, 'creative'])
        if (!saved) throw new Error('作品设定的读取范围尚未保存，请重试。')
      }
      if (currentBook.current !== book) return
      const result = await creativeApi.settings(book, 'recording', { dialogueRecording: value })
      if (currentBook.current !== book) return
      setStory((previous) => previous?.book === book && previous.context ? { ...previous, context: { ...previous.context, dialogueRecording: result.dialogueRecording }, error: '' } : previous)
      reloadCreative()
    } catch (e) {
      if (currentBook.current === book) setRecordingError({ book, message: creativeError(e) })
    } finally {
      setRecordingBusy((pending) => pending === book ? null : pending)
    }
  }

  const onReceiptChanged = (receipt: StoryChangeReceipt) => {
    if (currentBook.current !== book) return
    setStory((previous) => previous?.book === book && previous.sessionId === receipt.sessionId ? { ...previous, receipts: previous.receipts.map((item) => item.changeId === receipt.changeId ? receipt : item) } : previous)
    reloadCreative()
  }

  // Scroll intent (Figma): opening a conversation jumps to the end; a sent question
  // scrolls to the end; when a reply starts, its question settles at the top so the
  // answer reads from the beginning.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const id = t.selected
    const count = messages.length
    const before = seen.current
    seen.current = { id, count, first: messages[0]?.id, last: messages[count - 1]?.id, height: el.scrollHeight }
    // 加载更早的讨论 inserts above: keep the reader exactly where they were.
    const older = before.id === id && count > before.count && messages[0]?.id !== before.first && messages[count - 1]?.id === before.last
    if (older) {
      const a = anchor.current ?? { top: el.scrollTop, height: before.height }
      anchor.current = null
      el.scrollTop = a.top + el.scrollHeight - a.height
      seen.current.height = el.scrollHeight
      return
    }
    if (lit) {
      document.getElementById(`msg-${lit}`)?.scrollIntoView({ block: 'center' })
      return
    }
    const behavior = reducedMotion() ? 'auto' : 'smooth'
    if (before.id !== id || (before.count === 0 && count > 0 && !sending)) {
      pin.current = null
      el.scrollTo({ top: el.scrollHeight })
      return
    }
    if (count > before.count) {
      const last = messages[count - 1]
      setFresh(last?.id ?? null)
      if (last?.role === 'assistant') {
        const question = messages[count - 2]
        pin.current = question?.id ?? null
        if (question) document.getElementById(`msg-${question.id}`)?.scrollIntoView({ block: 'start', behavior })
      } else el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }
    // While the reply streams in, keep moving its question toward the top until it
    // gets there; never scroll up, and stop as soon as the author scrolls.
    const question = pin.current && document.getElementById(`msg-${pin.current}`)
    if (question) {
      const target = el.scrollTop + question.getBoundingClientRect().top - el.getBoundingClientRect().top - 24
      if (el.scrollTop < target) el.scrollTop = Math.min(target, el.scrollHeight - el.clientHeight)
    }
  }, [t.selected, messages, lit, sending])
  useEffect(() => {
    if (!outgoing) return
    const el = scroller.current
    el?.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [outgoing])
  useEffect(() => {
    if (!lit) return
    const timer = window.setTimeout(() => setLit(null), 2600)
    return () => window.clearTimeout(timer)
  }, [lit])
  useEffect(() => {
    if (!fresh) return
    const timer = window.setTimeout(() => setFresh(null), 900)
    return () => window.clearTimeout(timer)
  }, [fresh])
  // Keyboard opening: if the reader was at the latest message, stay there.
  useEffect(() => {
    const el = scroller.current
    if (kb && el && !away) el.scrollTop = el.scrollHeight
  }, [kb]) // eslint-disable-line react-hooks/exhaustive-deps
  // Desktop keeps the composer focused so the author can continue right away (Figma).
  // The textarea is locked while a request is in flight, so focus returns afterwards.
  useEffect(() => {
    if (!landing && wide && !t.busy) input.current?.focus()
  }, [landing, t.busy]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!nav && !menu) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (menu) setMenu(false)
      else setNav(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [nav, menu])
  useEffect(() => {
    if (wide) setNav(false)
  }, [wide])

  // Jump requests from 书 / proposals: open the conversation and highlight the message.
  useEffect(() => {
    const f = studio.ideaFocus
    if (!f) return
    studio.setIdeaFocus(null)
    if (f.sessionId !== t.selected) t.select(f.sessionId)
    if (f.messageId) setLit(f.messageId)
    setNav(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.ideaFocus])

  const draft = t.draft
  // While the question is in flight it is shown in the thread, not twice.
  const shown = sending && draft.trim() === t.outgoing.trim() ? '' : draft
  const canSend = !!draft.trim() && !t.busy && !running && !t.cancellationPending && !!t.model && t.modelAvailable && !loading && (!autonomyEnabled || (autonomyAvailable && !!completionCriteria.trim()))
  const send = async () => {
    setLocalError('')
    const text = draft.trim()
    if (!canSend) return
    if (seed && include) {
      if (autonomyEnabled) {
        setLocalError('只读自主执行不能同时附带选中原文。关闭其中一项后再发送。')
        return
      }
      try {
        if (!t.scopes.includes('chapters')) throw Error('附上原文需要先在「AI 资料范围」中允许读取本作品章节。也可以取消勾选，只发送问题。')
        const saved = await studio.workspace.prepareReview()
        t.send({ text, selection: { chapterId: saved.chapterId, revisionId: saved.revisionId, contentHash: saved.contentHash, quote: seed } })
        studio.setThinkingSeed('')
      } catch (e) {
        setLocalError(e instanceof Error ? e.message : '原文尚未保存，问题没有发送。')
      }
      return
    }
    const go = () => {
      t.send({
        text,
        ...(autonomyEnabled ? {
          autonomy: {
            completionCriteria: completionCriteria.trim(),
            approveReadOnlyTools: true as const,
            maxSteps: effectiveAutonomySteps,
          },
        } : {}),
      })
      setAutonomyEnabled(false)
      setCompletionCriteria('')
      studio.setThinkingSeed('')
    }
    // First message: the landing fades and the composer glides to the bottom (View Transitions, when available).
    const d = document as Document & { startViewTransition?: (cb: () => void) => unknown }
    if (landing && d.startViewTransition && !reducedMotion()) d.startViewTransition(() => flushSync(go))
    else go()
  }
  const [analysisStarting, setAnalysisStarting] = useState(false)
  const startAnalysis = async () => {
    if (analysisStarting) return
    setAnalysisStarting(true)
    setLocalError('')
    try {
      await analysisApi.create(book)
      studio.setBookNav({ section: 'analysis', source: 'manuscript' })
      studio.setView('book')
    } catch (e) {
      setLocalError(e instanceof Error && e.message ? e.message : '整书分析没能开始，请稍后再试。')
    } finally {
      setAnalysisStarting(false)
    }
  }
  const newChat = () => {
    if (t.busy) return
    t.select(null)
    studio.setThinkingSeed('')
    setNav(false)
    setMenu(false)
    setReview(false)
    if (wide) focusInput()
  }
  const pick = (id: string) => {
    if (id !== t.selected) t.select(id)
    setNav(false)
    setMenu(false)
  }
  const fill = (text: string) => {
    t.setDraft(text)
    focusInput(text.length)
  }
  const fillFromStory = (text: string) => {
    if (!dockable) setStoryOpen(false)
    setStoryAsset(null)
    fill(text)
  }
  const openStoryAsset = (id: string) => {
    if (!dockable) setStoryOpen(false)
    setStoryAsset({ book, id })
  }
  const rereadStory = () => { setTick((value) => value + 1); void t.refreshSession() }
  const ask = (answer: ThinkingMessage) => {
    const index = messages.findIndex((m) => m.id === answer.id)
    const question = messages.slice(0, index).reverse().find((m) => m.role === 'user')
    if (question) fill(question.text)
  }
  const decide = async (p: CreativeProposal, action: 'accept' | 'reject') => {
    try {
      await creativeApi.decide(book, [{ proposalId: p.proposalId, action }])
      studio.toast(action === 'accept' ? `「${p.result?.name ?? p.targetName}」已收入设定` : '已搁置，可以在「书 · 待确认」中查看记录')
      setDrawer(null)
      reloadCreative()
    } catch (e) {
      studio.toast(creativeError(e))
    }
  }
  const organizeTurn = async (messageId: string) => {
    if (!sessionId) return
    try {
      await creativeApi.organize(book, sessionId, messageId)
      reloadCreative()
    } catch (e) {
      studio.toast(creativeError(e))
    }
  }
  const toMessage = (sid: string, mid: string) => {
    setDrawer(null)
    setReview(false)
    if (sid !== t.selected) t.select(sid)
    setLit(mid)
  }
  // Reuses the studio's evidence location: exact paragraph, stale and ambiguous quotes refused.
  const openSource = (src: ThinkingSource) => studio.openEvidence(src)
  const openInbox = () => {
    setNav(false)
    setMenu(false)
    setReview(false)
    studio.setBookNav({ section: 'inbox' })
    studio.setView('book')
  }
  const release = () => {
    pin.current = null
  }
  const onScroll = () => {
    const el = scroller.current
    if (el) setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 320)
  }
  const toBottom = () => {
    const el = scroller.current
    el?.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }
  const saveNote = studio.notesEnabled
    ? async (text: string) => {
        try {
          await studio.notes.save({ content: text.slice(0, 20000), chapterId: null, purpose: 'note' }, crypto.randomUUID())
          studio.toast('已加入创作笔记，可以在「书 · 创作笔记」中查看。')
        } catch (e) {
          studio.toast(e instanceof Error ? `笔记没有保存：${e.message}` : '笔记没有保存，请稍后再试。')
          throw e
        }
      }
    : undefined

  const organized = mine.filter((p) => p.status === 'proposed')
  const pendingAll = overview?.pendingProposals ?? allPending.length
  const offline = !t.model
  const recent = messages
    .slice(-8)
    .filter((m) => m.role === 'user' || m.status === 'completed')
    .map((m) => `${m.role === 'user' ? '作者' : '讨论建议'}：${m.text}`)
    .join('\n')
    .slice(-10000)

  /* ---------- pieces ---------- */
  const quote = seed ? (
    <ComposerQuote label={`引用正文 · ${studio.chapter.title || '当前章节'}`} text={seed} onClear={() => studio.setThinkingSeed('')}>
      <label className="mt-1 flex items-center gap-1.5 text-micro text-ink-3">
        <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} className="accent-current" />
        作为已保存原文附上（先安全保存，需要章节资料范围）
      </label>
    </ComposerQuote>
  ) : undefined
  const picker = <ModelPicker models={t.models} value={t.modelChoice} onPick={t.chooseModel} disabled={t.busy || running} wide={wide} />
  const storyLabel = `当前故事 · ${recording ? '随聊记录中' : '已暂停记录'}`
  const storyEntry = wide ? <Btn size="sm" pressed={storyOpen} onClick={() => setStoryOpen(!storyOpen)} ariaLabel={storyLabel}><Icon name="target" className="h-3.5 w-3.5" />当前故事{recording ? <span className="flex items-center gap-1 text-micro text-ok"><span className="h-1.5 w-1.5 rounded-full bg-ok" />记录中</span> : <span className="h-1.5 w-1.5 rounded-full bg-ink-4" />}</Btn> : <span className="relative"><IconBtn icon="target" label={storyLabel} active={storyOpen} onClick={() => setStoryOpen(true)} className="min-h-11 min-w-11" /><span aria-hidden className={`pointer-events-none absolute top-2.5 right-2.5 h-1.5 w-1.5 rounded-full ${recording ? 'bg-ok' : 'bg-ink-4'}`} /></span>
  const composer = (
    <Composer
      value={shown}
      onChange={t.setDraft}
      onSend={() => void send()}
      onStop={t.cancel}
      running={running}
      sending={sending}
      canSend={canSend}
      quote={quote}
      inputRef={input}
      landing={landing}
      wide={wide}
      picker={picker}
      sourceAccess={
        <div className="flex flex-wrap items-center gap-1">
        <Btn size="sm" onClick={() => setAccess(true)} ariaLabel={`选择作品资料，${scopeSummary(t.scopes)}`} className="max-w-full text-ink-3 max-md:min-h-11">
          <Icon name="book" className="h-3.5 w-3.5" />
          <span className="truncate">{t.scopes.length ? scopeSummary(t.scopes) : '作品资料未开启'}</span>
          <Icon name="chevronDown" className="h-3 w-3" />
        </Btn>
        </div>
      }
      autonomy={
        <AutonomyControl
          enabled={autonomyEnabled}
          onEnabled={setAutonomyEnabled}
          criteria={completionCriteria}
          onCriteria={setCompletionCriteria}
          maxSteps={effectiveAutonomySteps}
          onMaxSteps={setAutonomySteps}
          ceiling={autonomyCeiling}
          available={autonomyAvailable}
          disabled={t.busy && !running}
        />
      }
      disabled={t.busy && !running}
    />
  )
  const error = localError || t.error
  const notices = (
    <>
      {offline && !error && <Notice icon="offline">暂时无法连接创作伙伴。你写下的问题会保留在输入框里，恢复后再发送。</Notice>}
      {t.modelNotice && <Notice icon="alert">{t.modelNotice}</Notice>}
      {storyLoadError && <Notice icon="alert" action={<Btn size="sm" className="-my-1" onClick={() => setTick((value) => value + 1)}>重新读取故事</Btn>}>{storyLoadError}</Notice>}
      {error && (
        <Notice
          icon={t.reconnecting ? 'offline' : 'alert'}
          action={
            t.requestFailure && !localError ? (
              <Btn size="sm" pressed={failureDetails} onClick={() => setFailureDetails(!failureDetails)} className="-my-1 max-md:min-h-11">
                {failureDetails ? '收起详情' : '查看详情'}
              </Btn>
            ) : undefined
          }
        >
          {error}
          {!/输入/.test(error) && ' 输入已保留，写作与保存不受影响。'}
          {failureDetails && t.requestFailure && !localError && (
            <span className="mt-1 block text-micro break-all">
              技术详情：<span className="font-mono">{t.requestFailure.code}</span>
              {t.requestFailure.traceId ? (
                <>
                  {' '}
                  · 追踪编号 <span className="font-mono">{t.requestFailure.traceId}</span>
                </>
              ) : null}
            </span>
          )}
        </Notice>
      )}
      {t.cancellationPending && <Notice icon="info">取消已记录，服务恢复后会同步停止状态。不会恢复已取消的回复。</Notice>}
      {t.pendingDelivery && !t.busy && (
        <Notice
          icon="info"
          action={
            <Btn size="sm" variant="outline" onClick={t.retryPending} className="-my-1 max-md:min-h-11">
              恢复待确认问题
            </Btn>
          }
        >
          上一条消息的送达情况尚未确认，原问题和重试记录已保留。恢复后会用同一请求重试，不会重复提交。
        </Notice>
      )}
    </>
  )
  const scopeLink = (
    <Btn variant="link" className="text-ui-sm" onClick={() => { setNav(false); setMenu(false); setAccess(true) }}>
      <Icon name="shield" className="h-3.5 w-3.5" />
      AI 资料范围 · {scopeSummary(t.scopes)}
    </Btn>
  )
  const historyFooter = (
    <div className="space-y-1.5">
      {pendingAll > 0 ? (
        <Btn variant="link" className="text-ui-sm" onClick={openInbox}>
          {pendingAll} 项整理结果待你确认
          <Icon name="chevron" className="h-3 w-3" />
        </Btn>
      ) : (
        <span className="block text-ui-sm text-ink-3">整理结果都已处理</span>
      )}
      <div>{scopeLink}</div>
    </div>
  )
  const mainNav = <Seg label="主导航" value={studio.view} onChange={studio.setView} options={[['inspire', '灵感'], ['read', '阅读'], ['book', '书']]} />
  const history = (mobile: boolean) => (
    <History
      sessions={t.sessions}
      active={t.selected}
      locked={t.busy}
      onPick={pick}
      onNew={newChat}
      footer={historyFooter}
      aside={mobile ? undefined : <IconBtn icon="sidebarL" label="收起历史会话" onClick={() => setSide(false)} />}
      head={
        mobile ? (
          <>
            <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line-soft pr-1 pl-4">
              <span className="font-prose text-h3 text-ink">story2u</span>
              <IconBtn icon="x" label="关闭" onClick={() => setNav(false)} className="ml-auto min-h-11 min-w-11" />
            </div>
            <div className="space-y-3 border-b border-line-soft px-3 py-3">
              <div className="min-w-0">{management ? <BookMenu wide /> : <span className="block truncate px-1 font-prose text-ui text-ink-2">{studio.workspace.projectTitle}</span>}</div>
              {/* The drawer has room for the desktop tab padding (Figma). */}
              <div className="flex items-center justify-between gap-2 [&_[role=tab]]:px-3">{mainNav}</div>
            </div>
          </>
        ) : undefined
      }
    />
  )
  const item = (icon: IconName, label: ReactNode, run: () => void, danger?: boolean) => (
    <Row onClick={() => { setMenu(false); run() }} className={`flex items-center gap-2.5 px-3 py-2 text-ui max-md:py-3 ${danger ? 'text-danger' : 'text-ink-2'}`}>
      <Icon name={icon} className={danger ? '' : 'text-ink-3'} />
      {label}
    </Row>
  )
  const more = (
    <div className="relative">
      <IconBtn icon="more" label="更多" active={menu} onClick={() => setMenu(!menu)} className="max-md:min-h-11 max-md:min-w-11" />
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} aria-hidden />
          <div role="group" aria-label="更多" className="pop absolute top-full right-0 z-40 mt-1 w-60 origin-top-right rounded-xl border border-line-soft bg-surface p-1.5 shadow-soft">
            {item('layers', `本次整理${organized.length ? ` · ${organized.length} 项` : ''}`, () => setReview(true))}
            {item('review', `全部待确认${pendingAll ? ` · ${pendingAll}` : ''}`, openInbox)}
            {item('shield', `AI 资料范围 · ${scopeSummary(t.scopes)}`, () => setAccess(true))}
            {!wide && item(studio.dark ? 'sun' : 'moon', studio.dark ? '浅色模式' : '深色模式', () => studio.setDark(!studio.dark))}
            {t.selected && !t.busy && !running && <div className="my-1 border-t border-line-soft" />}
            {t.selected && !t.busy && !running && item('trash', '删除这次讨论', () => setConfirmDelete(true), true)}
          </div>
        </>
      )}
    </div>
  )
  const desktopBar = (
    <header className="flex h-12 shrink-0 items-center gap-1 px-3">
      {!side && (
        <>
          <IconBtn icon="sidebarL" label="展开历史会话" onClick={() => setSide(true)} />
          <IconBtn icon="plus" label="新对话" onClick={newChat} />
        </>
      )}
      {!landing && (
        <div className="ml-1 flex min-w-0 items-center gap-2">
          <span title={title} className="max-w-60 truncate text-ui text-ink-2 lg:max-w-sm">{title}</span>
          {running && <span className="shrink-0 text-micro text-ai">回复中</span>}
        </div>
      )}
      <div className="ml-auto flex items-center gap-1">
        {storyEntry}
        {organized.length > 0 && (
          <Btn size="sm" pressed={review} onClick={() => setReview(true)} title="这次讨论整理出的候选设定">
            <Icon name="layers" className="h-3.5 w-3.5" />
            本次整理<span className="tabular-nums text-ink-3">{organized.length}</span>
            <span aria-label={`${organized.length} 项待确认`} className="h-1.5 w-1.5 rounded-full bg-warn" />
          </Btn>
        )}
        {/* Figma: no menu over the empty desktop landing; the sidebar footer carries scopes and inbox. */}
        {(!landing || !side) && more}
      </div>
    </header>
  )
  const mobileBar = (
    <header className={`flex h-14 shrink-0 items-center gap-0.5 px-1 ${landing ? '' : 'border-b border-line-soft'}`}>
      <IconBtn icon="menu" label="历史会话与导航" onClick={() => setNav(true)} className="min-h-11 min-w-11" />
      <div className="min-w-0 flex-1 px-1 text-center">
        {landing ? <div className="font-prose text-h3 text-ink">story2u</div> : <div className="truncate text-ui font-medium text-ink">{title}</div>}
        <div className="truncate text-micro text-ink-3">{landing ? studio.workspace.projectTitle : `story2u · ${studio.workspace.projectTitle}`}</div>
      </div>
      <IconBtn icon="plus" label="新对话" onClick={newChat} className="min-h-11 min-w-11" />
      {storyEntry}
      {more}
    </header>
  )
  const landingView = (
    <div className="flex min-h-full flex-col px-5 md:px-8">
      <div className="grow-2" />
      <div className="mx-auto w-full max-w-chat py-8">
        <div className="relative">
          <div aria-hidden className="paper-grid pointer-events-none absolute -inset-x-6 -inset-y-12 md:-inset-x-20" />
          <Heading level={1} className="rise relative text-center tracking-wide whitespace-pre-line max-md:text-display md:text-headline">
            从哪里开始聊起？
          </Heading>
          {!kb && <p className="rise relative mt-4 text-center text-ui-lg text-ink-3">可以是一个人的处境、一条世界规矩，或一幕还没头绪的戏。在「当前故事」里查看已定设定、候选方向和待解的问题。</p>}
        </div>
        {wide && (
          <div className="rise-late mt-10">
            {notices}
            {composer}
          </div>
        )}
        {!kb && (
          <ul aria-label="可以从这里开始" className={`grid grid-cols-2 gap-2 md:flex md:flex-wrap md:justify-center ${wide ? 'rise-later mt-5' : 'rise-late mt-10'}`}>
            {suggestions.map((s) => (
              <li key={s.label} className="min-w-0">
                <Btn variant="outline" onClick={() => fill(s.fill)} className="h-auto min-h-11 w-full justify-start py-2 text-left text-ink-2 md:min-h-9 md:w-auto md:rounded-full">
                  <Icon name={s.icon} className="text-ink-3" />
                  {s.label}
                </Btn>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grow-3" />
    </div>
  )
  const reply = (m: ThinkingMessage, i: number) => {
    const last = i === messages.length - 1
    const run = last && session?.run && session.run.messageId === questionOf(m.id) ? session.run : undefined
    if (unfinished(m) && !m.text.trim()) return <Pending tool={t.tool} steps={t.steps} />
    const failed = m.status === 'failed' || m.status === 'cancelled' || m.status === 'interrupted'
    // A retried question keeps its earlier, unfinished attempt; only the latest one offers recovery.
    const retried = failed && messages.slice(i + 1).some((x) => x.role === 'assistant' && questionOf(x.id) === questionOf(m.id))
    if (retried && !m.text.trim()) return <p className="border-l-2 border-line pl-4 text-ui-sm text-ink-3">这次尝试没有完成，已在下方重新回复。</p>
    const saved = storyState?.receipts.some((receipt) => receipt.messageId === questionOf(m.id) && receipt.status === 'applied')
    return (
      <AiMsg
        m={m}
        fresh={fresh === m.id}
        streaming={unfinished(m)}
        onSource={openSource}
        onNote={saveNote}
        onCopied={(ok) => !ok && studio.toast('无法访问剪贴板，可以手动选择文字复制。')}
        failure={
          retried ? (
            <p className="mt-4 border-l-2 border-line pl-4 text-ui-sm text-ink-3">这次尝试没有完整生成，已在下方重新回复。</p>
          ) : failed ? (
            <Failure m={m} run={run} storySaved={saved} busy={t.busy || running || analysisStarting} recent={recent} onResume={t.resume} onAsk={() => ask(m)} onScopes={() => setAccess(true)} onNewTopic={newChat} onAnalyze={analysisStarting ? undefined : () => void startAnalysis()} />
          ) : undefined
        }
        organize={
          m.status === 'completed' ? (
            <TurnOrganize turn={turns.find((x) => x.answerId === m.id)} proposals={mine} enabled={!!settings?.enabled && !settings.needsModelConsent} busy={t.busy || running} onOrganize={() => void organizeTurn(questionOf(m.id))} onOpen={setDrawer} onDecide={decide} />
          ) : undefined
        }
      />
    )
  }
  const thread = (
    <div className="mx-auto w-full max-w-chat px-5 pt-6 pb-10 md:px-8">
      {session?.history?.hasMore && (
        <div className="mb-6 text-center">
          <Btn
            size="sm"
            variant="quiet"
            disabled={t.historyBusy}
            onClick={() => {
              const el = scroller.current
              if (el) anchor.current = { top: el.scrollTop, height: el.scrollHeight }
              t.loadHistory()
            }}
          >
            {t.historyBusy ? '正在读取…' : '加载更早的讨论'}
          </Btn>
        </div>
      )}
      {t.historyError && (
        <p role="alert" className="mb-4 text-ui-sm text-warn">
          {t.historyError}
        </p>
      )}
      {loading && !outgoing && (
        <div role="status" className="space-y-4">
          <p className="text-ui-sm text-ink-3">{t.error ? '暂时无法读取这次讨论，恢复连接后会自动重试。历史仍保存在服务端。' : '正在读取这次讨论…'}</p>
          {!t.error && (
            <div aria-hidden className="space-y-4">
              {['w-7/12 ml-auto', 'w-full', 'w-10/12', 'w-8/12'].map((w) => (
                <div key={w} className={`skeleton h-4 ${w}`} />
              ))}
            </div>
          )}
        </div>
      )}
      <ol aria-label="对话记录" className="space-y-10">
        {messages.map((m, i) => (
          <li key={m.id} id={`msg-${m.id}`} className={`scroll-mt-6 rounded-lg transition-shadow duration-500 ${lit === m.id ? 'ring-1 ring-accent/40 ring-offset-8 ring-offset-page' : ''}`}>
            {m.role === 'user' ? <AuthorMsg m={m} fresh={fresh === m.id} note={<>
              {storyState?.receipts.filter((receipt) => receipt.messageId === m.id).map((receipt) => <StoryReceipt key={`${book}:${receipt.changeId}`} bookId={book} receipt={receipt} chapterTitles={chapterTitles} onChanged={onReceiptChanged} onReread={rereadStory} onAsset={openStoryAsset} onStory={() => setStoryOpen(true)} />)}
              {!storyState?.receipts.some((receipt) => receipt.messageId === m.id) && m.storyRecording && m.storyRecording.changeCount > 0 && <StoryRecordingStatus status={m.storyRecording} onRead={rereadStory} onContinue={!running && storyState?.receiptsRead ? () => fillFromStory(m.storyRecording?.status === 'failed' ? `关于我上次说的「${m.text.slice(0, 4000)}」，我想调整：` : `请核对当前故事，确认我上次说的「${m.text.slice(0, 4000)}」是否已记下；缺少的部分再记下。`) : undefined} onRetry={session?.run?.messageId === m.id && session.run.resumable && !t.busy && !running ? () => t.resume({ runId: session.run!.runId, confirmAdditionalCost: true, ...(recent ? { continuationContext: recent } : {}) }) : undefined} />}
            </>} /> : reply(m, i)}
          </li>
        ))}
        {outgoing && (
          <li>
            <AuthorMsg m={{ text: outgoing }} fresh note={<p role="status" className="mt-1.5 text-micro text-ink-3">正在发送…</p>} />
          </li>
        )}
      </ol>
    </div>
  )
  const dock = (
    <div className={`relative shrink-0 px-3 pt-2 md:px-8 md:pb-5 ${kb ? 'pb-2' : 'pb-safe'} ${landing ? '' : 'before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-8 before:bg-linear-to-t before:from-page before:to-transparent'}`}>
      {away && !landing && (
        <div className="absolute inset-x-0 bottom-full z-10 mb-2 flex justify-center">
          <Btn size="sm" variant="outline" onClick={toBottom} className="bg-surface shadow-soft max-md:min-h-11">
            <Icon name="down" className="h-3.5 w-3.5" />
            回到最新
          </Btn>
        </div>
      )}
      <div className="mx-auto w-full max-w-chat">
        {notices}
        {composer}
        {wide && recording && <p className="mt-2 text-center text-micro text-ink-3">明确的决定会记入设定，尝试中的想法保留为候选。记录可在原话下查看和撤销。</p>}
      </div>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      {wide && (
        <aside aria-label="历史会话" inert={!side || (storyOpen && !dockable)} className={`shrink-0 overflow-hidden bg-paper transition-[width] duration-300 ease-calm ${side ? 'w-64 border-r border-line-soft' : 'w-0'}`}>
          <div className="h-full w-64">{history(false)}</div>
        </aside>
      )}
      {!wide && nav && (
        <>
          <div className="fade fixed inset-0 z-40 bg-scrim" onClick={() => setNav(false)} aria-hidden />
          <aside aria-label="历史会话与导航" className="drawer-in fixed inset-y-0 left-0 z-50 flex w-5/6 max-w-80 flex-col bg-paper pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-soft">
            {history(true)}
          </aside>
        </>
      )}

      <main aria-label="灵感对话" inert={storyOpen && !dockable} className="relative flex min-w-0 flex-1 flex-col">
        {wide ? desktopBar : mobileBar}
        <div ref={scroller} onScroll={onScroll} onWheel={release} onTouchMove={release} onKeyDown={release} className="scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none]">
          {landing ? landingView : thread}
        </div>
        {(!landing || !wide) && dock}
      </main>

      {storyOpen && <StoryDrawer key={`${book}:${sessionId ?? ''}`} mode={dockable ? 'dock' : wide ? 'drawer' : 'sheet'} bookId={book} workTitle={studio.workspace.projectTitle} sessionId={sessionId} messages={messages} receipts={storyState?.receipts ?? []} context={storyState?.context ?? null} error={(recordingError?.book === book ? recordingError.message : '') || storyLoadError} unknown={messages.some((message) => message.storyRecording?.status === 'unknown' && !storyState?.receipts.some((receipt) => receipt.messageId === message.id))} recording={recording} recordingBusy={recordingBusy === book} organized={organized.length} covered={!!storyAsset || !!drawer || review} onRecording={(value) => void setRecording(value)} onRead={rereadStory} onClose={() => setStoryOpen(false)} onFill={fillFromStory} onAsset={openStoryAsset} onMessage={(sid, mid) => { if (!dockable) setStoryOpen(false); toMessage(sid, mid) }} onReview={() => setReview(true)} onBook={() => { setStoryOpen(false); studio.setBookNav({ section: 'people' }); studio.setView('book') }} onFocusSaved={(focus) => setStory((previous) => previous?.book === book && previous.sessionId === focus.sessionId && previous.context ? { ...previous, context: { ...previous.context, focus } } : previous)} />}
      {storyAsset?.book === book && <><div className="fade fixed inset-0 z-50 bg-scrim" onClick={() => setStoryAsset(null)} aria-hidden /><aside role="dialog" aria-modal="true" aria-label="设定详情" className="slide-r fixed inset-y-0 right-0 z-50 w-full border-l border-line-soft shadow-soft sm:max-w-drawer"><AssetDrawer key={`${book}:${storyAsset.id}`} bookId={book} id={storyAsset.id} chapters={studio.chapters} chapterTitle={chapterTitles} onClose={() => setStoryAsset(null)} onChanged={reloadCreative} onDiscuss={fillFromStory} onChapter={(id) => { setStoryAsset(null); studio.workspace.switchChapter(id); studio.setView('read') }} onSession={(sid, mid) => { setStoryAsset(null); toMessage(sid, mid) }} /></aside></>}
      {review && (
        <ReviewDrawer
          settings={settings}
          proposals={organized}
          onOpen={setDrawer}
          onDecide={decide}
          onClose={() => setReview(false)}
          onBook={openInbox}
          onEnable={() => setOrganizeConsent(true)}
          onAuto={async (on) => {
            try {
              await creativeApi.settings(book, 'auto', { autoOrganize: on })
              refreshOverview()
            } catch (e) {
              studio.toast(creativeError(e))
            }
          }}
          onOrchestration={async (on) => {
            try {
              await creativeApi.settings(book, 'orchestration', { multiAgentPlanCheck: on })
              refreshOverview()
            } catch (e) {
              studio.toast(creativeError(e))
            }
          }}
          onMemory={async (on) => {
            try {
              await creativeApi.settings(book, 'memory', { autoMemoryConsolidation: on })
              refreshOverview()
            } catch (e) {
              studio.toast(creativeError(e))
            }
          }}
        />
      )}
      {drawer && (
        <ProposalDrawer
          proposal={drawer}
          book={book}
          chapters={studio.chapters.map((c) => ({ id: c.id, title: c.title }))}
          onClose={() => setDrawer(null)}
          onDecide={decide}
          onDone={() => {
            setDrawer(null)
            reloadCreative()
          }}
          onSession={toMessage}
        />
      )}
      {access && <ScopeDialog scopes={t.scopes} onSave={t.saveScopes} onClose={() => setAccess(false)} />}
      {confirmDelete && (
        <Dialog
          title="删除这次讨论？"
          label="删除这次讨论"
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <Btn variant="outline" onClick={() => setConfirmDelete(false)}>
                取消
              </Btn>
              <Btn
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false)
                  t.remove()
                  window.setTimeout(reloadCreative, 300)
                }}
              >
                删除
              </Btn>
            </>
          }
        >
          「{title}」及其讨论上下文会被删除；由它整理出、尚未确认的候选会失效。已确认的设定和正文不受影响。
        </Dialog>
      )}
      {organizeConsent && settings && (
        <CreativeConsent
          bookId={book}
          settings={settings}
          onClose={() => setOrganizeConsent(false)}
          onEnabled={() => {
            setOrganizeConsent(false)
            reloadCreative()
          }}
        />
      )}
    </div>
  )
}
