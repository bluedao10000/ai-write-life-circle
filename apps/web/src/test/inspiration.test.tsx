import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThinkingMessage, ThinkingModelOption, ThinkingRun, ThinkingSession } from '@writer-agent/contracts'
import InspirationWorkspace from '../features/creative/InspirationWorkspace'
import { ModelPicker, hostNote } from '../features/inspiration/Composer'
import { AiMsg, Failure, Pending, Rich, readable } from '../features/inspiration/Messages'
import { useKeyboard } from '../features/inspiration/media'
import { creativeApi } from '../services/api/creativeApi'
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
    setDraft: vi.fn(), send: vi.fn(), select: vi.fn(), chooseModel: vi.fn(), cancel: vi.fn(), resume: vi.fn(), remove: vi.fn(), retryPending: vi.fn(), saveScopes: vi.fn(), loadHistory: vi.fn(),
    ...thinking,
  }
  return {
    thinking: t, view: 'inspire', setView: vi.fn(), setBookNav: vi.fn(), toast: vi.fn(), thinkingSeed: '', setThinkingSeed: vi.fn(), ideaFocus: null, setIdeaFocus: vi.fn(),
    workspace: { projectId: 'book-a', projectTitle: '合成人物关系', prepareReview: vi.fn(), switchChapter: vi.fn() }, chapter: { title: '' }, chapters: [],
    notesEnabled: false, notes: { save: vi.fn() }, dark: false, setDark: vi.fn(),
  } as unknown as Studio
}

describe('灵感 workspace', () => {
  beforeEach(() => {
    vi.spyOn(creativeApi, 'overview').mockResolvedValue({ settings: { enabled: false, needsModelConsent: false, autoOrganize: false, available: false, paused: false }, counts: {}, pendingProposals: 0 } as never)
  })
  it('lands on the Figma question page; a starter only fills the composer', async () => {
    setWide(true)
    const s = studio({})
    render(<InspirationWorkspace studio={s} />)
    expect(screen.getByRole('heading', { name: '从哪里开始聊起？' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '探索一个人物的内心' }))
    expect(s.thinking.setDraft).toHaveBeenCalledWith('有个角色我还没完全想透：')
    expect(s.thinking.send).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
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
})
