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
      else if (url.endsWith('/merge')) {
        const ids = (body.sources as { id: string }[]).map(s => s.id)
        const targetId = decodeURIComponent(url.split('/').at(-2)!)
        const target = items.find(item => item.id === targetId)!
        const merged = items.filter(item => item.id === targetId || ids.includes(item.id))
        const provenance = [...new Map(merged.flatMap(item => item.provenance ?? []).map(s => [s.taskId, s])).values()]
        items = [{ ...target, version: target.version + 1, provenance }, ...items.filter(item => item.id !== targetId).map(item => ids.includes(item.id) ? { ...item, status: 'rejected' as const, version: item.version + 1 } : item)]
      }
      else if (url.endsWith('/supersede')) {
        const ids = (body.replaces as { id: string }[]).map(s => s.id)
        const targetId = decodeURIComponent(url.split('/').at(-2)!)
        const target = items.find(item => item.id === targetId)!
        const updated = { ...target, status: 'confirmed' as const, available: true, unavailableReason: undefined, version: target.version + 1, supersedes: ids }
        items = [updated, ...items.filter(item => item.id !== targetId).map(item => ids.includes(item.id) ? { ...item, status: 'rejected' as const, available: false, unavailableReason: 'superseded' as const, supersededBy: targetId, version: item.version + 1 } : item)]
      }
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

it('merges identical candidates with version fences, retries idempotently and requires separate confirmation', async () => {
  const f = fixture([candidate({ provenance: [evidence[0]] }), candidate({ id: 'm2', version: 3, provenance: [evidence[1]] })])
  const user = userEvent.setup()
  render(panel('book / one'))
  await screen.findByRole('button', { name: '合并重复候选' })
  for (const button of screen.getAllByRole('button', { name: '确认经验' })) expect(button).toBeDisabled()
  await user.type(screen.getByRole('textbox'), '未保存的另一条经验')
  f.failNext()
  await user.click(screen.getByRole('button', { name: '合并重复候选' }))
  await screen.findByRole('alert')
  await user.click(screen.getByRole('button', { name: '合并重复候选' }))
  await screen.findByText('重复候选已合并，仍需你确认后才供 AI 参考。')
  expect(f.posts).toHaveLength(2)
  expect(f.posts[0].key).toBe(f.posts[1].key)
  expect(f.posts[1].url).toBe('/v1/studio/books/book%20%2F%20one/procedural-memory/m1/merge')
  expect(f.posts[1].body).toEqual({ baseVersion: 1, sources: [{ id: 'm2', baseVersion: 3 }] })
  expect(screen.getByRole('textbox')).toHaveValue('未保存的另一条经验')
  expect(screen.getByText('已撤回')).toBeInTheDocument()
  expect(screen.queryByText('已确认 · 可供 AI 参考')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '确认经验' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: '确认经验' }))
  await screen.findByText('已确认 · 可供 AI 参考')
  expect(f.posts[2].body).toEqual({ baseVersion: 2, action: 'confirm' })
})
it('does not merge nonmatching, confirmed, expired or unavailable records', async () => {
  fixture([candidate(), candidate({ id: 'different', content: '另一条经验' }), candidate({ id: 'confirmed', status: 'confirmed', available: true }), candidate({ id: 'expired', unavailableReason: 'expired' }), candidate({ id: 'missing', unavailableReason: 'source_unavailable' })])
  render(panel()); await screen.findByText('另一条经验')
  expect(screen.queryByRole('button', { name: '合并重复候选' })).not.toBeInTheDocument()
})
it('merging duplicate evidence does not enable confirmation', async () => {
  fixture([candidate({ provenance: [evidence[0]] }), candidate({ id: 'm2', provenance: [evidence[0]] })])
  render(panel()); await screen.findByRole('button', { name: '合并重复候选' })
  await userEvent.click(screen.getByRole('button', { name: '合并重复候选' }))
  await screen.findByText('重复候选已合并，仍需你确认后才供 AI 参考。')
  expect(screen.getByRole('button', { name: '确认经验' })).toBeDisabled()
  expect(screen.getAllByText('查看任务来源（1）', { selector: 'summary' })).toHaveLength(2)
})
it('explicitly replaces one active experience while preserving the draft and both history links', async () => {
  const f = fixture([
    candidate({ id: 'old', content: '人物背景先按出场顺序整理。', status: 'confirmed', version: 4, available: true, unavailableReason: undefined }),
    candidate({ id: 'new', content: '人物背景先核对当前修订，再按关系整理。' }),
  ])
  const user = userEvent.setup()
  render(panel())
  await screen.findByRole('article', { name: '人物背景先按出场顺序整理。' })
  await user.type(screen.getByRole('textbox', { name: '经验内容' }), '尚未保存的草稿')
  const replace = screen.getByRole('combobox', { name: '替代现有经验' })
  expect(screen.getByRole('button', { name: '替代并启用' })).toBeDisabled()
  await user.selectOptions(replace, 'old')
  await user.click(screen.getByRole('button', { name: '替代并启用' }))
  await screen.findByText('新经验已确认，所选旧经验已退役。')
  expect(screen.getByText('已由新经验替代')).toBeInTheDocument()
  expect(screen.getByText('已确认 · 可供 AI 参考')).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '经验内容' })).toHaveValue('尚未保存的草稿')
  expect(f.posts[0]).toMatchObject({
    url: '/v1/studio/books/b1/procedural-memory/new/supersede',
    body: { baseVersion: 1, replaces: [{ id: 'old', baseVersion: 4 }] },
  })
})
