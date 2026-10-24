import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { RunReviewRequest, RunReviewResponse } from '@writer-agent/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoWriterAgentAdapter } from '../mocks/demoWriterAgent'
import { chapters, initialDoc, knowledge } from '../mocks/demoData'
import { hashMarkdown } from '../lib/sourceHash'
import { plainParagraphsToMarkdown } from '../lib/manuscriptMarkdown'
import { useWorkspaceController } from '../features/workspace/useWorkspaceController'

const projectId = 'demo-project'

async function setupController() {
  const adapter = createDemoWriterAgentAdapter({ chapters, knowledge, document: initialDoc })
  const initialWorkspace = await adapter.loadWorkspace(projectId)
  const toast = vi.fn()
  const requestConfirm = vi.fn()
  const hook = renderHook(() => useWorkspaceController({ adapter, initialWorkspace, toast, requestConfirm }))
  return { ...hook, adapter, toast, initialWorkspace }
}

function reviewResponse(input: RunReviewRequest, overrides: Partial<RunReviewResponse> = {}): RunReviewResponse {
  return {
    projectId: input.projectId,
    chapterId: input.chapterId,
    revision: input.revision,
    sourceHash: input.sourceHash,
    reviewRunId: input.reviewRunId,
    proposals: [],
    demo: true,
    coverage: { requestedScopes: input.scope, completedScopes: input.scope, complete: true },
    evidenceValidation: { status: 'valid', unresolved: [] },
    ...overrides,
  }
}

async function completeReview(result: { current: ReturnType<typeof useWorkspaceController> }) {
  vi.useFakeTimers()
  await act(async () => { await result.current.runReview() })
  await act(async () => { await vi.advanceTimersByTimeAsync(520 * 5) })
  vi.useRealTimers()
  await waitFor(() => expect(result.current.task.state).toBe('done'))
}

