// 「灵感」工作台 — layout and visual language from Figma Make
// (Writer Agent UI_UX Design/src/components/idea/Inspiration.tsx): sessions on
// the left, the conversation in the middle, the organizing panel on the right.
// Every value here comes from the real Thinking and Creative APIs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CreativeProposal, CreativeTurn, ThinkingMessage, ThinkingSource } from '@writer-agent/contracts'
import { Btn, Choice, Dialog, Heading, Icon, IconBtn, Quote, Row, Seg, TextArea, TextInput, ago, type IconName } from '../../components/vnext/ui'
import { thinkingError } from '../thinking/errors'
import { creativeApi } from '../../services/api/creativeApi'
import RunRecovery from '../thinking/RunRecovery'
import ToolTimeline from '../thinking/ToolTimeline'
import type { useStudioController } from '../vnext/useStudioController'
import AssetEditor from './AssetEditor'
import CreativeConsent from './CreativeConsent'
import ProposalCard from './ProposalCard'
import { DESIGN_KINDS, StatusTag, designKind, designKindName, proposalStatus } from './kit'
import { creativeError, turnStatusLabels } from './labels'
import { useCreativeOverview } from './useCreativeOverview'

type Studio = ReturnType<typeof useStudioController>
const POLL_MS = 3000
const at = (iso: string) => Date.parse(iso) || Date.now()
const activeTurn = (t: CreativeTurn) => t.status === 'awaiting' || t.status === 'queued'

const starters: { id: string; icon: IconName; label: string; hint: string; prompt: string }[] = [
  { id: 'world', icon: 'globe', label: '从一个世界开始', hint: '一种力量、一处地方、一条规则', prompt: '我想先构思这个故事的世界：' },
  { id: 'person', icon: 'users', label: '从一个人物开始', hint: 'ta 想要什么，又在害怕什么', prompt: '我想先构思一个人物：' },
  { id: 'conflict', icon: 'flag', label: '从一场冲突开始', hint: '两股相互拉扯的力量', prompt: '我想先构思一场冲突：' },
  { id: 'continue', icon: 'history', label: '继续上次的构思', hint: '', prompt: '' },
  { id: 'free', icon: 'think', label: '随便聊聊我的想法', hint: '零散的念头、一句对白、一个画面', prompt: '' },
]

