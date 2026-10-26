import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashMarkdown } from '../lib/sourceHash'
import { createHttpWriterAgentAdapter } from '../services/httpWriterAgent'
import { readLocalChapterDraft } from '../services/localChapterDraft'
import { useWorkspaceController } from '../features/workspace/useWorkspaceController'

const projectId = 'novel-123'
const chapterId = 'CH-001'
const serverMarkdown = '作者原文。\n\n> 引用格式。\n'
const localDraftKey = `writer-agent.api-draft.v1:${projectId}:${chapterId}`

const apiWorkspace = {
  project: { projectId, title: '作者作品' },
  userState: { lastView: 'write' as const, lastChapterId: chapterId, theme: 'light' as const },
  counts: {},
  runningTasks: [],
}
const apiChapterList = {
  volumes: [{ volumeId: 'VOL-01', chapters: [{ chapterId, title: '第一章', meta: '雨夜', order: 1, wordCount: 10 }] }],
}

function apiResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers })
}

async function setupApiController(options: {
  saveResponse?: (markdown: string, request: RequestInit) => Promise<Response>
  storedDraft?: { baseRevisionId: string | null; markdown: string; contentHash?: string; idempotencyKey: string; updatedAt: string }
  workspaceLayout?: { leftOpen?: boolean; rightOpen?: boolean; leftW?: number; rightW?: number; focus?: boolean }
} = {}) {
  const contentHash = await hashMarkdown(serverMarkdown)
  if (options.storedDraft) {
    localStorage.setItem(localDraftKey, JSON.stringify({ projectId, chapterId, ...options.storedDraft }))
  }
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const path = String(input)
    if (path === `/v1/projects/${projectId}/workspace` && init.method === 'PATCH') return apiResponse(JSON.parse(String(init.body)))
    if (path === `/v1/projects/${projectId}/workspace`) return apiResponse({
      ...apiWorkspace,
      userState: options.workspaceLayout ? { ...apiWorkspace.userState, layout: options.workspaceLayout } : apiWorkspace.userState,
    })
    if (path === `/v1/projects/${projectId}/chapters`) return apiResponse(apiChapterList)
    if (path === `/v1/projects/${projectId}/chapters/${chapterId}`) {
      return apiResponse({
        chapterId, volumeId: 'VOL-01', title: '第一章', meta: '雨夜',
        headRevision: { revisionId: 'source:blob-1', parentRevisionId: null, contentHash, markdown: serverMarkdown, wordCount: 10, commitRef: null },
      })
    }
    if (path === `/v1/projects/${projectId}/chapters/${chapterId}/revisions` && init.method === 'POST') {
      const request = JSON.parse(String(init.body)) as { baseRevisionId: string | null; markdown: string }
      if (options.saveResponse) return options.saveResponse(request.markdown, init)
      const savedHash = await hashMarkdown(request.markdown)
      return apiResponse({ revisionId: 'draft:revision-2', parentRevisionId: request.baseRevisionId, contentHash: savedHash, wordCount: 12, commitRef: null }, 201)
    }
    return apiResponse({ type: 'about:blank', title: 'NOT_FOUND', status: 404, code: 'NOT_FOUND', detail: path }, 404)
  })

  const adapter = createHttpWriterAgentAdapter()
  const initialWorkspace = await adapter.loadWorkspace(projectId)
  const toast = vi.fn()
  const requestConfirm = vi.fn()
  const hook = renderHook(() => useWorkspaceController({ adapter, initialWorkspace, toast, requestConfirm }))
  await waitFor(() => expect(hook.result.current.chapterLoadState.status).toBe('loaded'))
  return { ...hook, adapter, fetchMock, toast, requestConfirm }
}