describe('workspace save and review version safety', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('starts first-use Demo workspaces with the Agent panel collapsed', async () => {
    const { result } = await setupController()
    expect(result.current.layout).toMatchObject({ leftOpen: false, rightOpen: false })
  })

  it('restores an explicitly saved Demo layout preference', async () => {
    localStorage.setItem('writer-agent.v2', JSON.stringify({ layout: { leftOpen: false, rightOpen: true, leftW: 300, rightW: 420, focus: false } }))
    const { result } = await setupController()
    expect(result.current.layout).toMatchObject({ leftOpen: false, rightOpen: true, leftW: 300, rightW: 420 })
  })

  it('keeps failed edits dirty and lets the author retry after a transient save failure', async () => {
    const { result, adapter, toast } = await setupController()
    const saveSuccessfully = adapter.saveChapter.bind(adapter)
    const save = vi.spyOn(adapter, 'saveChapter')
      .mockRejectedValueOnce(new Error('network offline'))
      .mockImplementationOnce(saveSuccessfully)

    act(() => result.current.onChange(['作者本次明确修改的正文。']))
    expect(result.current.saveState.s).toBe('dirty')
    expect(result.current.doc.c12).toEqual(['作者本次明确修改的正文。'])

    let saved = true
    await act(async () => { saved = await result.current.flushSave() })
    expect(saved).toBe(false)
    expect(result.current.saveState).toMatchObject({ s: 'error', conflict: false })
    expect(result.current.doc.c12).toEqual(['作者本次明确修改的正文。'])
    expect(toast).toHaveBeenCalledWith('network offline')

    await act(async () => { saved = await result.current.retrySave() })
    expect(saved).toBe(true)
    expect(result.current.saveState.s).toBe('saved')
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('flushes the chapter being left before saving edits to the next chapter', async () => {
    const { result, adapter } = await setupController()
    const requests: Array<{ projectId: string; chapterId: string; revision: number; sourceHash: string }> = []
    vi.spyOn(adapter, 'saveChapter').mockImplementation(async (input) => {
      requests.push(input)
      return { projectId: input.projectId, chapterId: input.chapterId, revision: input.revision + 1, sourceHash: input.sourceHash, savedAt: Date.now() }
    })

    act(() => result.current.onChange(['第十二章的快速切换修改。']))
    act(() => result.current.switchChapter('c13'))
    await act(async () => { await result.current.flushSave('c12') })
    expect(requests.map((request) => request.chapterId)).toContain('c12')
    expect(result.current.doc.c12).toEqual(['第十二章的快速切换修改。'])

    act(() => result.current.onChange(['第十三章的后续修改。']))
    await act(async () => { await result.current.flushSave() })
    expect(requests.map((request) => request.chapterId)).toEqual(['c12', 'c13'])
    expect(requests.every((request) => request.projectId === projectId && request.sourceHash.startsWith('sha256:'))).toBe(true)
  })

  it('does not start a review if the author cancels while the required save is pending', async () => {
    const { result, adapter } = await setupController()
    let resolveSave!: (value: { projectId: string; chapterId: string; revision: number; sourceHash: string; savedAt: number }) => void
    vi.spyOn(adapter, 'saveChapter').mockImplementation(() => new Promise((resolve) => {
      resolveSave = resolve
    }))
    const runReview = vi.spyOn(adapter, 'runReview')

    act(() => result.current.onChange(['保存完成前取消审查。']))
    let review!: Promise<void>
    act(() => { review = result.current.runReview() })
    await waitFor(() => expect(resolveSave).toBeTypeOf('function'))
    act(() => result.current.cancelReview())

    await act(async () => {
      resolveSave({ projectId, chapterId: 'c12', revision: 1, sourceHash: await hashMarkdown(plainParagraphsToMarkdown(['保存完成前取消审查。'])), savedAt: Date.now() })
      await review
    })

    expect(runReview).not.toHaveBeenCalled()
    expect(result.current.task.state).toBe('idle')
  })

  it('discards a review result when the chapter changes while the review is running', async () => {
    vi.useFakeTimers()
    const { result, adapter } = await setupController()
    let resolveReview!: (value: RunReviewResponse) => void
    const pending = new Promise<RunReviewResponse>((resolve) => { resolveReview = resolve })
    const runReview = vi.spyOn(adapter, 'runReview').mockReturnValue(pending)

    await act(async () => { await result.current.runReview() })
    await act(async () => { await vi.advanceTimersByTimeAsync(520 * 5) })
    expect(runReview).toHaveBeenCalledTimes(1)
    const request = runReview.mock.calls[0][0]

    act(() => result.current.onChange([...request.paragraphs, '审查期间作者继续写下的新段落。']))
    vi.useRealTimers()
    await act(async () => { resolveReview(reviewResponse(request)) })

    await waitFor(() => expect(result.current.task).toMatchObject({ state: 'failed', error: expect.stringContaining('旧结果已丢弃') }))
    expect(result.current.proposals).toHaveLength(0)
  })

  it('blocks adopting an old review proposal after the prose has changed', async () => {
    vi.useFakeTimers()
    const { result, toast } = await setupController()
    await completeReview(result)
    const proposal = result.current.proposals.find((item) => item.origin === '审查')!
    expect(proposal.sourceHash).toBeTruthy()

    act(() => result.current.onChange([...result.current.doc.c12, '作者在复审后新增的内容。']))
    await act(async () => { await result.current.decide(proposal.id, 'adopt') })

    expect(result.current.proposals.find((item) => item.id === proposal.id)?.status).toBe('pending')
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('已阻止采纳'))
  })

  it('does not resolve an existing finding just because a later review omits it', async () => {
    vi.useFakeTimers()
    const { result, adapter } = await setupController()
    const runOnce = adapter.runReview.bind(adapter)
    vi.spyOn(adapter, 'runReview')
      .mockImplementationOnce((input) => runOnce(input))
      .mockImplementationOnce(async (input) => ({ ...await runOnce(input), proposals: [] }))

    await completeReview(result)
    const firstRunFindings = result.current.proposals.filter((item) => item.origin === '审查')
    expect(firstRunFindings.length).toBeGreaterThan(0)
    expect(firstRunFindings.every((item) => item.status === 'pending')).toBe(true)

    await completeReview(result)
    expect(result.current.proposals.filter((item) => item.origin === '审查').every((item) => item.status !== 'resolved')).toBe(true)
    expect(result.current.decisions.some((decision) => decision.action === '复审：已解决')).toBe(false)
  })

  it('binds the review request to the exact chapter revision hash', async () => {
    const { initialWorkspace } = await setupController()
    const hash = await hashMarkdown(initialWorkspace.markdownByChapter?.c12 ?? plainParagraphsToMarkdown(initialWorkspace.document.c12))
    const version = initialWorkspace.chapterVersions.c12
    expect(version.mode).toBe('demo')
    if (version.mode === 'demo') {
      expect(version.sourceHash).toBe(hash)
      expect(version.revision).toBe(0)
    }
  })

  it('reports historical pending issues instead of "未发现问题" when a later review returns nothing', async () => {
    vi.useFakeTimers()
    const { result, adapter } = await setupController()
    const runOnce = adapter.runReview.bind(adapter)
    vi.spyOn(adapter, 'runReview')
      .mockImplementationOnce((input) => runOnce(input))
      .mockImplementationOnce(async (input) => ({ ...await runOnce(input), proposals: [] }))

    await completeReview(result)
    const pendingBefore = result.current.proposals.filter((item) => item.status === 'pending').length
    expect(pendingBefore).toBeGreaterThan(0)

    await completeReview(result)
    expect(result.current.task).toMatchObject({ state: 'done', summary: expect.stringContaining('此前的发现等待判断') })
    expect(result.current.task).toMatchObject({ state: 'done', summary: expect.not.stringContaining('未发现问题') })
  })

  it('flags incomplete coverage instead of claiming the chapter is clean', async () => {
    vi.useFakeTimers()
    const { result, adapter } = await setupController()
    const runOnce = adapter.runReview.bind(adapter)
    vi.spyOn(adapter, 'runReview').mockImplementation(async (input) => ({
      ...await runOnce(input),
      proposals: [],
      coverage: { requestedScopes: input.scope, completedScopes: ['timeline'], complete: false },
    }))

    await completeReview(result)
    expect(result.current.task).toMatchObject({ state: 'done', summary: expect.stringContaining('本次仅完成部分检查') })
  })

  it('flags unverified evidence instead of reporting a clean chapter', async () => {
    vi.useFakeTimers()
    const { result, adapter } = await setupController()
    const runOnce = adapter.runReview.bind(adapter)
    vi.spyOn(adapter, 'runReview').mockImplementation(async (input) => ({
      ...await runOnce(input),
      proposals: [],
      evidenceValidation: { status: 'partial', unresolved: [] },
    }))

    await completeReview(result)
    expect(result.current.task).toMatchObject({ state: 'done', summary: expect.stringContaining('部分证据未核验') })
  })

  it('discards a result whose revision does not match the submitted chapter version', async () => {
    vi.useFakeTimers()
    const { result, adapter } = await setupController()
    const runOnce = adapter.runReview.bind(adapter)
    vi.spyOn(adapter, 'runReview').mockImplementation(async (input) => ({
      ...await runOnce(input),
      revision: input.revision + 1,
    }))

    await act(async () => { await result.current.runReview() })
    await act(async () => { await vi.advanceTimersByTimeAsync(520 * 5) })
    vi.useRealTimers()
    await waitFor(() => expect(result.current.task.state).toBe('failed'))
    expect(result.current.task).toMatchObject({ state: 'failed', error: expect.stringContaining('版本不匹配') })
  })
})