export default function InspirationWorkspace({ studio }: { studio: Studio }) {
  const t = studio.thinking
  const book = studio.workspace.projectId
  const { overview, refresh: refreshOverview } = useCreativeOverview(book, true)
  const settings = overview?.settings
  const [left, setLeft] = useState(false)
  const [right, setRight] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1280)
  const [q, setQ] = useState('')
  const [access, setAccess] = useState(false)
  const [accessScopes, setAccessScopes] = useState<typeof t.scopes>([])
  const [organizeConsent, setOrganizeConsent] = useState(false)
  const [include, setInclude] = useState(true)
  const [localError, setLocalError] = useState('')
  const [turns, setTurns] = useState<CreativeTurn[]>([])
  const [mine, setMine] = useState<CreativeProposal[]>([])
  const [allPending, setAllPending] = useState<CreativeProposal[]>([])
  const [tick, setTick] = useState(0)
  const [lit, setLit] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<CreativeProposal | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const session = t.session
  const sessionId = session?.sessionId
  const running = session?.status === 'running'
  const seed = studio.thinkingSeed

  // Organizing state for this session; refreshes while work is in flight.
  useEffect(() => {
    if (!settings?.enabled) {
      setTurns([])
      setMine([])
      return
    }
    let alive = true
    let timer: number | undefined
    const load = async () => {
      try {
        const [pending, list] = await Promise.all([
          creativeApi.proposals(book, { status: 'proposed', limit: 100 }),
          sessionId ? creativeApi.turns(book, sessionId) : Promise.resolve({ items: [] as CreativeTurn[] }),
        ])
        const own = sessionId ? await creativeApi.proposals(book, { sessionId, limit: 100 }) : { items: [] }
        if (!alive) return
        setAllPending(pending.items)
        setTurns(list.items)
        setMine(own.items)
        if ((list.items.some(activeTurn) || running) && document.visibilityState === 'visible') timer = window.setTimeout(() => void load(), POLL_MS)
      } catch (e) {
        if (alive) setLocalError(creativeError(e))
      }
    }
    void load()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [book, sessionId, settings?.enabled, running, session?.messages.length, tick])
  const reloadCreative = useCallback(() => {
    setTick((n) => n + 1)
    refreshOverview()
  }, [refreshOverview])

  useEffect(() => {
    if (lit) {
      document.getElementById(`msg-${lit}`)?.scrollIntoView({ block: 'center' })
      const timer = window.setTimeout(() => setLit(null), 2600)
      return () => window.clearTimeout(timer)
    }
    end.current?.scrollIntoView({ block: 'end' })
  }, [sessionId, session?.messages.length, lit])

  // Jump requests from 书 / proposals: open the session and highlight the message.
  useEffect(() => {
    const f = studio.ideaFocus
    if (!f) return
    studio.setIdeaFocus(null)
    if (f.sessionId !== t.selected) t.select(f.sessionId)
    if (f.messageId) setLit(f.messageId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.ideaFocus])

  const send = async () => {
    setLocalError('')
    const text = t.draft.trim()
    if (!text || t.busy || running) return
    try {
      let selection
      if (seed && include) {
        if (!t.scopes.includes('chapters')) throw Error('请先在「AI 资料范围」中允许读取本作品章节，再附上选中原文。')
        const saved = await studio.workspace.prepareReview()
        selection = { chapterId: saved.chapterId, revisionId: saved.revisionId, contentHash: saved.contentHash, quote: seed }
      }
      t.send({ text, selection })
      studio.setThinkingSeed('')
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : '原文尚未保存。')
    }
  }
  const start = (id: string) => {
    if (id === 'continue') {
      const last = t.sessions[0]
      if (last) t.select(last.sessionId)
      return
    }
    const s = starters.find((x) => x.id === id)
    if (s?.prompt) t.setDraft(s.prompt)
    window.setTimeout(() => input.current?.focus(), 0)
  }
  const decide = async (p: CreativeProposal, action: 'accept' | 'reject') => {
    try {
      await creativeApi.decide(book, [{ proposalId: p.proposalId, action }])
      studio.toast(action === 'accept' ? `「${p.result?.name ?? p.targetName}」已成为作品设定` : '已否决，可以在「书 · 待确认」中查看记录')
      setDrawer(null)
      reloadCreative()
    } catch (e) {
      studio.toast(creativeError(e))
    }
  }
  const toMessage = (sid: string, mid: string) => {
    setDrawer(null)
    if (sid !== t.selected) t.select(sid)
    setLit(mid)
  }
  const sessions = t.sessions.filter((s) => !q.trim() || s.title.includes(q.trim()))
  const pendingCount = overview?.pendingProposals ?? allPending.length
  const confirmed = overview ? Object.values(overview.counts).reduce((n, c) => n + (c.accepted ?? 0), 0) : 0
  const words = studio.chapters.reduce((n, c) => n + (c.wordCount ?? 0), 0)
  const turnFor = (m: ThinkingMessage) => turns.find((x) => x.answerId === m.id)
  const offline = !t.model

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* 左：创作探索记录 */}
      {left && <div className="fade fixed inset-0 z-40 bg-scrim lg:hidden" onClick={() => setLeft(false)} aria-hidden />}
      <aside aria-label="创作探索记录" className={`${left ? 'slide-l fixed inset-y-0 left-0 z-50 flex w-full max-w-nav shadow-soft' : 'hidden'} min-h-0 shrink-0 flex-col border-r border-line-soft bg-paper lg:static lg:z-auto lg:flex lg:w-(--container-sessions) lg:shadow-none`}>
        <div className="flex items-center gap-2 px-4 pt-4">
          <span className="text-micro text-ink-3">当前作品</span>
          <IconBtn size="sm" icon="refresh" label="刷新会话" onClick={() => void t.reload()} className="-my-1 ml-auto" />
          <IconBtn icon="x" label="关闭" onClick={() => setLeft(false)} className="lg:hidden" />
        </div>
        <div className="px-4 pt-1 pb-4">
          <div className="font-prose text-h3 text-ink">{studio.workspace.projectTitle}</div>
          <p className="mt-0.5 text-ui-sm text-ink-3">{words ? `${studio.chapters.length} 章 · ${words.toLocaleString()} 字` : '还没有正文 · 从构思开始'}</p>
          <p className="mt-0.5 text-ui-sm text-ink-3">
            {confirmed} 项设定
            {pendingCount > 0 && (
              <>
                {' · '}
                <Btn variant="link" className="text-ui-sm" onClick={() => openBook(studio, 'inbox')}>
                  {pendingCount} 项待确认
                </Btn>
              </>
            )}
          </p>
        </div>
        <div className="space-y-2 px-3">
          <Btn variant="outline" className="w-full" disabled={t.busy} onClick={() => { t.select(null); setLeft(false) }}>
            <Icon name="plus" />
            新话题
          </Btn>
          <TextInput label="搜索讨论" value={q} onChange={setQ} placeholder="搜索讨论" />
        </div>
        <div className="scroll mt-3 min-h-0 flex-1 overflow-auto px-3 pb-6">
          {!sessions.length && <p className="px-2 py-6 text-center text-ui-sm text-ink-3">{q.trim() ? `没有找到包含“${q.trim()}”的讨论` : '还没有讨论。从一个念头开始吧。'}</p>}
          {sessions.length > 0 && (
            <section className="mb-4">
              <div className="px-2 pb-1 text-micro text-ink-3">最近讨论</div>
              <ul className="space-y-0.5">
                {sessions.map((s) => (
                  <li key={s.sessionId}>
                    <Row active={t.selected === s.sessionId} disabled={t.busy} onClick={() => { t.select(s.sessionId); setLeft(false) }} className="px-2 py-2">
                      <span className="line-clamp-1 text-ui text-ink">{s.title}</span>
                      <span className="mt-0.5 block text-micro text-ink-3">{ago(at(s.createdAt))}</span>
                    </Row>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>

      {/* 中：AI 灵感对话 */}
      <main aria-label="灵感对话" className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line-soft px-3 sm:px-5">
          <IconBtn icon="sidebarL" label="创作探索记录" onClick={() => setLeft(true)} className="lg:hidden" />
          {session ? (
            <>
              <span className="min-w-0 truncate text-ui font-medium text-ink">{session.title}</span>

              <IconBtn
                size="sm"
                icon="trash"
                label="删除会话"
                className="ml-auto"
                onClick={() => {
                  if (window.confirm('删除这次私人讨论及其会话上下文？由它整理出、尚未确认的候选会失效。')) {
                    t.remove()
                    window.setTimeout(reloadCreative, 300)
                  }
                }}
              />
            </>
          ) : t.selected ? (
            // The snapshot could not be read (service offline): history and deletion stay available.
            <>
              <span className="min-w-0 truncate text-ui text-ink-3">{t.sessions.find((s) => s.sessionId === t.selected)?.title ?? '这次讨论'} · 暂时无法读取</span>
              <IconBtn
                size="sm"
                icon="trash"
                label="删除会话"
                className="ml-auto"
                onClick={() => {
                  if (window.confirm('删除这次私人讨论及其会话上下文？由它整理出、尚未确认的候选会失效。')) {
                    t.remove()
                    window.setTimeout(reloadCreative, 300)
                  }
                }}
              />
            </>
          ) : (
            <span className="text-ui text-ink-3">新的构思</span>
          )}
          <Btn size="sm" variant={right ? 'quiet' : 'outline'} pressed={right} onClick={() => setRight(!right)} className={session || t.selected ? '' : 'ml-auto'} title="灵感整理面板">
            <Icon name="sidebarR" />
            <span className="hidden sm:inline">灵感整理</span>
            {pendingCount > 0 && <span className="tabular-nums text-warn">{pendingCount}</span>}
          </Btn>
        </div>

        <div className="scroll min-h-0 flex-1 overflow-auto">
          {!session ? (
            <Welcome title={studio.workspace.projectTitle} hasLast={t.sessions.length > 0} lastTitle={t.sessions[0]?.title} onStart={start} />
          ) : (
            <div className="mx-auto max-w-read px-5 pt-8 pb-10">
              <ol className="space-y-8">
                {session.messages.map((m) => (
                  <li key={m.id} id={`msg-${m.id}`} className={`rounded-lg transition-shadow ${lit === m.id ? 'ring-1 ring-accent/50 ring-offset-8 ring-offset-paper' : ''}`}>
                    {m.role === 'user' ? (
                      <div className="group ml-8 sm:ml-16">
                        <div className="rounded-xl bg-surface-2 px-4 py-3 font-prose text-read whitespace-pre-wrap text-ink">{m.text}</div>
                        <div className="mt-1 flex justify-end gap-2 text-micro text-ink-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                          <span>{ago(at(m.createdAt))}</span>
                        </div>
                      </div>
                    ) : (
                      <AiMessage
                        m={m}
                        turn={turnFor(m)}
                        enabled={!!settings?.enabled}
                        proposals={mine}
                        busy={t.busy || running}
                        onCopyQuestion={() => {
                          const index = session.messages.findIndex((v) => v.id === m.id)
                          const prior = session.messages.slice(0, index).reverse().find((v) => v.role === 'user')
                          if (prior) t.setDraft(prior.text)
                        }}
                        onOrganize={async (messageId) => {
                          try {
                            await creativeApi.organize(book, session.sessionId, messageId)
                            reloadCreative()
                          } catch (e) {
                            studio.toast(creativeError(e))
                          }
                        }}
                        onDecide={decide}
                        onOpen={setDrawer}
                        onSource={(src) => {
                          studio.workspace.switchChapter(src.chapterId)
                          studio.setView('read')
                        }}
                      />
                    )}
                  </li>
                ))}
              </ol>
              {running && (
                <div className="mt-8 space-y-3" aria-live="polite">
                  <div className="flex items-center gap-3 text-ui text-ink-3">
                    <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-ai" />
                    正在想…
                    <Btn size="sm" disabled={t.busy} onClick={t.cancel}>
                      <Icon name="stop" className="h-3 w-3" />
                      停止
                    </Btn>
                  </div>
                  <details className="text-ui-sm text-ink-3"><summary className="cursor-pointer">查看执行详情</summary><ToolTimeline steps={t.steps} activeTool={t.tool} /></details>
                </div>
              )}
              <div ref={end} />
            </div>
          )}
          {t.outgoing && <div role="status" className="mx-auto w-full max-w-read px-5 py-3"><p className="ml-8 rounded-xl bg-surface-2 px-4 py-3 font-prose whitespace-pre-wrap">{t.outgoing}</p><p className="text-right text-micro text-ink-3">正在发送…</p></div>}
        </div>

        {/* Composer */}
        <div className="shrink-0 px-3 pb-4 sm:px-5">
          <div className="mx-auto max-w-read">
            {(t.error || localError || offline || t.modelNotice) && (
              <p role="alert" className="mb-2 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-1.5 text-ui-sm text-ink-2">
                <Icon name="offline" className="mt-0.5 shrink-0 text-warn" />
                <span>{localError || t.error || t.modelNotice || '灵感服务暂不可用。'} 输入已保留；写作与保存不受影响，可以稍后重试。</span>
              </p>
            )}
            {t.error && t.requestFailure && <details className="text-micro text-ink-3"><summary>请求故障详情</summary><p>错误码：{t.requestFailure.code}{t.requestFailure.traceId ? ` · 追踪编号：${t.requestFailure.traceId}` : ""}</p></details>}
            {t.cancellationPending && <p role="status" className="text-ui-sm text-ink-3">取消已记录，服务恢复后会同步停止状态。不会恢复已取消的任务。</p>}
            <RunRecovery key={session?.run?.runId} run={session?.run} busy={t.busy || running} onResume={t.resume} onAuthorize={() => {setAccessScopes(t.scopes);setAccess(true)}}/>
            {t.pendingDelivery && !t.busy && <div role="status" className="mb-2 text-ui-sm text-ink-2">上一条消息的送达情况尚未确认，原问题和重试记录已保留。<Btn size="sm" onClick={t.retryPending}>恢复待确认问题</Btn></div>}
            <div className="rounded-xl border border-line bg-surface shadow-soft focus-within:border-accent/50">
              {seed && (
                <div className="flex items-start gap-2 border-b border-line-soft px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-micro text-ink-3">引用正文 · {studio.chapter.title || '当前章节'}</div>
                    <p className="line-clamp-2 font-prose text-ui text-ink-2">{seed}</p>
                    <label className="mt-1 flex items-center gap-1.5 text-micro text-ink-3">
                      <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} className="accent-current" />
                      作为已保存原文附上（先安全保存）
                    </label>
                  </div>
                  <IconBtn size="sm" icon="x" label="移除引用" onClick={() => studio.setThinkingSeed('')} />
                </div>
              )}
              <TextArea
                label="说说你的想法"
                inputRef={input}
                prose
                rows={session ? 2 : 3}
                maxLength={12000}
                disabled={t.busy}
                value={t.draft}
                onChange={t.setDraft}
                placeholder={session ? '说说你的想法，零散的也可以……' : '比如：我想写一个欲望很强、却渴望自由的精神生命……'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey || !window.matchMedia('(pointer: coarse)').matches)) {
                    e.preventDefault()
                    void send()
                  }
                }}
                className={`scroll field-sizing-content max-h-60 px-4 pt-3 ${session ? 'min-h-14' : 'min-h-20'}`}
              />
              <div className="flex items-center gap-2 px-3 pb-2.5">
                <label className="min-w-0 max-w-[65%] text-micro text-ink-3">
                  <span className="sr-only">选择对话模型</span>
                  <select aria-label="选择对话模型" className="max-w-full rounded-md border border-line bg-surface px-2 py-1 text-ui-sm text-ink" value={t.modelChoice} disabled={running || t.busy} onChange={e => t.chooseModel(e.target.value)}>
                    {!t.models.length && <option value="">模型暂不可用</option>}
                    {t.modelChoice && !t.models.some(m => m.modelId === t.modelChoice) && <option value={t.modelChoice} disabled>原模型已不可用 · 请主动选择</option>}
                    {t.models.map(m => <option key={m.modelId} value={m.modelId} disabled={!m.enabled}>{m.displayName} · {m.hostedBy}{!m.enabled ? '（暂不可用）' : ''}</option>)}
                  </select>
                </label>
                <Btn size="sm" variant="quiet" disabled={t.busy || running} onClick={() => {setAccessScopes(t.scopes);setAccess(true)}}>AI 资料范围</Btn>
                <Btn size="sm" variant="primary" className="ml-auto" disabled={!t.draft.trim() || t.busy || running || offline || !t.modelAvailable || (!!t.selected && !t.session)} onClick={() => void send()}>
                  <Icon name="send" className="h-3 w-3" />
                  发送
                </Btn>
              </div>
            </div>
            {t.models.find(m => m.modelId === t.modelChoice)?.description && <p className="mt-2 text-center text-micro text-ink-3">{t.models.find(m => m.modelId === t.modelChoice)?.description}</p>}
            <p className="mt-2 text-center text-micro text-ink-3">AI 只倾听、追问和整理，不会替你决定，也不会自动改写设定或正文。</p>
          </div>
        </div>
      </main>

      {/* 右：灵感整理面板 */}
      {right && <div className="fade fixed inset-0 z-40 bg-scrim xl:hidden" onClick={() => setRight(false)} aria-hidden />}
      {right && (
        <aside aria-label="灵感整理" className="slide-r fixed inset-y-0 right-0 z-50 flex w-full min-h-0 flex-col border-l border-line-soft bg-surface shadow-soft sm:max-w-aside xl:static xl:z-auto xl:w-(--container-aside) xl:shrink-0 xl:shadow-none">
          <OrganizePanel
            settings={settings}
            session={!!session}
            mine={mine.filter((p) => p.status === 'proposed')}
            pending={allPending}
            onOpen={setDrawer}
            onDecide={decide}
            onClose={() => setRight(false)}
            onBook={() => openBook(studio, 'inbox')}
            onEnable={() => setOrganizeConsent(true)}
            onAuto={async (on) => {
              try {
                await creativeApi.settings(book, 'auto', { autoOrganize: on })
                refreshOverview()
              } catch (e) {
                studio.toast(creativeError(e))
              }
            }}
          />
        </aside>
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

      {access && (
        <Dialog title="本作品的 AI 资料范围" label="本作品的 AI 资料范围" onClose={() => setAccess(false)} actions={<><Btn onClick={() => setAccess(false)}>取消</Btn><Btn variant="primary" onClick={async () => {if(await t.saveScopes(accessScopes)) setAccess(false)}}>保存范围</Btn></>}>
          <p className="mb-4 text-ui-sm text-ink-2">发送消息会将你的问题及本次讨论历史交给所选外部模型。默认只讨论你发送的内容；开启下列范围后，AI 可按需检索本作品资料。不会读取其他作品，不会修改正文或正式设定。你可以随时关闭。</p>
          {([['chapters', '本作品已保存章节'], ['knowledge', '本作品知识库'], ['creative', '创作设定与待确认候选'], ['notes', '私人作者笔记（额外授权）']] as const).map(([key,label]) => (
            <Choice key={key} checked={accessScopes.includes(key)} onChange={on => setAccessScopes(old => on ? [...old, key] : old.filter(s => s !== key))}>{label}</Choice>
          ))}
          <p className="mt-4 text-micro text-ink-3">范围保存在本作品设置中，适用于后续讨论。关闭权限会停止仍在读取资料的回复。</p>
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

function openBook(studio: Studio, section: 'inbox') {
  studio.setBookNav({ section })
  studio.setView('book')
}

function Welcome({ title, hasLast, lastTitle, onStart }: { title: string; hasLast: boolean; lastTitle?: string; onStart: (id: string) => void }) {
  return (
    <div className="mx-auto max-w-read px-5 pt-14 pb-10 sm:pt-20">
      <p className="text-ui-sm text-ink-3">灵感 · {title}</p>
      <Heading level={1} className="mt-3 text-display">
        今天，你想构思一个怎样的故事？
      </Heading>
      <p className="mt-4 font-prose text-read text-ink-2">创作从灵感开始，不必先写正文。说出一个世界、一个人物、一场冲突，或者一个模糊的画面——我会倾听、追问，把聊出来的东西整理成候选设定。收不收进「书」里，由你决定。</p>
      <ul className="mt-8 grid gap-2 sm:grid-cols-2">
        {starters.map((s) => {
          const off = s.id === 'continue' && !hasLast
          return (
            <li key={s.id} className={s.id === 'free' ? 'sm:col-span-2' : ''}>
              <Row disabled={off} onClick={() => onStart(s.id)} className={`flex items-start gap-3 border border-line-soft px-4 py-3.5 ${off ? 'opacity-50' : ''}`}>
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-2">
                  <Icon name={s.icon} />
                </span>
                <span className="min-w-0">
                  <span className="block text-ui-lg text-ink">{s.label}</span>
                  <span className="mt-0.5 block truncate text-ui-sm text-ink-3">{s.id === 'continue' ? (lastTitle ? `「${lastTitle}」` : '还没有上次的构思') : s.hint}</span>
                </span>
              </Row>
            </li>
          )
        })}
      </ul>
      <p className="mt-10 text-ui-sm text-ink-3">或者，直接在下面写下你脑海里的第一个画面。</p>
    </div>
  )
}

const statusLabel: Record<ThinkingMessage['status'], string> = { accepted: '已接受', running: '思考中', completed: '已完成', failed: '未完成', cancelled: '已取消', interrupted: '已中断' }

function AiMessage({
  m,
  turn,
  enabled,
  proposals,
  busy,
  onCopyQuestion,
  onOrganize,
  onDecide,
  onOpen,
  onSource,
}: {
  m: ThinkingMessage
  turn?: CreativeTurn
  enabled: boolean
  proposals: CreativeProposal[]
  busy: boolean
  onCopyQuestion: () => void
  onOrganize: (messageId: string) => void
  onDecide: (p: CreativeProposal, action: 'accept' | 'reject') => void
  onOpen: (p: CreativeProposal) => void
  onSource: (s: ThinkingSource) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const text =
    m.text.replace(/\[\[source:([^\]]+)\]\]/g, (_all, id: string) => {
      const index = m.sources.findIndex((src) => src.sourceId === id)
      return index >= 0 ? `[原文 ${index + 1}]` : m.status === 'running' ? '[引文待核验]' : '[未核验引用]'
    }) || (m.status === 'accepted' || m.status === 'running' ? '正在思考…' : m.status === 'cancelled' ? '本次思考已取消。' : '未生成完整分析。')
  const own = useMemo(() => proposals.filter((p) => turn?.changeSetId && p.changeSetId === turn.changeSetId), [proposals, turn?.changeSetId])
  const open = own.filter((p) => p.status === 'proposed').length
  const userId = m.id.replace(/-answer$/, '')
  return (
    <div className="group">
      <div className="mb-2 flex items-center gap-2 text-micro text-ink-3">
        <Icon name="think" className="h-3 w-3" />
        创作伙伴
        {m.status !== 'completed' && <span>· {statusLabel[m.status]}</span>}
      </div>
      <div className="space-y-3 font-prose text-read text-ink">
        {text.split('\n\n').map((part, i) => (
          <p key={i} className="whitespace-pre-wrap break-words">
            {part}
          </p>
        ))}
      </div>
      {m.sources.length > 0 && (
        <details className="mt-3 text-ui-sm">
          <summary className="cursor-pointer text-ink-3">原文引用 · {m.sources.length}</summary>
          <div className="mt-2 space-y-2">
            {m.sources.map((src, i) => (
              <div key={src.sourceId}>
                <Quote label={`[原文 ${i + 1}] ${src.title} · ${src.validity === 'stale' ? '旧版本引文' : '原文位置已核验'}${src.epistemic ? ` · ${{ observation: '正文观察', claim: '角色说法', inference: 'AI 推测' }[src.epistemic]}` : ''}`} state={src.validity === 'stale' ? 'stale' : 'ok'} onOpen={() => onSource(src)}>
                  {src.quote}
                </Quote>
              </div>
            ))}
            <p className="text-micro text-ink-3">引文证明原文存在，不代表推断成立。</p>
          </div>
        </details>
      )}
      {m.modelLabel && <p className="mt-2 text-micro text-ink-3">{m.modelLabel}</p>}
      {m.errorCode && m.status !== 'cancelled' && (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-ui-sm text-ink-2">
          <Icon name="info" className="text-warn" />
          {thinkingError(m.errorCode)}
          <Btn variant="link" className="text-ui-sm" disabled={busy} onClick={onCopyQuestion}>
            复制原问题到输入框
          </Btn>
        </div>
      )}
      {enabled && m.status === 'completed' && (
        <div className="mt-4">
          {!turn || turn.status === 'awaiting' || turn.status === 'queued' ? (
            turn ? (
              <p className="inline-flex items-center gap-1.5 text-ui-sm text-ink-3" aria-live="polite">
                <Icon name="refresh" className="h-3 w-3 animate-spin" />
                正在整理本轮讨论…
              </p>
            ) : (
              <Btn size="sm" variant="quiet" onClick={() => onOrganize(userId)}>
                <Icon name="layers" className="h-3 w-3" />
                整理本轮
              </Btn>
            )
          ) : turn.status === 'organized' && own.length > 0 ? (
            <>
              <Btn size="sm" variant="outline" className="rounded-full" pressed={expanded} onClick={() => setExpanded(!expanded)}>
                <Icon name="layers" className="h-3 w-3" />
                整理出 {own.length} 项候选{open < own.length ? ` · 已处理 ${own.length - open}` : ''}
                <Icon name="chevronDown" className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </Btn>
              {expanded && (
                <ul className="mt-3 space-y-2">
                  {own.map((p) => (
                    <li key={p.proposalId}>
                      <ProposalCard dense proposal={p} onOpen={() => onOpen(p)} onAccept={() => onDecide(p, 'accept')} onReject={() => onDecide(p, 'reject')} onEdit={() => onOpen(p)} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : turn.status === 'no_change' ? (
            <p className="text-micro text-ink-3">本轮没有新的设定{turn.summary ? ` · ${turn.summary}` : ''}</p>
          ) : (
            <p className="flex flex-wrap items-center gap-2 text-micro text-ink-3">
              {turnStatusLabels[turn.status]}
              {turn.reason ? ` · ${turn.reason}` : ''}
              {['failed', 'skipped', 'expired', 'cancelled'].includes(turn.status) && (
                <Btn variant="link" className="text-micro" onClick={() => onOrganize(userId)}>
                  重新整理
                </Btn>
              )}
            </p>
          )}
        </div>
      )}
      <div className="mt-1 flex gap-2 text-micro text-ink-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <span>{ago(at(m.createdAt))}</span>
      </div>
    </div>
  )
}

function OrganizePanel({
  settings,
  session,
  mine,
  pending,
  onOpen,
  onDecide,
  onClose,
  onBook,
  onEnable,
  onAuto,
}: {
  settings?: { enabled: boolean; needsModelConsent: boolean; autoOrganize: boolean; available: boolean; paused: boolean }
  session: boolean
  mine: CreativeProposal[]
  pending: CreativeProposal[]
  onOpen: (p: CreativeProposal) => void
  onDecide: (p: CreativeProposal, action: 'accept' | 'reject') => void
  onClose: () => void
  onBook: () => void
  onEnable: () => void
  onAuto: (on: boolean) => void
}) {
  const [tab, setTab] = useState<'session' | 'all'>('session')
  const list = tab === 'session' ? mine : pending
  const off = !settings?.enabled || settings.needsModelConsent
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-4 py-3">
        <span className="text-ui font-medium text-ink">灵感整理</span>
        <IconBtn icon="x" label="收起整理面板" onClick={onClose} className="ml-auto" />
      </div>
      <div className="shrink-0 px-3 pt-3">
        <Seg size="sm" label="整理范围" value={tab} onChange={setTab} options={[['session', '本次讨论'], ['all', `全部待处理${pending.length ? ` ${pending.length}` : ''}`]]} />
      </div>
      <div className="scroll min-h-0 flex-1 overflow-auto px-3 pt-3 pb-6">
        {settings && off && (
          <div className="mb-4 rounded-lg border border-line-soft bg-paper px-3.5 py-3 text-ui-sm">
            <p className="text-ink">{settings.needsModelConsent ? '模型配置已变化，需要重新确认后才能继续整理。' : '启用后，每轮讨论会被整理成待确认的设定候选。没有正文也可以开始。'}</p>
            <p className="mt-1 text-ink-3">候选不会自动成为设定；也可以在「书」里直接创建。</p>
            <Btn size="sm" variant="primary" className="mt-2" disabled={!settings.available} onClick={onEnable}>
              {settings.needsModelConsent ? '重新确认' : '启用灵感整理'}
            </Btn>
            {!settings.available && <p className="mt-1 text-micro text-warn">服务端尚未配置模型。</p>}
          </div>
        )}
        {!list.length && !off && (
          <div className="px-2 py-10 text-center">
            <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-ink-3">
              <Icon name="layers" />
            </span>
            <p className="mt-3 text-ui text-ink-2">{tab === 'session' ? (session ? '这次讨论还没有整理出内容' : '开始一段讨论吧') : '没有待处理的内容'}</p>
            <p className="mx-auto mt-1 max-w-xs text-ui-sm text-ink-3">{tab === 'session' ? '继续聊下去，人物、世界观、剧情和伏笔会在这里逐步出现。不需要每一轮都有结果。' : '所有候选都已处理。新的整理结果会出现在这里。'}</p>
          </div>
        )}
        {DESIGN_KINDS.map((k) => {
          const l = list.filter((p) => designKind(p.kind) === k)
          if (!l.length) return null
          return (
            <section key={k} className="mb-4">
              <div className="flex items-center gap-2 px-1 pb-1">
                <Heading level={3}>{designKindName[k]}</Heading>
                <span className="text-micro tabular-nums text-ink-3">{l.length}</span>
              </div>
              <ul className="space-y-1">
                {l.map((p) => {
                  const name = p.result?.name ?? p.targetName ?? '未命名'
                  return (
                    <li key={p.proposalId} className="group flex items-start gap-1 rounded-md hover:bg-surface-2">
                      <Row onClick={() => onOpen(p)} className="min-w-0 flex-1 px-2 py-2 hover:bg-transparent">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 truncate text-ui text-ink">{name}</span>
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <StatusTag status={proposalStatus(p)} />
                          {p.operation !== 'CREATE' && <span className="text-micro text-ink-3">{p.stale ? '设定已变化，需要比较' : '有新版本待比较'}</span>}
                        </span>
                      </Row>
                      {p.operation === 'CREATE' && !p.stale && (
                        <span className="flex shrink-0 gap-0.5 pt-1.5 pr-1">
                          <IconBtn size="sm" icon="check" label={`确认「${name}」`} onClick={() => onDecide(p, 'accept')} />
                          <IconBtn size="sm" icon="x" label={`否决「${name}」`} onClick={() => onDecide(p, 'reject')} />
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
      <div className="shrink-0 border-t border-line-soft px-4 py-3">
        {settings?.enabled && (
          <Choice checked={settings.autoOrganize} onChange={onAuto} className="mb-2 text-ui-sm text-ink-2">
            每轮回复后自动整理
          </Choice>
        )}
        <p className="text-micro text-ink-3">整理结果都是候选，确认后才会成为作品设定。</p>
        <Btn variant="link" className="mt-1 text-ui-sm" onClick={onBook}>
          在「书」中查看全部设定
          <Icon name="chevron" className="h-3 w-3" />
        </Btn>
      </div>
    </>
  )
}

function ProposalDrawer({
  proposal: p,
  book,
  chapters,
  onClose,
  onDecide,
  onDone,
  onSession,
}: {
  proposal: CreativeProposal
  book: string
  chapters: { id: string; title: string }[]
  onClose: () => void
  onDecide: (p: CreativeProposal, action: 'accept' | 'reject') => void
  onDone: () => void
  onSession: (sessionId: string, messageId: string) => void
}) {
  const [edit, setEdit] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !edit && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [edit, onClose])
  return (
    <>
      <div className="fade fixed inset-0 z-50 bg-scrim" onClick={onClose} aria-hidden />
      <aside aria-label="候选详情" className="slide-r fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line-soft bg-surface shadow-soft sm:max-w-drawer">
        <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-5 py-3">
          <span className="min-w-0 truncate text-ui-sm text-ink-3">{designKindName[designKind(p.kind)]} · 候选</span>
          <IconBtn icon="x" label="关闭详情" onClick={onClose} className="ml-auto" />
        </div>
        <div className="scroll min-h-0 flex-1 overflow-auto px-5 pt-5 pb-16">
          <ProposalCard proposal={p} busy={busy} onAccept={() => onDecide(p, 'accept')} onReject={() => onDecide(p, 'reject')} onEdit={() => setEdit(true)} onShowConversation={() => onSession(p.source.sessionId, p.source.messageId)} />
          <p className="mt-4 text-micro text-ink-3">来源：灵感对话 · {ago(Date.parse(p.source.capturedAt) || Date.now())} · {p.source.model.model}</p>
          {error && (
            <p role="alert" className="mt-3 text-ui-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </aside>
      {edit && (
        <AssetEditor
          title="编辑后确认"
          kind={p.kind}
          kindLocked
          showStatus={p.operation === 'CREATE'}
          initial={p.result ?? p.draft}
          chapters={chapters}
          busy={busy}
          error={error}
          submitLabel="保存并确认"
          onClose={() => setEdit(false)}
          onSubmit={async ({ content, status }) => {
            setBusy(true)
            setError('')
            try {
              await creativeApi.decide(book, [{ proposalId: p.proposalId, action: 'accept_edited', content, ...(p.operation === 'CREATE' ? { status } : {}), ...(p.stale && p.currentVersion ? { expectedVersion: p.currentVersion } : {}) }])
              setEdit(false)
              onDone()
            } catch (e) {
              setError(creativeError(e))
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
    </>
  )
}

