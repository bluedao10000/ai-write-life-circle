import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewRun } from '@writer-agent/contracts'
import { useReviewController } from '../features/reviews/useReviewController'
import type { useWorkspaceController } from '../features/workspace/useWorkspaceController'
import { createHttpWriterAgentAdapter } from '../services/httpWriterAgent'
import type { ReviewsAdapter } from '../services/api/reviewsApi'
const hash = `sha256:${'a'.repeat(64)}`
function fixture(chapterId: string, status: ReviewRun['status'] = 'completed', projectId = 'project'): ReviewRun {
  return { projectId, chapterId, revisionId: 'saved', contentHash: hash, reviewTypes: ['character_consistency'], strategyVersion: 'test-strategy',
    planHash: hash, model: { provider: 'openai-compatible', model: 'test', endpoint: 'http://localhost/v1', execution: 'local' },
    sources: [{ sourceId: chapterId, kind: 'target', projectId, chapterId, documentId: null, revisionId: 'saved', title: chapterId, path: chapterId, contentHash: hash, sourceHash: hash, excerptHash: hash, excerpt: '原文', startUTF16: 0, endUTF16: 2, freshness: 'current' }],
    contextBytes: 100, budgetBytes: 1000, excludedKnowledgeCount: 0, skippedSourceCount: 0,
    runId: `${projectId}-${chapterId}`, createdBy: 'author', version: 1, status, startedAt: '2026-10-16T00:00:00Z', completedAt: null, deadlineAt: '2026-10-16T00:01:00Z',
    findings: [], rejectedCount: 0, rejectionReasons: [], failureCode: null, stale: false, staleReasons: [], usage: null }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function workspace(chapter: string, projectId = 'project') {
  return { current: chapter, projectId, markdownByChapter: { [chapter]: '原文' }, chapterVersions: { [chapter]: { mode: 'api', revisionId: 'saved', contentHash: hash } },
    prepareReview: vi.fn(async () => ({ chapterId: chapter, revisionId: 'saved', contentHash: hash, markdown: '原文' })) } as unknown as ReturnType<typeof useWorkspaceController>
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('review requests remain bound to their original UI context', () => {
  for (const operation of ['feedback', 'cancel', 'start'] as const) {
    for (const resultKind of ['success', 'failure'] as const) {
      for (const arrival of ['before-B-list', 'after-B-list'] as const) {
        it(`${operation} ${resultKind} arriving ${arrival} cannot replace or invalidate B`, async () => {
          const a = fixture('A', operation === 'cancel' ? 'running' : 'completed'), b = fixture('B')
          const mutation = deferred<ReviewRun>(), bList = deferred<ReviewRun[]>()
          const toast = vi.fn()
          const client: ReviewsAdapter = {
            list: vi.fn((_project, chapter) => chapter === 'A' ? Promise.resolve([a]) : bList.promise),
            get: vi.fn(async () => a), preview: vi.fn(async () => a), start: vi.fn(() => mutation.promise),
            cancel: vi.fn(() => mutation.promise), feedback: vi.fn(() => mutation.promise),
          }
          const adapter = { ...createHttpWriterAgentAdapter(), reviews: client }
          const { result, rerender } = renderHook(({ chapter }) => useReviewController({ adapter, workspace: workspace(chapter), available: true, paneOpen: true, toast }), { initialProps: { chapter: 'A' } })
          await waitFor(() => expect(result.current.run?.runId).toBe(a.runId))
          if (operation === 'start') await act(async () => { await result.current.prepare() })
          let action!: Promise<unknown>
          act(() => { action = operation === 'feedback' ? result.current.feedback('finding', 'useful') : operation === 'cancel' ? result.current.cancel() : result.current.start() })
          await waitFor(() => expect(client[operation]).toHaveBeenCalledOnce())
          rerender({ chapter: 'B' })
          expect(result.current.busy).toBeNull()
          const settle = async () => {
            await act(async () => {
              if (resultKind === 'failure') mutation.reject(new Error('A operation failed'))
              else mutation.resolve({ ...a, status: operation === 'cancel' ? 'cancelled' : 'completed', version: 2 })
              const value = await action
              if (operation === 'start') expect(value).toBe(false) // No opening B's pane for A's accepted server job.
            })
          }
          if (arrival === 'before-B-list') await settle()
          await act(async () => { bList.resolve([b]) })
          await waitFor(() => expect(result.current.run?.runId).toBe(b.runId))
          if (arrival === 'after-B-list') await settle()
          expect(result.current.run?.runId).toBe(b.runId)
          expect(result.current.runs).toEqual([b])
          expect(result.current.error).toBe('')
          expect(result.current.busy).toBeNull()
          expect(result.current.plan).toBeNull()
          expect(toast).not.toHaveBeenCalled()
        })
      }
    }
  }
  it('a late A finally cannot clear B pending feedback, even after changing projects', async () => {
    const a = fixture('same'), b = fixture('same', 'completed', 'other-project')
    const pendingA = deferred<ReviewRun>(), pendingB = deferred<ReviewRun>()
    const client: ReviewsAdapter = { list: vi.fn(async project => [project === 'project' ? a : b]), get: vi.fn(async () => a),
      preview: vi.fn(async () => a), start: vi.fn(async () => a), cancel: vi.fn(async () => a),
      feedback: vi.fn(project => project === 'project' ? pendingA.promise : pendingB.promise) }
    const adapter = { ...createHttpWriterAgentAdapter(), reviews: client }, toast = vi.fn()
    const { result, rerender } = renderHook(({ project }) => useReviewController({ adapter, workspace: workspace('same', project), available: true, paneOpen: true, toast }), { initialProps: { project: 'project' } })
    await waitFor(() => expect(result.current.run?.runId).toBe(a.runId))
    let actionA!: Promise<void>, actionB!: Promise<void>
    act(() => { actionA = result.current.feedback('a', 'useful') })
    rerender({ project: 'other-project' })
    await waitFor(() => expect(result.current.run?.runId).toBe(b.runId))
    act(() => { actionB = result.current.feedback('b', 'intentional') })
    await act(async () => { pendingA.resolve({ ...a, version: 2 }); await actionA })
    expect(result.current.busy).toBe('feedback')
    expect(result.current.run?.runId).toBe(b.runId)
    await act(async () => { pendingB.resolve({ ...b, version: 2 }); await actionB })
    expect(result.current.busy).toBeNull()
    expect(result.current.run?.version).toBe(2)
    expect(toast).toHaveBeenCalledTimes(1)
  })
  it('an A → B → A switch discards the first A request', async () => {
    const a = fixture('A'), b = fixture('B'), pending = deferred<ReviewRun>()
    const client: ReviewsAdapter = { list: vi.fn(async (_p, chapter) => [chapter === 'A' ? a : b]), get: vi.fn(async () => a),
      preview: vi.fn(async () => a), start: vi.fn(async () => a), cancel: vi.fn(async () => a), feedback: vi.fn(() => pending.promise) }
    const adapter = { ...createHttpWriterAgentAdapter(), reviews: client }, toast = vi.fn()
    const { result, rerender } = renderHook(({ chapter }) => useReviewController({ adapter, workspace: workspace(chapter), available: true, paneOpen: true, toast }), { initialProps: { chapter: 'A' } })
    await waitFor(() => expect(result.current.run?.runId).toBe(a.runId))
    let action!: Promise<void>
    act(() => { action = result.current.feedback('finding', 'useful') })
    rerender({ chapter: 'B' })
    await waitFor(() => expect(result.current.run?.runId).toBe(b.runId))
    rerender({ chapter: 'A' })
    await waitFor(() => expect(result.current.run?.runId).toBe(a.runId))
    await act(async () => { pending.resolve({ ...a, version: 5 }); await action })
    expect(result.current.run?.version).toBe(1)
    expect(toast).not.toHaveBeenCalled()
  })
  it('reuses a consent session key after uncertain failure and uses a new key for an explicit rerun', async () => {
    const a = fixture('A'), toast = vi.fn()
    const start = vi.fn<ReviewsAdapter['start']>()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue(a)
    const client: ReviewsAdapter = { list: vi.fn(async () => [a]), get: vi.fn(async () => a), preview: vi.fn(async () => a),
      start, cancel: vi.fn(async () => a), feedback: vi.fn(async () => a) }
    const adapter = { ...createHttpWriterAgentAdapter(), reviews: client }
    const { result } = renderHook(() => useReviewController({ adapter, workspace: workspace('A'), available: true, paneOpen: true, toast }))
    await waitFor(() => expect(result.current.run?.runId).toBe(a.runId))
    await act(async () => { await result.current.prepare() })
    await act(async () => { expect(await result.current.start()).toBe(false) })
    await act(async () => { expect(await result.current.start()).toBe(true) })
    expect(start.mock.calls[0][3]).toBe(start.mock.calls[1][3])
    await act(async () => { await result.current.prepare() })
    await act(async () => { expect(await result.current.start()).toBe(true) })
    expect(start.mock.calls[2][3]).not.toBe(start.mock.calls[0][3])
  })

})


it('polls queued reviews and permits cancellation before a Worker claims them', async () => {
 const a=fixture('A','queued'), toast=vi.fn()
 const client: ReviewsAdapter={list:vi.fn(async()=>[a]),get:vi.fn(async()=>({...a,version:2})),preview:vi.fn(async()=>a),start:vi.fn(async()=>a),cancel:vi.fn(async()=>({...a,status:'cancelled' as const,version:3})),feedback:vi.fn(async()=>a)}
 const adapter={...createHttpWriterAgentAdapter(),reviews:client}
 const {result,unmount}=renderHook(()=>useReviewController({adapter,workspace:workspace('A'),available:true,paneOpen:true,toast}))
 await waitFor(()=>expect(result.current.run?.status).toBe('queued'))
 await waitFor(()=>expect(client.get).toHaveBeenCalled(),{timeout:2000})
 expect(toast).not.toHaveBeenCalled()
 await act(async()=>{await result.current.cancel()})
 expect(result.current.run?.status).toBe('cancelled')
 unmount()
})
