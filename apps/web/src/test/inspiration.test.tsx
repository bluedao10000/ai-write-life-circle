import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreativeAsset, StoryChangeReceipt, StoryContext, ThinkingMessage, ThinkingModelOption, ThinkingRun, ThinkingSession } from '@writer-agent/contracts'
import InspirationWorkspace from '../features/creative/InspirationWorkspace'
import { ModelPicker, hostNote } from '../features/inspiration/Composer'
import { AiMsg, Failure, Pending, Rich, readable } from '../features/inspiration/Messages'
import { ReviewDrawer } from '../features/inspiration/Organize'
import { useKeyboard } from '../features/inspiration/media'
import { creativeApi } from '../services/api/creativeApi'
import { ApiProblemError } from '../services/writerAgent'
import type { useStudioController } from '../features/vnext/useStudioController'

const models: ThinkingModelOption[] = [
  { modelId: 'deepseek', displayName: 'DeepSeek', provider: 'deepseek', hostedBy: 'DeepSeek', description: '开放式创意讨论', enabled: true, toolCalling: true, pointMultiplier: 1 },
  { modelId: 'gpt-oss', displayName: 'OpenAI · GPT-OSS 120B', provider: 'bedrock', hostedBy: 'Amazon Bedrock', description: '按需作品资料分析', enabled: true, toolCalling: true, pointMultiplier: 1 },
  { modelId: 'retired', displayName: 'Retired', provider: 'x', hostedBy: 'Retired', description: '已下线', enabled: false, toolCalling: false, pointMultiplier: 1 },
]
const message = (over: Partial<ThinkingMessage>): ThinkingMessage => ({ id: 'q1-answer', role: 'assistant', text: '', status: 'completed', sources: [], createdAt: new Date().toISOString(), ...over })
const run = (over: Partial<ThinkingRun> = {}): ThinkingRun => ({
  runId: '00000000-0000-4000-8000-000000000001', traceId: '00000000-0000-4000-8000-0000000000aa', messageId: 'q1', status: 'failed', stepType: 'provider',
  checkpointId: '00000000-0000-4000-8000-000000000002', epoch: 1, attempt: 1, retryCount: 0, modelCalls: 1, resumable: true, provider: 'deepseek', model: 'deepseek-flash',
  startedAt: 'now', updatedAt: 'now', durationMs: 1,
  failure: { code: 'PROVIDER_UNAVAILABLE', retryable: true, autoRecoverable: false, userAction: 'retry', contextRetained: true, mayHaveIncurredCost: true, retryMayIncurCost: true, message: '模型暂时无法完成回复，对话已保留。' },
  ...over,
})
const setWide = (wide: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width') ? wide : false, media: q, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList)

// jsdom has no layout: scrolling is a no-op here (real scrolling is covered by Playwright).
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
afterEach(() => vi.unstubAllGlobals())

describe('reply typography', () => {
  it('renders model Markdown in the Figma measure and never renders raw HTML', () => {
    const { container } = render(<Rich text={'## 三把不同的尺子\n\n1. **私德**：守信\n2. **公德**\n\n> 言必信，行必果\n\n<script>alert(1)</script><b>粗</b>'} />)
    expect(screen.getByRole('heading', { name: '三把不同的尺子' })).toBeVisible()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('blockquote')).toHaveTextContent('言必信')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })
  it('turns verified source markers into numbered references and flags unverified ones', () => {
    const src = { sourceId: 's1', chapterId: 'c', title: '第一章', revisionId: 'r', contentHash: 'h', quote: '原文', startUTF16: 0, endUTF16: 2, validity: 'current' as const }
    expect(readable(message({ text: '见[[source:s1]]与[[source:zz]]', sources: [src] }))).toBe('见［原文 1］与［未核验引用］')
    expect(readable(message({ text: '身份【s1】，普通强调【重点】，未返回的来源【zz】', sources: [src] }))).toBe('身份［原文 1］，普通强调【重点】，未返回的来源【zz】')
  })
  it('keeps tool details folded until the author asks', async () => {
    render(<Pending tool="search_knowledge" steps={[{ id: 1, tool: 'search_knowledge', done: false }]} />)
    expect(screen.getByText('正在参考作品资料：检索作品知识…')).toBeVisible()
    expect(screen.queryByRole('region', { name: '工具活动' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '查看执行详情' }))
    expect(screen.getByRole('region', { name: '工具活动' })).toBeVisible()
  })
  it('saves a completed reply as a note only through the real callback', async () => {
    const onNote = vi.fn().mockResolvedValue(undefined)
    render(<AiMsg m={message({ text: '**好人品**在于选择', modelLabel: 'DeepSeek' })} fresh={false} streaming={false} onSource={() => {}} onNote={onNote} onCopied={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: '加入创作笔记' }))
    expect(onNote).toHaveBeenCalledWith('好人品在于选择')
    expect(await screen.findByRole('button', { name: '已加入创作笔记' })).toBeDisabled()
    expect(screen.getByText('DeepSeek')).toBeVisible()
  })
})

