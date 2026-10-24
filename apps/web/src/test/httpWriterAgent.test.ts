import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHttpWriterAgentAdapter } from '../services/httpWriterAgent'
import { ApiProblemError } from '../services/writerAgent'

const contentHash = `sha256:${'a'.repeat(64)}`
const workspace = {
  project: { projectId: 'novel-123', title: '作者作品' },
  userState: {
    lastView: 'write' as const,
    lastChapterId: 'CH-001',
    layout: { leftOpen: false, rightOpen: true, leftW: 260, rightW: 400, focus: true },
    theme: 'dark' as const,
  },
  counts: {},
  runningTasks: [],
}
const chapterList = {
  volumes: [{ volumeId: 'VOL-01', title: '第一卷', chapters: [{ chapterId: 'CH-001', title: '第一章', meta: '雨夜', order: 4, wordCount: 18 }] }],
}

describe('V0.4 HTTP adapter', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('loads Workspace and ChapterList through implemented V0.4 paths and maps them without Demo data', async () => {
    localStorage.setItem('writer-agent.v2', JSON.stringify({ doc: { 'CH-001': ['演示正文'] } }))
    const storageRead = vi.spyOn(Storage.prototype, 'getItem')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(workspace), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(chapterList), { status: 200 }))

    const adapter = createHttpWriterAgentAdapter()
    const loaded = await adapter.loadWorkspace('novel-123')

    expect(adapter.mode).toBe('api')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/v1/projects/novel-123/workspace',
      '/v1/projects/novel-123/chapters',
    ])
    expect(storageRead).not.toHaveBeenCalled()
    expect(loaded).toMatchObject({
      projectId: 'novel-123',
      projectTitle: '作者作品',
      currentChapterId: 'CH-001',
      chapters: [{ id: 'CH-001', volume: '第一卷', title: '第一章', meta: '雨夜', wordCount: 18 }],
      document: {},
      markdownByChapter: {},
      chapterVersions: {},
      preferences: { theme: 'dark', lastChapterId: 'CH-001', layout: { leftOpen: false, focus: true } },
      knowledge: [], proposals: [], decisions: [], chat: [], challenge: [],
    })
  })

  it('loads ChapterDetail as exact Markdown with an opaque revisionId', async () => {
    const detail = {
      chapterId: 'CH-001', volumeId: 'VOL-01', title: '第一章', meta: '雨夜',
      headRevision: {
        revisionId: 'source:git-blob-abc', parentRevisionId: null, contentHash,
        markdown: '作者原文\n\n> 引用格式。\n', wordCount: 8, commitRef: null,
      },
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(detail), { status: 200 }))

    const loaded = await createHttpWriterAgentAdapter().loadChapter('novel-123', 'CH-001')

    expect(fetchMock).toHaveBeenCalledWith('/v1/projects/novel-123/chapters/CH-001', expect.any(Object))
    expect(loaded.headRevision).toMatchObject({ revisionId: 'source:git-blob-abc', markdown: '作者原文\n\n> 引用格式。\n' })
  })

  it('sends the V0.4 revision payload and stable idempotency key', async () => {
    const saved = { revisionId: 'draft:uuid-2', parentRevisionId: 'source:blob-1', contentHash, wordCount: 8, commitRef: null }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(saved), { status: 201 }))
    const adapter = createHttpWriterAgentAdapter()

    const response = await adapter.saveChapterRevision({
      projectId: 'novel-123', chapterId: 'CH-001', idempotencyKey: 'save-key-1',
      revision: { baseRevisionId: 'source:blob-1', markdown: '新内容', trigger: 'autosave' },
    })

    expect(response.revisionId).toBe('draft:uuid-2')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(path).toBe('/v1/projects/novel-123/chapters/CH-001/revisions')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ baseRevisionId: 'source:blob-1', markdown: '新内容', trigger: 'autosave' }),
    })
    expect(headers.get('Idempotency-Key')).toBe('save-key-1')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('surfaces 409 Problem Details without changing the opaque base revision', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      type: 'about:blank', title: 'REVISION_CONFLICT', status: 409, code: 'REVISION_CONFLICT',
      detail: '服务器版本已更新。', requestId: 'request-conflict-1',
      current: { expectedRevisionId: 'source:old', currentRevisionId: 'draft:new' },
    }), { status: 409, headers: { 'x-request-id': 'request-conflict-1' } }))

    await expect(createHttpWriterAgentAdapter().saveChapterRevision({
      projectId: 'novel-123', chapterId: 'CH-001', idempotencyKey: 'stale-save',
      revision: { baseRevisionId: 'source:old', markdown: '本地草稿' },
    })).rejects.toMatchObject({
      code: 'REVISION_CONFLICT', currentRevisionId: 'draft:new', requestId: 'request-conflict-1',
      message: '服务器版本已更新。',
    })
  })

  it('persists only Workspace preferences and does not call unimplemented Agent endpoints', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(workspace.userState), { status: 200 }))
    const adapter = createHttpWriterAgentAdapter()
    const state = { lastChapterId: 'CH-001', theme: 'dark' as const, layout: { leftOpen: false, rightOpen: false, leftW: 248, rightW: 380, focus: false } }

    await adapter.updateWorkspaceState('novel-123', state)
    expect(fetchMock).toHaveBeenCalledWith('/v1/projects/novel-123/workspace', expect.objectContaining({ method: 'PATCH' }))
    await expect(adapter.runReview({
      projectId: 'novel-123', chapterId: 'CH-001', paragraphs: [], markdown: '', revision: 0,
      sourceHash: contentHash, reviewRunId: 'review-1', scope: ['timeline'], sequence: 0,
    })).rejects.toThrow('尚未接入 V0.4 API')
    await expect(adapter.sendMessage({ projectId: 'novel-123', chapterId: 'CH-001', text: '你好' })).rejects.toThrow('尚未接入 V0.4 API')
    await expect(adapter.challenge({ projectId: 'novel-123', intent: '保持人物一致', previousRounds: [] })).rejects.toThrow('尚未接入 V0.4 API')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports non-conflict Problem Details with status and request ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      type: 'about:blank', title: 'VALIDATION_FAILED', status: 422, code: 'VALIDATION_FAILED',
      detail: '无效请求。', requestId: 'request-invalid-1',
    }), { status: 422 }))

    await expect(createHttpWriterAgentAdapter().loadWorkspace('novel-123')).rejects.toBeInstanceOf(ApiProblemError)
  })
})
