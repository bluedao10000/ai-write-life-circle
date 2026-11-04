import { proceduralRecordSchema } from '@writer-agent/contracts'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import ProceduralMemoryPanel from '../features/memory/ProceduralMemoryPanel'
import type { ProceduralMemory, TaskEvidence } from '../services/api/proceduralMemoryApi'

const evidence: TaskEvidence[] = ['one', 'two'].map((id, i) => ({ taskId: id, kind: 'knowledge.extract', strategyVersion: 'v1', inputHash: `input-${i}`, completedAt: '2026-11-04T00:00:00Z' }))
const candidate = (overrides: Partial<ProceduralMemory> = {}): ProceduralMemory => ({ id: 'm1', content: '先检索已有设定再整理人物。', status: 'candidate', version: 1, createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', provenance: evidence, available: false, unavailableReason: 'not_confirmed', ...overrides })
const panel = (bookId = 'b1') => <ProceduralMemoryPanel bookId={bookId} bookTitle={bookId} onSection={() => {}} />
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture(initial: ProceduralMemory[] = []) {
  let items = initial
  const posts: { url: string; body: Record<string, unknown>; key: string | null }[] = []
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ url, body, key: new Headers(init.headers).get('Idempotency-Key') })
      if (fail) { fail = false; throw Error('连接中断，请重试。') }
      if ('taskIds' in body) items = [candidate({ content: String(body.content) })]
      else items = [candidate({ version: Number(body.baseVersion) + 1, status: body.action === 'confirm' ? 'confirmed' : body.action === 'delete' ? 'deleted' : 'rejected', available: body.action === 'confirm' })]
      const record = { ...items[0] } as Partial<ProceduralMemory>
      delete record.available; delete record.unavailableReason
      return Response.json(proceduralRecordSchema.parse(record))
    }
    return Response.json(url.endsWith('/evidence') ? { items: evidence, limit: 100 } : { items })
  }))
  return { posts, failNext: () => { fail = true } }
}
it('creates from selected task receipts, confirms with current version, withdraws and deletes', async () => {
  const f = fixture(), user = userEvent.setup()
  render(panel('book / one'))
  await screen.findByText('还没有操作经验。')
  await user.type(screen.getByRole('textbox', { name: '经验内容' }), '先检索已有设定再整理人物。')
  const choices = screen.getAllByRole('checkbox')
  await user.click(choices[0]); await user.click(choices[1])
  await user.click(screen.getByRole('button', { name: '保存候选' }))
  let card = await screen.findByRole('article')
  await user.click(within(card).getByRole('button', { name: '确认经验' }))
  await screen.findByText('已确认 · 可供 AI 参考')
  card = screen.getByRole('article')
  await user.click(within(card).getByRole('button', { name: '撤回' }))
  await screen.findByText('已撤回')
  await user.click(screen.getByRole('button', { name: '删除' }))
  await waitFor(() => expect(screen.queryByRole('article')).not.toBeInTheDocument())
  expect(f.posts.map(x => x.body)).toEqual([{ content: '先检索已有设定再整理人物。', taskIds: ['one', 'two'] }, { baseVersion: 1, action: 'confirm' }, { baseVersion: 2, action: 'reject' }, { baseVersion: 3, action: 'delete' }])
  expect(f.posts[0].url).toBe('/v1/studio/books/book%20%2F%20one/procedural-memory')
  expect(new Set(f.posts.map(x => x.key)).size).toBe(4)
})
it('retains the same idempotency key on an unchanged failed submission, but changes it for edited input', async () => {
  const f = fixture(), user = userEvent.setup()
  render(panel()); await screen.findByText('还没有操作经验。')
  await user.type(screen.getByRole('textbox'), '有效方法')
  await user.click(screen.getAllByRole('checkbox')[0])
  f.failNext(); await user.click(screen.getByRole('button', { name: '保存候选' })); await screen.findByRole('alert')
  expect(screen.getByRole('textbox')).toHaveValue('有效方法')
  f.failNext(); await user.click(screen.getByRole('button', { name: '保存候选' })); await screen.findByRole('alert')
  expect(f.posts[0].key).toBe(f.posts[1].key)
  await user.type(screen.getByRole('textbox'), '补充')
  await user.click(screen.getByRole('button', { name: '保存候选' })); await screen.findByRole('article')
  expect(f.posts[2].key).not.toBe(f.posts[0].key)
})
it('does not allow confirmation with duplicate inputs, expired rules or unavailable sources', async () => {
  fixture([candidate({ provenance: evidence.map(s => ({ ...s, inputHash: 'same' })) }), candidate({ id: 'm2', unavailableReason: 'expired' }), candidate({ id: 'm3', unavailableReason: 'source_unavailable' }), candidate({ id: 'm4', provenance: [...evidence, { ...evidence[0], taskId: 'three', kind: 'review.execute', inputHash: 'third' }] })])
  render(panel()); await screen.findByText('已过期')
  for (const button of screen.getAllByRole('button', { name: '确认经验' })) expect(button).toBeDisabled()
  expect(screen.getAllByText(/来源尚不足以确认/)).toHaveLength(2)
})
it('refreshes authoritative state after a conflict without discarding unsaved content', async () => {
  let conflict = false
  const posts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { conflict = true; posts.push(JSON.parse(String(init.body))); return Response.json({ type: 'about:blank', title: 'conflict', status: 409, code: 'VERSION_CONFLICT', detail: 'conflict' }, { status: 409 }) }
    return Response.json(url.endsWith('/evidence') ? { items: evidence, limit: 100 } : { items: [candidate(conflict ? { status: 'confirmed', version: 2, available: true } : {})] })
  }))
  render(panel()); await screen.findByRole('article')
  await userEvent.type(screen.getByRole('textbox'), '尚未保存的经验')
  await userEvent.click(screen.getByRole('button', { name: '确认经验' }))
  await screen.findByText('已确认 · 可供 AI 参考')
  expect(screen.getByRole('alert')).toHaveTextContent('这条经验已更新')
  expect(screen.getByRole('textbox')).toHaveValue('尚未保存的经验')
  expect(posts).toEqual([{ baseVersion: 1, action: 'confirm' }])
})
it('isolates book state and ignores delayed responses from the previous book', async () => {
  const delayed: (() => void)[] = []
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const response = () => Response.json(url.endsWith('/evidence') ? { items: evidence, limit: 100 } : { items: [candidate({ content: url.includes('/old/') ? '旧作品经验' : '新作品经验' })] })
    if (url.includes('/old/')) return new Promise<Response>(resolve => delayed.push(() => resolve(response())))
    return Promise.resolve(response())
  }))
  const view = render(panel('old')); view.rerender(panel('new'))
  await screen.findByText('新作品经验')
  await act(async () => { delayed.forEach(resolve => resolve()) })
  expect(screen.queryByText('旧作品经验')).not.toBeInTheDocument()
})
it('demo mode neither fetches nor invents remembered experiences', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  render(<ProceduralMemoryPanel bookId="demo" bookTitle="演示" demo onSection={() => {}} />)
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByText(/连接作品后/)).toBeInTheDocument()
})

it('explains the UTF-8 content limit before allowing submission', async () => {
  const f = fixture(); render(panel()); await screen.findByText('还没有操作经验。')
  await userEvent.click(screen.getAllByRole('checkbox')[0])
  await userEvent.click(screen.getByRole('textbox')); await userEvent.paste('文'.repeat(1334))
  expect(screen.getByRole('alert')).toHaveTextContent('经验内容过长')
  expect(screen.getByRole('button', { name: '保存候选' })).toBeDisabled()
  expect(f.posts).toHaveLength(0)
})
