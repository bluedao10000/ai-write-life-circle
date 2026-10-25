import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreativeProposal } from '@writer-agent/contracts'
import ProposalCard from '../features/creative/ProposalCard'
import ProposalList from '../features/creative/ProposalList'
import { diffContent } from '../features/creative/labels'
import { readCompose, readView } from '../features/vnext/useStudioController'

const model = { provider: 'openai-compatible', model: 'fixture', endpoint: 'https://example.test', execution: 'external' }
const source = { type: 'conversation' as const, sessionId: 'th-00000000-0000-4000-8000-000000000001', messageId: 'm1', answerId: 'm1-answer', bookId: 'b1', capturedAt: '2026-10-25T00:00:00.000Z', excerptHash: 'sha256:x', model, strategy: 'creative-organize-v1' }
function proposal(overrides: Partial<CreativeProposal> = {}): CreativeProposal {
  return {
    proposalId: 'cp-1', bookId: 'b1', changeSetId: 'cs-1', operation: 'CREATE', kind: 'character', stance: 'author_decision', exploratory: false,
    status: 'proposed', reason: '作者确定了主角', evidence: [{ messageId: 'm1', role: 'user', quote: '主角叫林舟' }], source, createdAt: '2026-10-25T00:00:00.000Z',
    stale: false, draft: { name: '林舟', aliases: [], summary: '', fields: [{ key: '身份', value: '看守人' }] },
    result: { name: '林舟', aliases: [], summary: '', fields: [{ key: '身份', value: '看守人' }] },
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('creative proposals', () => {
  it('diffs fields so negated settings are visible before acceptance', () => {
    const changes = diffContent(
      { name: '阿宁', aliases: [], summary: '', fields: [{ key: '身份', value: '流亡公主' }, { key: '年龄', value: '十七' }] },
      { name: '阿宁', aliases: [], summary: '', fields: [{ key: '身份', value: '渔村孤女' }] },
    )
    expect(changes).toEqual([{ key: '身份', before: '流亡公主', after: '渔村孤女' }, { key: '年龄', before: '十七' }])
  })

  it('labels AI suggestions, alternatives, evidence speakers and stale proposals', () => {
    const onAccept = vi.fn()
    render(
      <ProposalCard
        proposal={proposal({ stance: 'ai_suggestion', exploratory: true, alternativeGroup: 'cs-1:结局', stale: true, operation: 'UPDATE', targetName: '林舟', current: { name: '林舟', aliases: [], summary: '', fields: [{ key: '身份', value: '看守人' }] }, result: { name: '林舟', aliases: [], summary: '', fields: [{ key: '身份', value: '退役水手' }] }, evidence: [{ messageId: 'm1-answer', role: 'assistant', quote: '不妨让他是退役水手' }] })}
        alternatives={3}
        onAccept={onAccept}
      />,
    )
    const card = screen.getByRole('article')
    expect(within(card).getByText('AI 建议')).toBeInTheDocument()
    expect(within(card).getByText(/这是讨论中的可能性，不构成作品事实/)).toBeInTheDocument()
    expect(within(card).getByText(/互斥方案 3 选 1/)).toBeInTheDocument()
    expect(within(card).getByText('AI 说')).toBeInTheDocument()
    expect(card.querySelector('del')).toHaveTextContent('看守人')
    expect(card.querySelector('ins')).toHaveTextContent('退役水手')
    expect(within(card).getByRole('status')).toHaveTextContent('需要对照当前版本')
    expect(within(card).getByRole('button', { name: '采纳新版本' })).toBeDisabled()
  })

  it('batch-decides atomically and explains alternative conflicts without dropping items', async () => {
    const user = userEvent.setup()
    const calls: { url: string; body?: unknown; key?: string | null }[] = []
    const items = [proposal(), proposal({ proposalId: 'cp-2', draft: { name: '阿宁', aliases: [], summary: '', fields: [] }, result: { name: '阿宁', aliases: [], summary: '', fields: [] } })]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get('Idempotency-Key') })
      if (url.includes('/proposals/decide'))
        return Response.json({ type: 'about:blank', title: 'ALTERNATIVE_CONFLICT', status: 409, code: 'ALTERNATIVE_CONFLICT', detail: 'x' }, { status: 409 })
      return Response.json({ items, total: 2, nextCursor: null })
    }))
    render(<ProposalList bookId="b1" sessionId={source.sessionId} chapters={[]} />)
    await screen.findByRole('article', { name: '人物：林舟' })
    await user.click(screen.getByRole('button', { name: '全选' }))
    await user.click(screen.getByRole('button', { name: '确认所选' }))
    await screen.findByText(/同一组互斥方案中已有一个被接受/)
    const decide = calls.find((c) => c.url.includes('/decide'))!
    expect(decide.body).toEqual({ decisions: [{ proposalId: 'cp-1', action: 'accept' }, { proposalId: 'cp-2', action: 'accept' }] })
    expect(decide.key).toBeTruthy()
    expect(calls[0].url).toBe(`/v1/studio/books/b1/creative/proposals?status=proposed&sessionId=${source.sessionId}&limit=100`)
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('accepts after editing with the edited content only', async () => {
    const user = userEvent.setup()
    let body: unknown
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/decide')) {
        body = JSON.parse(String(init?.body))
        return Response.json({ proposals: [], assets: [], links: [] })
      }
      return Response.json({ items: [proposal()], total: 1, nextCursor: null })
    }))
    render(<ProposalList bookId="b1" chapters={[]} />)
    await user.click(await screen.findByRole('button', { name: '编辑' }))
    const name = screen.getByRole('textbox', { name: '设定名称' })
    await user.clear(name)
    await user.type(name, '林舟（少年）')
    await user.click(screen.getByRole('button', { name: '保存并确认' }))
    await waitFor(() => expect(body).toBeDefined())
    expect(body).toEqual({ decisions: [{ proposalId: 'cp-1', action: 'accept_edited', status: 'accepted', content: { name: '林舟（少年）', aliases: [], summary: '', fields: [{ key: '身份', value: '看守人' }] } }] })
  })
})

describe('studio URL state', () => {
  it('maps legacy views and only allows compose while reading', () => {
    expect(readView('')).toBe('inspire')
    expect(readView('?view=write')).toBe('read')
    expect(readView('?view=think')).toBe('inspire')
    expect(readView('?view=book')).toBe('book')
    expect(readView('?view=spec')).toBe('inspire')
    expect(readCompose('?view=read&compose=1')).toBe(true)
    expect(readCompose('?view=book&compose=1')).toBe(false)
  })
})