describe('failure recovery', () => {
  const props = { busy: false, recent: '作者：张居正', onAsk: vi.fn(), onScopes: vi.fn(), onNewTopic: vi.fn() }
  it('重新尝试 resumes the same run with explicit cost consent and shows the trace on demand', async () => {
    const onResume = vi.fn()
    render(<Failure {...props} m={message({ status: 'failed', errorCode: 'PROVIDER_UNAVAILABLE' })} run={run()} onResume={onResume} />)
    expect(screen.getByText('这次回复未能完成，你的问题已保存。')).toBeVisible()
    expect(screen.getByText('模型暂时不可用，对话已保留。')).toBeVisible()
    expect(screen.getByText(/再次请求原模型，按实际用量计入 AI 点数；上次请求可能已计入/)).toBeVisible()
    expect(screen.queryByText(/PROVIDER_UNAVAILABLE/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '重新尝试' }))
    expect(onResume).toHaveBeenCalledWith({ runId: run().runId, confirmAdditionalCost: true, continuationContext: props.recent })
    await userEvent.click(screen.getByRole('button', { name: '查看详情' }))
    expect(screen.getByText(/PROVIDER_UNAVAILABLE/)).toBeVisible()
    expect(screen.getByText(run().traceId)).toBeVisible()
  })
  it('context overflow resumes with the prepared recent discussion', async () => {
    const onResume = vi.fn()
    render(<Failure {...props} m={message({ status: 'failed', errorCode: 'CONTEXT_SUMMARY_FAILED' })} run={run({ failure: { ...run().failure!, code: 'CONTEXT_OVERFLOW', userAction: 'provide_context' } })} onResume={onResume} />)
    expect(screen.queryByRole('textbox', { name: '续谈要点' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '继续回复' }))
    expect(onResume.mock.calls[0][0]).toMatchObject({ confirmAdditionalCost: true, continuationContext: props.recent })
  })
  it('stopped or unsafe runs never replay; the question returns to the composer instead', async () => {
    const onAsk = vi.fn()
    const { rerender } = render(<Failure {...props} onAsk={onAsk} m={message({ status: 'cancelled', errorCode: 'CANCELLED', text: '已收到的半句' })} run={run({ status: 'cancelled', resumable: false })} onResume={vi.fn()} />)
    expect(screen.getByText('已停止回复。')).toBeVisible()
    expect(screen.queryByRole('button', { name: '重新尝试' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '重新提问' }))
    expect(onAsk).toHaveBeenCalledOnce()
    rerender(<Failure {...props} onAsk={onAsk} m={message({ status: 'failed', errorCode: 'AUTHORIZATION_REVOKED' })} run={run({ resumable: false, failure: { ...run().failure!, code: 'AUTHORIZATION_REQUIRED', retryable: false, userAction: 'reauthorize' } })} onResume={vi.fn()} />)
    expect(screen.getByRole('button', { name: '检查 AI 资料范围' })).toBeVisible()
    expect(screen.getByText(/已经做过的步骤不能自动重来/)).toBeVisible()
  })
})