describe('API workspace chapter workflow', () => {
  it('saves present edits before restoring historical text through the same revision queue', async () => {
    const { result, fetchMock } = await setupApiController()
    act(() => result.current.onChange(['今天'], '今天'))
    await act(async () => { await result.current.restoreHistoricalText('昨日删除的一段。', 'append') })
    const writes = fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)))
    expect(writes).toEqual([
      expect.objectContaining({ markdown: '今天', baseRevisionId: 'source:blob-1' }),
      expect.objectContaining({ markdown: '今天\n\n昨日删除的一段。', baseRevisionId: 'draft:revision-2' }),
    ])
    expect(result.current.saveState.s).toBe('saved')
  })
  it.each([409, 500])('never replaces present prose if the initial save fails with %s', async (status) => {
    const { result } = await setupApiController({ saveResponse: async () => apiResponse({type:'about:blank',title:'Conflict',status,code:status===409?'REVISION_CONFLICT':'INTERNAL_ERROR'},status) })
    act(() => result.current.onChange(['保留当前'], '保留当前'))
    await act(async () => { await expect(result.current.restoreHistoricalText('历史', 'replace')).rejects.toThrow() })
    expect(result.current.markdownByChapter[chapterId]).toBe('保留当前')
  })

  beforeEach(() => localStorage.clear())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('captures a review only after saving the current exact Markdown revision', async () => {
    const { result } = await setupApiController()
    const text = '审查前作者新增内容。'
    act(() => result.current.onChange([text], text))
    let snapshot: Awaited<ReturnType<typeof result.current.prepareReview>> | undefined
    await act(async () => { snapshot = await result.current.prepareReview() })
    expect(snapshot).toMatchObject({ revisionId: 'draft:revision-2', markdown: text, contentHash: await hashMarkdown(text) })
  })

  it.each([500, 409])('refuses review when saving returns %s', async (status) => {
    const { result } = await setupApiController({ saveResponse: async () => apiResponse({ type:'about:blank',title:'Save refused',status,code:status===409?'REVISION_CONFLICT':'INTERNAL_ERROR',detail:'save failed' },status) })
    act(() => result.current.onChange(['未保存'], '未保存'))
    await act(async () => { await expect(result.current.prepareReview()).rejects.toThrow() })
    expect(result.current.markdownByChapter[chapterId]).toBe('未保存')
  })

  it('refuses review while a recoverable local draft is pending', async () => {
    const { result } = await setupApiController({ storedDraft: { baseRevisionId:'source:blob-1', markdown:'本地恢复内容',idempotencyKey:'recovery',updatedAt:new Date().toISOString() } })
    await act(async () => { await expect(result.current.prepareReview()).rejects.toThrow() })
  })

  it('refuses a snapshot if the author types again while the save is in flight', async () => {
    let resolveSave!: (response: Response) => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { started = resolve })
    const { result } = await setupApiController({ saveResponse: async () => {
      started()
      return new Promise<Response>((resolve) => { resolveSave = resolve })
    } })
    const first = '开始保存的内容', next = '保存期间又修改的内容'
    let capture!: Promise<unknown>
    act(() => { result.current.onChange([first], first); capture = result.current.prepareReview() })
    const rejected = expect(capture).rejects.toThrow()
    await gate
    act(() => result.current.onChange([next], next))
    await act(async () => {
      resolveSave(apiResponse({ revisionId:'draft:saved',parentRevisionId:'source:blob-1',contentHash:await hashMarkdown(first),commitRef:null },201))
      await rejected
    })
    expect(result.current.markdownByChapter[chapterId]).toBe(next)
  })

  it('uses the collapsed Agent panel default when the API has no saved layout', async () => {
    const { result } = await setupApiController()
    expect(result.current.layout).toMatchObject({ leftOpen: false, rightOpen: false })
  })

  it('restores an explicit API workspace layout without replacing it with defaults', async () => {
    const { result } = await setupApiController({ workspaceLayout: { leftOpen: false, rightOpen: true, rightW: 460 } })
    expect(result.current.layout).toMatchObject({ leftOpen: false, rightOpen: true, leftW: 280, rightW: 460, focus: false })
  })

  it('saves raw Markdown using the current revisionId and clears only the confirmed local draft', async () => {
    const { result, fetchMock } = await setupApiController()
    const editedMarkdown = '作者新增中文。\n\n- 条目一\n'
    act(() => result.current.onChange(['作者新增中文。', '条目一'], editedMarkdown))

    let saved = false
    await act(async () => { saved = await result.current.flushSave() })

    expect(saved).toBe(true)
    expect(result.current.saveState.s).toBe('saved')
    expect(result.current.markdownByChapter[chapterId]).toBe(editedMarkdown)
    const request = fetchMock.mock.calls.find(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST')
    expect(request).toBeDefined()
    const init = request?.[1]
    expect(JSON.parse(String(init?.body))).toMatchObject({ baseRevisionId: 'source:blob-1', markdown: editedMarkdown })
    expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^chapter-save:/)
    expect(localStorage.getItem(localDraftKey)).toBeNull()
    const version = result.current.chapterVersions[chapterId]
    expect(version).toMatchObject({ mode: 'api', revisionId: 'draft:revision-2', parentRevisionId: 'source:blob-1' })
  })

  it('retries a lost response with the same Idempotency-Key and keeps the draft until confirmation', async () => {
    let attempts = 0
    const { result, fetchMock } = await setupApiController({
      saveResponse: async (markdown) => {
        attempts++
        if (attempts === 1) throw new TypeError('network offline after request')
        const savedHash = await hashMarkdown(markdown)
        return apiResponse({ revisionId: 'draft:revision-2', parentRevisionId: 'source:blob-1', contentHash: savedHash, commitRef: null }, 201)
      },
    })
    act(() => result.current.onChange(['网络中断时仍保留的草稿。'], '网络中断时仍保留的草稿。'))

    let saved = true
    await act(async () => { saved = await result.current.flushSave() })
    expect(saved).toBe(false)
    expect(result.current.saveState).toMatchObject({ s: 'error', conflict: false })
    const preserved = readLocalChapterDraft(projectId, chapterId)
    expect(preserved?.markdown).toBe('网络中断时仍保留的草稿。')
    const firstRequest = fetchMock.mock.calls.find(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST')
    const firstKey = new Headers(firstRequest?.[1]?.headers).get('Idempotency-Key')

    await act(async () => { saved = await result.current.retrySave() })

    expect(saved).toBe(true)
    const revisionRequests = fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST')
    expect(revisionRequests).toHaveLength(2)
    expect(revisionRequests.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([firstKey, firstKey])
    expect(localStorage.getItem(localDraftKey)).toBeNull()
  })

  it('keeps a conflicting local draft and blocks automatic or manual blind retry', async () => {
    const { result, fetchMock } = await setupApiController({
      saveResponse: async () => apiResponse({
        type: 'about:blank', title: 'REVISION_CONFLICT', status: 409, code: 'REVISION_CONFLICT',
        detail: '服务器已保存其他版本。', current: { expectedRevisionId: 'source:blob-1', currentRevisionId: 'draft:other' },
      }, 409),
    })
    const editedMarkdown = '浏览器 A 的未保存文本。'
    act(() => result.current.onChange([editedMarkdown], editedMarkdown))

    let saved = true
    await act(async () => { saved = await result.current.flushSave() })
    expect(saved).toBe(false)
    expect(result.current.saveState).toMatchObject({ s: 'error', conflict: true })
    expect(result.current.markdownByChapter[chapterId]).toBe(editedMarkdown)
    expect(readLocalChapterDraft(projectId, chapterId)?.markdown).toBe(editedMarkdown)
    const attemptsBeforeRetry = fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST').length
    await act(async () => { saved = await result.current.retrySave() })
    expect(saved).toBe(false)
    const attemptsAfterRetry = fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST').length
    expect(attemptsAfterRetry).toBe(attemptsBeforeRetry)
  })

  it('stops queued and scheduled saves after an earlier save conflicts', async () => {
    let attempts = 0
    let resolveFirstResponse: ((response: Response) => void) | undefined
    let markFirstRequestStarted: (() => void) | undefined
    const firstRequestStarted = new Promise<void>((resolve) => { markFirstRequestStarted = resolve })
    const { result, fetchMock } = await setupApiController({
      saveResponse: async (markdown) => {
        attempts++
        if (attempts === 1) {
          markFirstRequestStarted?.()
          return new Promise<Response>((resolve) => { resolveFirstResponse = resolve })
        }
        const savedHash = await hashMarkdown(markdown)
        return apiResponse({ revisionId: 'draft:unexpected', parentRevisionId: 'source:blob-1', contentHash: savedHash, commitRef: null }, 201)
      },
    })
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const markdownA = '第一个保存请求。'
    const markdownB = '已经排队的第二个保存请求。'
    const latestMarkdown = '冲突期间继续编辑的最新正文。'
    let saveA!: Promise<boolean>
    act(() => {
      result.current.onChange([markdownA], markdownA)
      saveA = result.current.flushSave()
    })
    await firstRequestStarted

    let saveB!: Promise<boolean>
    act(() => {
      result.current.onChange([markdownB], markdownB)
      saveB = result.current.flushSave()
      result.current.onChange([latestMarkdown], latestMarkdown)
    })
    const pendingLatestSaveTimer = setTimeoutSpy.mock.results.at(-1)?.value as number | undefined
    expect(pendingLatestSaveTimer).toBeDefined()

    await act(async () => {
      resolveFirstResponse?.(apiResponse({
        type: 'about:blank', title: 'REVISION_CONFLICT', status: 409,
        code: 'REVISION_CONFLICT', detail: '服务器版本已变化。',
      }, 409))
      await expect(saveA).resolves.toBe(false)
      await expect(saveB).resolves.toBe(false)
    })

    const revisionRequests = fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST')
    expect(revisionRequests).toHaveLength(1)
    expect(clearTimeoutSpy).toHaveBeenCalledWith(pendingLatestSaveTimer)
    expect(result.current.markdownByChapter[chapterId]).toBe(latestMarkdown)
    expect(readLocalChapterDraft(projectId, chapterId)?.markdown).toBe(latestMarkdown)
    expect(result.current.saveState).toMatchObject({ s: 'error', conflict: true })
  })

  it('exports the in-memory Markdown when localStorage rejects a draft write', async () => {
    const { result, fetchMock } = await setupApiController()
    const draftMarkdown = '配额不足时仍可导出的完整中文草稿。\n\n> 引用也保留。'
    const originalSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === localDraftKey) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return originalSetItem.call(this, key, value)
    })

    act(() => result.current.onChange(['配额不足时仍可导出的完整中文草稿。', '引用也保留。'], draftMarkdown))
    expect(result.current.saveState).toMatchObject({ s: 'error', conflict: false })
    expect(result.current.exportLocalDraft()).toBe(draftMarkdown)

    let saved = true
    await act(async () => { saved = await result.current.flushSave() })
    expect(saved).toBe(false)
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST')).toBe(false)
    expect(result.current.exportLocalDraft()).toBe(draftMarkdown)
  })

  it('offers a stale local draft after reload without replacing the server Markdown', async () => {
    const staleMarkdown = '刷新前浏览器留下的中文草稿。'
    const { result, fetchMock } = await setupApiController({
      storedDraft: {
        baseRevisionId: 'source:older', markdown: staleMarkdown,
        idempotencyKey: 'save-before-refresh', updatedAt: new Date().toISOString(),
      },
    })

    expect(result.current.recoveryDraft).toMatchObject({ markdown: staleMarkdown, conflict: true })
    expect(result.current.saveState).toEqual({ s: 'recovery' })
    expect(result.current.markdownByChapter[chapterId]).toBe(serverMarkdown)
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST')).toBe(false)

    await act(async () => { await result.current.restoreLocalDraft() })
    expect(result.current.markdownByChapter[chapterId]).toBe(staleMarkdown)
    expect(result.current.saveState).toMatchObject({ s: 'error', conflict: true })
    expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith('/revisions') && init?.method === 'POST')).toBe(false)
  })

  it('loads saved Workspace preferences and writes changes through the Workspace PATCH adapter', async () => {
    const { result, fetchMock } = await setupApiController()
    act(() => {
      result.current.setDark(true)
      result.current.setLayout((layout) => ({ ...layout, leftOpen: false, focus: true }))
    })
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([path, init]) => String(path) === `/v1/projects/${projectId}/workspace` && init?.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({
        lastChapterId: chapterId,
        theme: 'dark',
        layout: { leftOpen: false, focus: true },
      })
    })
  })
})

it('blocks a managed structure reload until the exact current prose is saved', async () => {
  localStorage.clear()
  const { result } = await setupApiController({ saveResponse: async () => apiResponse({ type: 'about:blank', title: 'Save refused', status: 503, code: 'UNAVAILABLE', detail: 'synthetic disk failure' }, 503) })
  act(() => result.current.onChange(['不可丢失的正文'], '不可丢失的正文'))
  await act(async () => { await expect(result.current.prepareStructure()).rejects.toThrow('正文尚未安全保存') })
  expect(result.current.markdownByChapter[chapterId]).toBe('不可丢失的正文')
  cleanup()
  vi.restoreAllMocks()
})
