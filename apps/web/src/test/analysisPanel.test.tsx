import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NovelAnalysisView, ThinkingMessage } from '@writer-agent/contracts'
import { AnalysisPanel } from '../features/analysis/AnalysisPanel'
import { Failure } from '../features/inspiration/Messages'
import { analysisApi } from '../services/api/analysisApi'

const analysisId = 'ana-' + 'a'.repeat(24)
const batchId = 'batch-' + 'b'.repeat(24)
const findingId = 'find-' + 'c'.repeat(24)
const entityId = 'went-' + 'd'.repeat(24)

const evidence = {
  chapterId: 'CH-000001',
  revisionId: 'draft:1',
  contentHash: 'sha256:fixture',
  quote: '林舟是医师。',
  startUTF16: 0,
  endUTF16: 6,
}

const finding = {
  findingId,
  analysisId,
  batchId,
  kind: 'character' as const,
  title: '林舟身份',
  statement: '林舟是医师。',
  confidence: 0.9,
  status: 'proposed' as const,
  entityIds: [entityId],
  evidence: [evidence],
  createdAt: 'now',
  updatedAt: 'now',
}

const entity = {
  entityId,
  bookId: 'book-a',
  kind: 'character' as const,
  name: '林舟',
  aliases: ['林大夫'],
  description: '医师',
  attributes: { 身份: '医师' },
  state: 'observed' as const,
  evidence: [evidence],
  createdAt: 'now',
  updatedAt: 'now',
}

function view(overrides: Partial<NovelAnalysisView> = {}): NovelAnalysisView {
  return {
    job: {
      analysisId,
      bookId: 'book-a',
      status: 'running',
      strategyVersion: 'novel-intelligence-v1',
      createdAt: 'now',
      updatedAt: 'now',
      progress: { total: 2, pending: 1, running: 1, completed: 0, failed: 0, stale: 0 },
      batches: [{ batchId, chapterIds: ['CH-000001'], status: 'running', phase: 'chapters', attempts: 1 }],
      synthesisStatus: 'pending',
    },
    manifest: null,
    findings: [],
    entities: [],
    ...overrides,
  }
}

const chapters = [{ id: 'CH-000001', title: '开端', no: 1 }]

afterEach(() => vi.restoreAllMocks())