describe('model picker', () => {
  it('lists only server models, refuses unavailable ones and names the real host', async () => {
    setWide(true)
    const onPick = vi.fn()
    render(<ModelPicker models={models} value="deepseek" onPick={onPick} wide />)
    await userEvent.click(screen.getByRole('button', { name: '选择回复模型，当前为 DeepSeek' }))
    const menu = screen.getByRole('group', { name: '选择回复模型' })
    expect(within(menu).getByText('由 Amazon Bedrock 托管')).toBeVisible()
    expect(within(menu).getByRole('button', { name: /^Retired/ })).toBeDisabled()
    await userEvent.click(within(menu).getByRole('button', { name: /^OpenAI · GPT-OSS 120B/ }))
    expect(onPick).toHaveBeenCalledWith('gpt-oss')
    expect(screen.queryByRole('group', { name: '选择回复模型' })).toBeNull()
    expect(hostNote({ displayName: 'DeepSeek', hostedBy: 'DeepSeek' })).toBe('')
  })
  it('opens as a bottom sheet on phones and warns when the conversation model is gone', async () => {
    setWide(false)
    render(<ModelPicker models={models} value="old-model" onPick={() => {}} wide={false} />)
    await userEvent.click(screen.getByRole('button', { name: '选择回复模型，当前为 原模型不可用' }))
    expect(screen.getByRole('dialog', { name: '选择回复模型' })).toBeVisible()
  })
})

describe('mobile keyboard', () => {
  it('follows visualViewport so the composer stays above the soft keyboard', () => {
    const listeners: Record<string, () => void> = {}
    const vv = { height: 844, scale: 1, addEventListener: (k: string, f: () => void) => (listeners[k] = f), removeEventListener: vi.fn() }
    vi.stubGlobal('visualViewport', vv)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
    const { result, unmount } = renderHook(() => useKeyboard(true))
    expect(document.documentElement.style.getPropertyValue('--app-h')).toBe('844px')
    expect(result.current).toBe(false)
    vv.height = 500
    act(() => listeners.resize())
    expect(document.documentElement.style.getPropertyValue('--app-h')).toBe('500px')
    expect(result.current).toBe(true)
    unmount()
    expect(document.documentElement.style.getPropertyValue('--app-h')).toBe('')
  })
})

type Studio = ReturnType<typeof useStudioController>
function studio(thinking: Partial<Studio['thinking']>) {
  const t = {
    sessions: [], selected: null, session: null, models, modelChoice: 'deepseek', modelAvailable: true, model: { provider: 'deepseek' }, scopes: [], busy: false,
    outgoing: '', draft: '', error: '', modelNotice: '', tool: '', steps: [], cancellationPending: false, pendingDelivery: undefined, requestFailure: null,
    reconnecting: false, historyBusy: false, historyError: '',
    setDraft: vi.fn(), send: vi.fn(), select: vi.fn(), chooseModel: vi.fn(), cancel: vi.fn(), resume: vi.fn(), remove: vi.fn(), retryPending: vi.fn(), saveScopes: vi.fn(), loadHistory: vi.fn(), refreshSession: vi.fn(),
    ...thinking,
  }
  return {
    thinking: t, view: 'inspire', setView: vi.fn(), setBookNav: vi.fn(), toast: vi.fn(), thinkingSeed: '', setThinkingSeed: vi.fn(), ideaFocus: null, setIdeaFocus: vi.fn(),
    workspace: { projectId: 'book-a', projectTitle: '合成人物关系', prepareReview: vi.fn(), switchChapter: vi.fn() }, chapter: { title: '' }, chapters: [],
    notesEnabled: false, notes: { save: vi.fn() }, dark: false, setDark: vi.fn(),
  } as unknown as Studio
}

