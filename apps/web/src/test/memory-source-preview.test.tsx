import { cleanup, render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import MemorySourcePreview from '../features/memory/MemorySourcePreview'

const evidence = { taskId: 'task / 1', kind: 'knowledge.extract', strategyVersion: 'v1', inputHash: 'input', completedAt: '2026-11-04T00:00:00Z' }
const chapter = { evidence, source: { type: 'chapter', chapterId: 'chapter-1', revisionId: 'revision-1', contentHash: 'hash', text: '任务执行时的旧正文。' }, truncated: false }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('loads only on demand, displays the original revision and rechecks after closing', async () => {
  const calls: string[] = []
  let missing = false
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return missing ? Response.json({ type: 'about:blank', status: 404, title: 'Unavailable', code: 'MEMORY_SOURCE_UNAVAILABLE' }, { status: 404 }) : Response.json(chapter)
  }))
  render(<MemorySourcePreview bookId="book / 1" taskId="task / 1" />)
  expect(calls).toHaveLength(0)
  await userEvent.click(screen.getByRole('button', { name: '查看任务 task / 1 的原始来源' }))
  await screen.findByText('任务执行时的旧正文。')
  expect(screen.getByText('章节 chapter-1 · 版本 revision-1')).toBeInTheDocument()
  expect(calls).toEqual(['/v1/studio/books/book%20%2F%201/procedural-memory/evidence/task%20%2F%201'])
  await userEvent.click(screen.getByRole('button', { name: '收起任务 task / 1 的原始来源' }))
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  missing = true
  await userEvent.click(screen.getByRole('button'))
  await screen.findByText('原始来源已删除或不再保留，无法预览。')
  expect(screen.queryByText('任务执行时的旧正文。')).not.toBeInTheDocument()
  expect(calls).toHaveLength(2)
})
it('keeps author and assistant roles distinct and explicitly marks truncation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ evidence, source: { type: 'discussion', sessionId: 's1', messageId: 'u1', messages: [{ messageId: 'u1', role: 'user', text: '作者原话' }, { messageId: 'a1', role: 'assistant', text: '待核实建议' }] }, truncated: true })))
  render(<MemorySourcePreview bookId="b1" taskId="t1" />)
  await userEvent.click(screen.getByRole('button'))
  await screen.findByText('作者原话')
  expect(screen.getByText('作者')).toBeInTheDocument()
  expect(screen.getByText('助手建议')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('此处仅显示开头部分')
})
it('cancels an in-flight source read when the book panel unmounts', async () => {
  let signal: AbortSignal | undefined, finish: (() => void) | undefined
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
    signal = init?.signal as AbortSignal
    return new Promise<Response>(resolve => { finish = () => resolve(Response.json(chapter)) })
  }))
  const view = render(<MemorySourcePreview bookId="old" taskId="t1" />)
  await userEvent.click(screen.getByRole('button'))
  await waitFor(() => expect(signal).toBeDefined())
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { finish?.() })
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
})