describe('whole-book analysis workbench', () => {
  it('starts a job and shows batch progress', async () => {
    vi.spyOn(analysisApi, 'view').mockResolvedValue(view({ job: null }))
    vi.spyOn(analysisApi, 'create').mockResolvedValue(view())
    const onChapter = vi.fn()
    render(<AnalysisPanel bookId="book-a" chapters={chapters} onChapter={onChapter} />)
    fireEvent.click(await screen.findByRole('button', { name: '开始整书分析' }))
    await waitFor(() => expect(analysisApi.create).toHaveBeenCalledWith('book-a'))
    expect(await screen.findByText(/已完成 0 \/ 2 批/)).toBeVisible()
    expect(screen.getByRole('progressbar', { name: '整书分析完成度' })).toBeVisible()
  })

  it.each([
    ['单章', ['CH-000002']],
    ['本卷', ['CH-000001', 'CH-000002']],
  ] as const)('starts %s analysis with only the selected scope', async (scope, chapterIds) => {
    vi.spyOn(analysisApi, 'view').mockResolvedValue(view({ job: null }))
    const create = vi.spyOn(analysisApi, 'create').mockResolvedValue(view())
    render(<AnalysisPanel bookId="book-a" currentChapterId="CH-000002" chapters={[
      { id: 'CH-000001', title: '开端', volume: '上卷' },
      { id: 'CH-000002', title: '相遇', volume: '上卷' },
      { id: 'CH-000003', title: '离别', volume: '下卷' },
    ]} onChapter={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: scope }))
    fireEvent.click(screen.getByRole('button', { name: '开始整书分析' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith('book-a', chapterIds))
  })

  it('reviews candidates, opens evidence and confirms without confirming canon automatically', async () => {
    const onChapter = vi.fn()
    vi.spyOn(analysisApi, 'view').mockResolvedValue(view({ findings: [finding], entities: [entity] }))
    const decide = vi
      .spyOn(analysisApi, 'decide')
      .mockResolvedValue(
        view({ findings: [{ ...finding, status: 'author_confirmed' }], entities: [{ ...entity, state: 'author_confirmed' }] }),
      )
    render(<AnalysisPanel bookId="book-a" chapters={chapters} onChapter={onChapter} />)
    const heading = await screen.findByRole('heading', { name: '林舟身份' })
    expect(heading).toBeVisible()
    const candidate = within(heading.closest('article')!)
    expect(candidate.getByText('待确认')).toBeVisible()
    fireEvent.click(candidate.getByRole('button', { name: '查看原文' }))
    expect(onChapter).toHaveBeenCalledWith('CH-000001')
    fireEvent.change(candidate.getByRole('textbox', { name: '「林舟身份」的审阅备注' }), { target: { value: '身份已核对' } })
    fireEvent.click(candidate.getByRole('button', { name: '确认' }))
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith('book-a', findingId, 'confirm', '身份已核对'),
    )
    expect(await screen.findByText('已确认')).toBeVisible()
  })

  it('marks stale findings as needing a rerun and hides review actions', async () => {
    vi.spyOn(analysisApi, 'view').mockResolvedValue(
      view({ findings: [{ ...finding, status: 'stale' }] }),
    )
    render(<AnalysisPanel bookId="book-a" chapters={chapters} onChapter={vi.fn()} />)
    expect(await screen.findByText('正文已改 · 需重跑')).toBeVisible()
    expect(screen.queryByRole('button', { name: '确认' })).toBeNull()
    expect(screen.getByText('原文已改动 · 需重新核对')).toBeVisible()
  })

  it('shows the world model grouped by entity kind with source chapters', async () => {
    vi.spyOn(analysisApi, 'view').mockResolvedValue(view({ findings: [finding], entities: [entity] }))
    const onChapter = vi.fn()
    render(<AnalysisPanel bookId="book-a" chapters={chapters} onChapter={onChapter} />)
    fireEvent.click(await screen.findByRole('tab', { name: '世界模型 1' }))
    expect(screen.getByRole('heading', { name: '林舟' })).toBeVisible()
    expect(screen.getByText('别名：林大夫')).toBeVisible()
    expect(screen.getByText('正文观察')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '第 1 章 · 开端' }))
    expect(onChapter).toHaveBeenCalledWith('CH-000001')
  })

  it('offers the background analysis route when a Thinking turn was too large', () => {
    const onAnalyze = vi.fn()
    const message = {
      id: 'm1',
      role: 'assistant',
      status: 'failed',
      text: '',
      errorCode: 'INPUT_BUDGET_EXCEEDED',
      sources: [],
    } as unknown as ThinkingMessage
    render(
      <Failure
        m={message}
        busy={false}
        recent=""
        onResume={vi.fn()}
        onAsk={vi.fn()}
        onScopes={vi.fn()}
        onNewTopic={vi.fn()}
        onAnalyze={onAnalyze}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '转为整书后台分析' }))
    expect(onAnalyze).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/不会一次发送整本书/)).toBeVisible()
  })

  it('pauses, resumes and cancels through the job controls', async () => {
    vi.spyOn(analysisApi, 'view').mockResolvedValue(view())
    const pause = vi.spyOn(analysisApi, 'pause').mockResolvedValue(
      view({ job: { ...view().job!, status: 'paused' } }),
    )
    const resume = vi.spyOn(analysisApi, 'resume').mockResolvedValue(view())
    const cancel = vi.spyOn(analysisApi, 'cancel').mockResolvedValue(
      view({ job: { ...view().job!, status: 'cancelled' } }),
    )
    render(<AnalysisPanel bookId="book-a" chapters={chapters} onChapter={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '暂停' }))
    await waitFor(() => expect(pause).toHaveBeenCalledWith('book-a'))
    fireEvent.click(await screen.findByRole('button', { name: '继续' }))
    await waitFor(() => expect(resume).toHaveBeenCalledWith('book-a'))
    fireEvent.click(await screen.findByRole('button', { name: '取消分析' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('book-a'))
  })
})