const storyContext = (bookId = 'book-a'): StoryContext => ({ bookId, stateVersion: 1, dialogueRecording: false, focus: null, intent: [], confirmed: [], alternatives: [], rejected: [], questions: [], recentChanges: [] })
const storyAsset = (name: string, summary: string): CreativeAsset => ({ assetId: 'ca-1', bookId: 'book-a', kind: 'character', name, aliases: [], summary, fields: [], status: 'accepted', origin: 'conversation', version: 1, createdAt: 'now', updatedAt: 'now' })
const storyReceipt = (): StoryChangeReceipt => ({ changeId: 'sc-1', sessionId: 'th-1', messageId: 'q1', createdAt: 'now', status: 'applied', changes: [{ intent: 'decide', name: '阿宁', assetId: 'ca-1', before: storyAsset('阿宁', '流亡公主'), after: { ...storyAsset('阿宁', '渔村孤女'), version: 2 } }] })

describe('灵感 workspace', () => {
  beforeEach(() => {
    vi.spyOn(creativeApi, 'overview').mockResolvedValue({ settings: { enabled: false, needsModelConsent: false, autoOrganize: false, available: false, paused: false }, counts: {}, pendingProposals: 0 } as never)
    vi.spyOn(creativeApi, 'storyContext').mockImplementation(async (bookId) => storyContext(bookId))
    vi.spyOn(creativeApi, 'changes').mockResolvedValue({ items: [] })
  })
  it('offers story starters only after the empty story loads; a starter only fills the composer', async () => {
    setWide(true)
    const s = studio({})
    render(<InspirationWorkspace studio={s} />)
    expect(screen.getByRole('heading', { name: '从哪里开始聊起？' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '一个人物' })).toBeNull()
    await userEvent.click(await screen.findByRole('button', { name: '一个人物' }))
    expect(s.thinking.setDraft).toHaveBeenCalledWith('主角叫')
    expect(s.thinking.send).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })
  it.each(['existing', 'truncated', 'unavailable'] as const)('keeps discussion suggestions when story context is %s', async (state) => {
    setWide(true)
    const context = storyContext()
    if (state === 'existing') context.confirmed = [storyAsset('阿宁', '调查记者')]
    if (state === 'truncated') context.truncated = true
    if (state === 'unavailable') vi.mocked(creativeApi.storyContext).mockRejectedValue(new Error('temporarily unavailable'))
    else vi.mocked(creativeApi.storyContext).mockResolvedValue(context)
    const s = studio({})
    await act(async () => { render(<InspirationWorkspace studio={s} />) })
    expect(screen.queryByRole('button', { name: '一个人物' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '探索一个人物的内心' }))
    expect(s.thinking.setDraft).toHaveBeenCalledWith('有个角色我还没完全想透：')
    expect(s.thinking.send).not.toHaveBeenCalled()
  })
  it.each([true, false])('shows source access by the composer and saves only selected material (wide=%s)', async (wide) => {
    setWide(wide)
    const saveScopes = vi.fn().mockResolvedValue(true)
    const s = studio({ saveScopes })
    const { rerender } = render(<InspirationWorkspace studio={s} />)
    const access = screen.getByRole('button', { name: '选择作品资料，仅限对话内容' })
    expect(access).toBeVisible()
    expect(access).toHaveTextContent('作品资料未开启')
    await userEvent.click(access)
    const dialog = screen.getByRole('dialog', { name: '本作品的 AI 资料范围' })
    const chapters = within(dialog).getByRole('checkbox', { name: /本作品已保存章节/ })
    expect(chapters).not.toBeChecked()
    await userEvent.click(chapters)
    await userEvent.click(within(dialog).getByRole('button', { name: '保存范围' }))
    expect(saveScopes).toHaveBeenCalledWith(['chapters'])
    expect(s.thinking.send).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    rerender(<InspirationWorkspace studio={studio({ scopes: ['chapters'] })} />)
    expect(screen.getByRole('button', { name: '选择作品资料，已开启 1 项作品资料' })).toBeVisible()
  })
  it('sends straight away with no consent dialog and shows the question as 正在发送 until confirmed', async () => {
    setWide(true)
    const s = studio({ draft: '我想以张居正为原型' })
    const { rerender } = render(<InspirationWorkspace studio={s} />)
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(s.thinking.send).toHaveBeenCalledWith({ text: '我想以张居正为原型' })
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<InspirationWorkspace studio={studio({ draft: '我想以张居正为原型', outgoing: '我想以张居正为原型', busy: true })} />)
    const bubble = screen.getByText('我想以张居正为原型').parentElement!
    expect(within(bubble).getByRole('status')).toHaveTextContent('正在发送…')
    // The draft stays in state for failure recovery, but is not shown twice.
    expect(screen.getByRole('textbox', { name: '说说你正在思考的问题' })).toHaveValue('')
  })
  it('restores a conversation, keeps the real model label and locks sending while it replies', async () => {
    setWide(false)
    const session = {
      sessionId: 'th-1', bookId: 'book-a', title: '张居正与好人品', createdAt: new Date().toISOString(), scopes: [], status: 'running', cursor: 2,
      usage: { input: 0, output: 0, charged: 0, incomplete: false },
      model: { modelId: 'deepseek', provider: 'deepseek', model: 'x', endpoint: 'https://x.test', protocol: 'thinking-v1', limits: { maxTurnsPerRequest: 2, maxToolCalls: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSessionTokens: 1, maxConcurrentSessions: 1, maxDurationMs: 1, maxToolResultBytes: 1 } },
      messages: [
        message({ id: 'q0', role: 'user', text: '第一问' }),
        message({ id: 'q0-answer', text: '第一答', modelLabel: 'DeepSeek' }),
        message({ id: 'q1', role: 'user', text: '第二问' }),
        message({ id: 'q1-answer', text: '正在生成的半句', status: 'running' }),
      ],
    } as ThinkingSession
    render(<InspirationWorkspace studio={studio({ selected: 'th-1', session, sessions: [session], draft: '下一问' })} />)
    expect(screen.getByText('张居正与好人品')).toBeVisible()
    expect(screen.getByText('第一答')).toBeVisible()
    expect(screen.getAllByRole('article', { name: '创作伙伴的回复' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: '停止回复' })).toBeVisible()
    expect(screen.getByRole('button', { name: /选择回复模型/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '历史会话与导航' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: '历史会话与导航' })).toBeVisible())
  })

  it('shows persisted decisions after a failed reply and undoes using a stable request key', async () => {
    setWide(true)
    const receipt = storyReceipt()
    vi.mocked(creativeApi.changes).mockResolvedValue({ items: [receipt] })
    const undo = vi.spyOn(creativeApi, 'undoChange').mockRejectedValueOnce(new Error('连接中断，请重试。')).mockImplementation(async () => {
      const undone: StoryChangeReceipt = { ...receipt, status: 'undone', undoneAt: 'now' }
      vi.mocked(creativeApi.changes).mockResolvedValue({ items: [undone] })
      return undone
    })
    const session = { sessionId: 'th-1', bookId: 'book-a', title: '阿宁的身份', status: 'failed', messages: [message({ id: 'q1', role: 'user', text: '改成渔村孤女' }), message({ status: 'failed', text: '' })], run: run() } as unknown as ThinkingSession
    render(<InspirationWorkspace studio={studio({ selected: 'th-1', session })} />)
    expect(await screen.findByText('已记下 1 项变化')).toBeVisible()
    expect(screen.getByText('设定已经保存，但回答中断。')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(screen.getByText('流亡公主')).toBeVisible()
    expect(screen.getByText('渔村孤女')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText('操作结果尚未确认，请重新读取故事记录。')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await screen.findByRole('button', { name: '撤销' })
    await userEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText('已撤销 1 项变化')).toBeVisible()
    expect(undo.mock.calls[0][2]).toBeTruthy()
    expect(undo.mock.calls[0][2]).toBe(undo.mock.calls[1][2])
  })

  it('explains later-edit undo conflicts without claiming the record was removed', async () => {
    setWide(true)
    vi.mocked(creativeApi.changes).mockResolvedValue({ items: [storyReceipt()] })
    vi.spyOn(creativeApi, 'undoChange').mockRejectedValue(new ApiProblemError('conflict', 409, 'STORY_UNDO_CONFLICT'))
    const session = { sessionId: 'th-1', bookId: 'book-a', title: '阿宁的身份', status: 'idle', messages: [message({ id: 'q1', role: 'user', text: '改成渔村孤女' }), message({ text: '已讨论。' })] } as unknown as ThinkingSession
    render(<InspirationWorkspace studio={studio({ selected: 'th-1', session })} />)
    await userEvent.click(await screen.findByRole('button', { name: '撤销' }))
    expect(await screen.findByText(/这些设定在之后的讨论中又有修改/)).toBeVisible()
    expect(screen.getByText('已记下 1 项变化')).toBeVisible()
    expect(screen.queryByText('已撤销 1 项变化')).toBeNull()
  })

  it('opts into recording with creative read access and keeps saved story when switched off', async () => {
    setWide(true)
    const saveScopes = vi.fn().mockResolvedValue(true)
    let current = { ...storyContext(), confirmed: [storyAsset('阿宁', '渔村孤女')] }
    vi.mocked(creativeApi.storyContext).mockImplementation(async () => current)
    const settings = vi.spyOn(creativeApi, 'settings').mockImplementation(async (_book, _action, value) => {
      current = { ...current, dialogueRecording: Boolean(value?.dialogueRecording) }
      return { dialogueRecording: current.dialogueRecording } as never
    })
    render(<InspirationWorkspace studio={studio({ saveScopes, scopes: ['chapters'] })} />)
    await userEvent.click(screen.getByRole('button', { name: /^当前故事/ }))
    const toggle = await screen.findByRole('switch', { name: '随聊记录设定' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(saveScopes).toHaveBeenCalledWith(['chapters', 'creative'])
    expect(settings).toHaveBeenCalledWith('book-a', 'recording', { dialogueRecording: true })
    await waitFor(() => expect(toggle).toBeEnabled())
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(settings).toHaveBeenLastCalledWith('book-a', 'recording', { dialogueRecording: false })
    expect(screen.getByText('渔村孤女')).toBeVisible()
  })

  it('enables the read-only plan pilot only through the explicit creative setting', async () => {
    const onOrchestration = vi.fn()
    const props = { proposals: [], onOpen: vi.fn(), onDecide: vi.fn(), onClose: vi.fn(), onBook: vi.fn(), onEnable: vi.fn(), onAuto: vi.fn(), onOrchestration }
    const { rerender } = render(<ReviewDrawer {...props} settings={{ enabled: true, needsModelConsent: false, autoOrganize: true, multiAgentPlanCheck: false, available: true, paused: false }} />)
    const toggle = screen.getByRole('checkbox', { name: '计划核对使用五个只读步骤' })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    expect(onOrchestration).toHaveBeenCalledWith(true)
    rerender(<ReviewDrawer {...props} settings={{ enabled: true, needsModelConsent: false, autoOrganize: true, multiAgentPlanCheck: true, available: true, paused: false }} />)
    expect(screen.getByRole('checkbox', { name: '计划核对使用五个只读步骤' })).toBeChecked()
    expect(screen.getByText(/没有工具权限/)).toBeVisible()
  })

  it('does not enable recording if the read scope was not saved', async () => {
    setWide(true)
    const settings = vi.spyOn(creativeApi, 'settings')
    render(<InspirationWorkspace studio={studio({ saveScopes: vi.fn().mockResolvedValue(false) })} />)
    await userEvent.click(screen.getByRole('button', { name: /^当前故事/ }))
    const toggle = screen.getByRole('switch', { name: '随聊记录设定' })
    await waitFor(() => expect(toggle).toBeEnabled())
    await userEvent.click(toggle)
    expect(await screen.findByText('作品设定的读取范围尚未保存，请重试。')).toBeVisible()
    expect(settings).not.toHaveBeenCalled()
    expect(toggle).not.toBeChecked()
  })

  it('ignores old-book story responses after switching books', async () => {
    setWide(true)
    const oldResolvers: Array<(value: StoryContext) => void> = []
    vi.mocked(creativeApi.storyContext).mockImplementation((bookId) => bookId === 'book-a' ? new Promise((resolve) => oldResolvers.push(resolve)) : Promise.resolve({ ...storyContext(bookId), confirmed: [{ ...storyAsset('新书人物', '新书设定'), bookId }] }))
    const { rerender } = render(<InspirationWorkspace studio={studio({})} />)
    await userEvent.click(screen.getByRole('button', { name: /^当前故事/ }))
    await waitFor(() => expect(oldResolvers.length).toBeGreaterThan(0))
    const next = studio({})
    next.workspace.projectId = 'book-b'
    rerender(<InspirationWorkspace studio={next} />)
    await userEvent.click(screen.getByRole('button', { name: /^当前故事/ }))
    expect(await screen.findByText('新书设定')).toBeVisible()
    await act(async () => oldResolvers.forEach((resolve) => resolve({ ...storyContext(), confirmed: [storyAsset('旧书人物', '旧书设定')] })))
    expect(screen.queryByText('旧书设定')).toBeNull()
    expect(screen.getByText('新书设定')).toBeVisible()
  })

  it('keeps the saved receipt under the author message when the same question resumes', async () => {
    setWide(true)
    vi.mocked(creativeApi.changes).mockResolvedValue({ items: [storyReceipt()] })
    const original = [message({ id: 'q1', role: 'user', text: '改成渔村孤女' }), message({ status: 'failed', text: '' })]
    const session = { sessionId: 'th-1', bookId: 'book-a', title: '阿宁的身份', status: 'idle', messages: original } as unknown as ThinkingSession
    const { rerender } = render(<InspirationWorkspace studio={studio({ selected: 'th-1', session })} />)
    expect(await screen.findByText('已记下 1 项变化')).toBeVisible()
    rerender(<InspirationWorkspace studio={studio({ selected: 'th-1', session: { ...session, messages: [...original, message({ id: 'q1-answer-1', text: '按这个身份继续。' })] } })} />)
    expect(screen.getAllByRole('region', { name: '本轮故事记录' })).toHaveLength(1)
    expect(screen.getByRole('region', { name: '本轮故事记录' }).closest('li')).toHaveAttribute('id', 'msg-q1')
    expect(document.getElementById('msg-q1-answer-1')).not.toHaveTextContent('已记下 1 项变化')
  })

  it('keeps the book switch on while replacing session focus with fresh context', async () => {
    setWide(true)
    let resolveNext!: (value: StoryContext) => void
    const focus = (sessionId: string, goal: string) => ({ sessionId, goal, assetIds: [], questionIds: [], updatedFromMessageId: 'q1', version: 1, updatedAt: 'now' })
    vi.mocked(creativeApi.storyContext).mockImplementation(async (_book, id) => id === 'th-1'
      ? { ...storyContext(), dialogueRecording: true, focus: focus('th-1', '明确主角动机') }
      : new Promise((resolve) => { resolveNext = resolve }))
    const first = { sessionId: 'th-1', bookId: 'book-a', title: '主角', status: 'idle', messages: [] } as unknown as ThinkingSession
    const { rerender } = render(<InspirationWorkspace studio={studio({ selected: 'th-1', session: first })} />)
    await userEvent.click(screen.getByRole('button', { name: /^当前故事/ }))
    expect(await screen.findByText('明确主角动机')).toBeVisible()
    rerender(<InspirationWorkspace studio={studio({ selected: 'th-2', session: null })} />)
    const toggle = screen.getByRole('switch', { name: '随聊记录设定' })
    expect(toggle).toBeChecked()
    expect(toggle).toBeDisabled()
    expect(screen.queryByText('明确主角动机')).toBeNull()
    await waitFor(() => expect(resolveNext).toBeDefined())
    await act(async () => resolveNext({ ...storyContext(), dialogueRecording: true, focus: focus('th-2', '讨论结局代价') }))
    expect(await screen.findByText('讨论结局代价')).toBeVisible()
    expect(toggle).toBeChecked()
    expect(toggle).toBeEnabled()
  })

  it('shows a refresh failure outside the drawer and reloads durable receipts on retry', async () => {
    setWide(true)
    vi.mocked(creativeApi.changes).mockResolvedValue({ items: [storyReceipt()] })
    const original = [message({ id: 'q1', role: 'user', text: '改成渔村孤女' }), message({ text: '按这个身份继续。' })]
    const session = { sessionId: 'th-1', bookId: 'book-a', title: '阿宁的身份', status: 'idle', messages: original } as unknown as ThinkingSession
    const { rerender } = render(<InspirationWorkspace studio={studio({ selected: 'th-1', session })} />)
    expect(await screen.findByText('已记下 1 项变化')).toBeVisible()
    vi.mocked(creativeApi.changes).mockRejectedValueOnce(new Error('failed to fetch'))
    rerender(<InspirationWorkspace studio={studio({ selected: 'th-1', session: { ...session, messages: [...original, message({ id: 'q2', role: 'user', text: '再聊动机' })] } })} />)
    expect(await screen.findByText('故事记录暂时无法更新，当前显示上次读取的内容。')).toBeVisible()
    expect(screen.getByText('已记下 1 项变化')).toBeVisible()
    vi.mocked(creativeApi.changes).mockResolvedValue({ items: [{ ...storyReceipt(), status: 'undone' }] })
    await userEvent.click(screen.getByRole('button', { name: '重新读取故事' }))
    expect(await screen.findByText('已撤销 1 项变化')).toBeVisible()
    expect(screen.queryByText('故事记录暂时无法更新，当前显示上次读取的内容。')).toBeNull()
  })

  it('explains a partial story context without suggesting the story is empty', async () => {
    setWide(true)
    vi.mocked(creativeApi.storyContext).mockResolvedValue({ ...storyContext(), truncated: true })
    render(<InspirationWorkspace studio={studio({})} />)
    await userEvent.click(screen.getByRole('button', { name: /^当前故事/ }))
    expect(await screen.findByText('这里只展示相关内容，可到设定页查看全部。')).toBeVisible()
    expect(screen.queryByText('从一个想法开始聊，逐步确定故事方向、人物和还待解决的问题。')).toBeNull()
  })

  it('keeps dock preference per book and leaves mobile sheets closed on entry', async () => {
    setWide(true)
    const first = render(<InspirationWorkspace studio={studio({})} />)
    await userEvent.click(screen.getByRole('button', { name: /^当前故事/ }))
    expect(localStorage.getItem('story2u.idea.story.book-a')).toBe('1')
    first.unmount()
    const next = studio({}); next.workspace.projectId = 'book-b'
    const second = render(<InspirationWorkspace studio={next} />)
    expect(screen.queryByRole('complementary', { name: '当前故事' })).toBeNull()
    second.unmount()
    const restored = render(<InspirationWorkspace studio={studio({})} />)
    expect(screen.getByRole('complementary', { name: '当前故事' })).toBeVisible()
    restored.unmount()
    setWide(false)
    render(<InspirationWorkspace studio={studio({})} />)
    expect(screen.queryByRole('dialog', { name: '当前故事' })).toBeNull()
  })

  it.each(['failed', 'unknown'] as const)('offers a draft-only continuation when %s recording has no receipt or resumable run', async (status) => {
    setWide(true)
    const session = { sessionId: 'th-1', bookId: 'book-a', title: '记录', status: 'idle', messages: [message({ id: 'q1', role: 'user', text: '主角改成记者', storyRecording: { status, changeCount: 1 } }), message({ text: '我们接着聊。' })] } as unknown as ThinkingSession
    const s = studio({ selected: 'th-1', session })
    render(<InspirationWorkspace studio={s} />)
    const continuation = await screen.findByRole('button', { name: status === 'failed' ? '调整后继续讨论' : '继续讨论这次记录' })
    await userEvent.click(continuation)
    expect(s.thinking.setDraft).toHaveBeenCalledWith(expect.stringContaining('主角改成记者'))
    expect(s.thinking.send).not.toHaveBeenCalled()
    expect(s.thinking.resume).not.toHaveBeenCalled()
  })
})
