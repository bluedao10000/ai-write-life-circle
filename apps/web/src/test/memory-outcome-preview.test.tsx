import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import MemoryOutcomePreview from '../features/memory/MemoryOutcomePreview'

const evidence = { taskId: 't1', kind: 'review.execute', strategyVersion: 'v1', inputHash: 'input', completedAt: '2026-11-04T00:00:00Z' }
const result = { evidence, basis: 'task_result', version: `sha256:${'a'.repeat(64)}`, items: [{ id: 'r1', kind: 'review_finding', status: 'proposed', text: '需要核对前后动机。', feedback: 'false_positive' }], total: 1, truncated: false }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('loads current feedback only on demand and refreshes after closing', async () => {
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async () => { reads++; return Response.json({ ...result, items: [{ ...result.items[0], feedback: reads === 1 ? 'false_positive' : 'useful' }] }) }))
  render(<MemoryOutcomePreview bookId="b1" taskId="t1" />)
  expect(reads).toBe(0)
  await userEvent.click(screen.getByRole('button', { name: '查看关联结果' }))
  await screen.findByText('作者标记误报')
  expect(screen.getByText('审查发现 · 待确认')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '收起关联结果' }))
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '查看关联结果' }))
  await screen.findByText('作者认为有帮助')
  expect(reads).toBe(2)
})
it('distinguishes revision observations, stale state and partial output', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...result, basis: 'revision_observations', items: [{ id: 'a1', kind: 'knowledge_observation', status: 'stale', text: '原始观察', epistemic: 'inference' }], total: 25, truncated: true })))
  render(<MemoryOutcomePreview bookId="b1" taskId="t1" />)
  await userEvent.click(screen.getByRole('button'))
  await screen.findByText('与该原文版本关联的知识观察。')
  expect(screen.getByText('知识观察 · 来源或版本已变化')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('仅显示部分内容')
  expect(screen.getByText('推断')).toBeInTheDocument()
})
it('does not replace unavailable results with an empty successful history', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'about:blank', title: 'Unavailable', status: 404, code: 'MEMORY_SOURCE_UNAVAILABLE' }, { status: 404 })))
  render(<MemoryOutcomePreview bookId="b1" taskId="t1" />)
  await userEvent.click(screen.getByRole('button'))
  await screen.findByText('来源或结果记录已不可用。')
  expect(screen.queryByText('未保留可展示的关联结果。')).not.toBeInTheDocument()
})
