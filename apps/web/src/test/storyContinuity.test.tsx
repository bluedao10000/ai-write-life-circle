import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { CreativeAsset, StoryChangeReceipt, StoryContext } from '@writer-agent/contracts'
import { StoryDrawer, StoryReceipt, StoryRecordingStatus } from '../features/creative/StoryContinuity'
import { creativeApi } from '../services/api/creativeApi'
import { ApiProblemError } from '../services/writerAgent'

const asset = (id: number): CreativeAsset => ({ assetId: `ca-${id}`, bookId: 'b1', kind: 'character', name: `人物${id}`, aliases: [], summary: `人物${id}的动机`, fields: [{ key: '职业', value: '记者' }], status: 'accepted', origin: 'conversation', version: 1, createdAt: 'now', updatedAt: 'now' })
const context = (): StoryContext => ({ bookId: 'b1', stateVersion: 2, dialogueRecording: false, focus: { sessionId: 'th-1', goal: '讨论人物动机', assetIds: ['ca-1'], questionIds: [], suggestedNextStep: '她为什么隐瞒身份？', updatedFromMessageId: 'q1', version: 2, updatedAt: 'now' }, intent: [], confirmed: [1, 2, 3, 4, 5].map(asset), alternatives: [], rejected: [], questions: [], recentChanges: [] })
const receipt = (): StoryChangeReceipt => ({ changeId: 'sc-1', sessionId: 'th-1', messageId: 'q1', createdAt: 'now', status: 'offered', changes: [{ intent: 'decide', name: '人物1', assetId: 'ca-1', after: asset(1) }] })
function props() { return { mode: 'dock' as const, bookId: 'b1', workTitle: '故事', sessionId: 'th-1', messages: [], receipts: [], context: context(), error: '', unknown: false, recording: false, recordingBusy: false, organized: 0, onRecording: vi.fn(), onRead: vi.fn(), onClose: vi.fn(), onFill: vi.fn(), onAsset: vi.fn(), onMessage: vi.fn(), onReview: vi.fn(), onBook: vi.fn(), onFocusSaved: vi.fn() } }

describe('current story design', () => {
  it('starts with four related settings, loads all pages, and actions only fill drafts', async () => {
    const p = props()
    const api = vi.spyOn(creativeApi, 'assets').mockResolvedValueOnce({ items: [1, 2, 3, 4].map((id) => ({ ...asset(id), pendingProposals: 0 })), total: 5, nextCursor: 4 }).mockResolvedValueOnce({ items: [{ ...asset(5), pendingProposals: 0 }], total: 5, nextCursor: null })
    render(<StoryDrawer {...p} />)
    expect(screen.getByRole('button', { name: '人物4' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '人物5' })).toBeNull()
    await userEvent.click(screen.getAllByRole('button', { name: '调整这条设定' })[0])
    expect(p.onFill).toHaveBeenCalledWith('关于「人物1」，我想调整：')
    await userEvent.click(screen.getByRole('button', { name: '按类型查看全部设定' }))
    expect(await screen.findByRole('button', { name: '人物5' })).toBeVisible()
    expect(api.mock.calls[1][1]).toMatchObject({ status: 'accepted', cursor: 4 })
    await userEvent.click(screen.getByRole('button', { name: '人物5' }))
    expect(p.onAsset).toHaveBeenCalledWith('ca-5')
    await userEvent.click(screen.getByRole('button', { name: '只看相关的' }))
    expect(screen.queryByRole('button', { name: '人物5' })).toBeNull()
  })
  it('saves edited focus against its version and keeps the draft after a failure', async () => {
    const p = props()
    const saved = { ...p.context.focus!, goal: '确定人物付出的代价', version: 3 }
    const save = vi.spyOn(creativeApi, 'saveDiscussionFocus').mockRejectedValueOnce(new Error('暂时无法保存')).mockResolvedValue(saved)
    render(<StoryDrawer {...p} />)
    await userEvent.click(screen.getByRole('button', { name: '编辑焦点' }))
    const input = screen.getByRole('textbox', { name: '本次讨论的焦点' })
    await userEvent.clear(input); await userEvent.type(input, saved.goal)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('暂时无法保存')).toBeVisible()
    expect(input).toHaveValue(saved.goal)
    expect(p.onFocusSaved).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(p.onFocusSaved).toHaveBeenCalledWith(saved))
    expect(save.mock.calls[0][1]).toMatchObject({ sessionId: 'th-1', goal: saved.goal, assetIds: ['ca-1'], suggestedNextStep: '她为什么隐瞒身份？', baseVersion: 2 })
    expect(save.mock.calls[0][2]).toBe(save.mock.calls[1][2])
    expect(p.onFill).not.toHaveBeenCalled()
  })
  it('collapses resolved questions and turns question actions into author drafts', async () => {
    const p = props()
    p.context.questions = [{ ...asset(1), kind: 'open_question', name: '谁寄的信', questionStatus: 'pending' }, { ...asset(2), kind: 'open_question', name: '旧案何时发生', questionStatus: 'resolved', summary: '二十年前' }]
    render(<StoryDrawer {...p} />)
    expect(screen.queryByText('二十年前')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '以后再说' }))
    expect(p.onFill).toHaveBeenCalledWith('「谁寄的信」以后再说。')
    await userEvent.click(screen.getByRole('button', { name: '已解决 · 1' }))
    expect(screen.getByText('二十年前')).toBeVisible()
  })
})

describe('story change receipt', () => {
  it('shows chapter titles in before and after plan changes', async () => {
    const value = receipt()
    value.changes[0].before = { ...asset(1), plan: { chapterId: 'ch-old' } }
    value.changes[0].after = { ...asset(1), plan: { chapterId: 'ch-new', payoffChapterId: 'ch-deleted' } }
    render(<StoryReceipt bookId="b1" receipt={value} chapterTitles={new Map([['ch-old', '初次相遇'], ['ch-new', '旧信重现']])} onChanged={() => {}} onReread={() => {}} onAsset={() => {}} onStory={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(screen.getByText('初次相遇').tagName).toBe('DEL')
    expect(screen.getByText('旧信重现').tagName).toBe('INS')
    expect(screen.getByText('已删除章节')).toBeVisible()
    expect(screen.queryByText(/ch-(old|new|deleted)/)).toBeNull()
  })
  it('applies an offered batch, undoes it, and re-applies with a new action key', async () => {
    const onAsset = vi.fn()
    const apply = vi.spyOn(creativeApi, 'applyChange').mockResolvedValue({ ...receipt(), status: 'applied', undoable: true })
    const undo = vi.spyOn(creativeApi, 'undoChange').mockResolvedValue({ ...receipt(), status: 'undone' })
    function Harness() { const [value, setValue] = useState(receipt()); return <StoryReceipt bookId="b1" receipt={value} onChanged={setValue} onReread={() => {}} onAsset={onAsset} onStory={() => {}} /> }
    render(<Harness />)
    expect(screen.getByText('有 1 项变化可以记下')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(screen.queryByRole('button', { name: '人物1' })).toBeNull()
    expect(screen.getByText('这 1 项变化还没有写进故事，点“记下”会一起保存。')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '记下' }))
    expect(await screen.findByText('已记下 1 项变化')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '人物1' }))
    expect(onAsset).toHaveBeenCalledWith('ca-1')
    await userEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText('已撤销 1 项变化')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '重新记下' }))
    expect(await screen.findByText('已记下 1 项变化')).toBeVisible()
    expect(apply.mock.calls[0][2]).not.toBe(apply.mock.calls[1][2])
    expect(undo).toHaveBeenCalledOnce()
  })
  it('shows only re-read for unknown results, without offering another save', async () => {
    const read = vi.fn(), retry = vi.fn()
    render(<StoryRecordingStatus status={{ status: 'unknown', changeCount: 2 }} onRead={read} onRetry={retry} />)
    expect(screen.queryByRole('button', { name: /记下/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(read).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
  })
  it('re-reads after an upstream failure because the offered batch may already be saved', async () => {
    const apply = vi.spyOn(creativeApi, 'applyChange').mockRejectedValue(new ApiProblemError('upstream unavailable', 502, 'UPSTREAM_UNAVAILABLE'))
    const read = vi.spyOn(creativeApi, 'changes').mockResolvedValue({ items: [{ ...receipt(), status: 'applied', undoable: true }] })
    function Harness() { const [value, setValue] = useState(receipt()); return <StoryReceipt bookId="b1" receipt={value} onChanged={setValue} onReread={() => {}} onAsset={() => {}} onStory={() => {}} /> }
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: '记下' }))
    expect(await screen.findByText('不确定这些变化是否已记下')).toBeVisible()
    expect(screen.queryByRole('button', { name: '记下' })).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(await screen.findByText('已记下 1 项变化')).toBeVisible()
    expect(screen.getByRole('button', { name: '撤销' })).toBeVisible()
    expect(read).toHaveBeenCalledWith('b1', 'th-1')
    expect(apply).toHaveBeenCalledOnce()
  })
  it('offers current-state navigation when the server says undo conflicts', async () => {
    const onAsset = vi.fn()
    render(<StoryReceipt bookId="b1" receipt={{ ...receipt(), status: 'applied', undoable: false, undoConflict: 'changed' }} onChanged={() => {}} onReread={() => {}} onAsset={onAsset} onStory={() => {}} />)
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '查看' }))
    await userEvent.click(screen.getByRole('button', { name: '查看当前状态' }))
    expect(onAsset).toHaveBeenCalledWith('ca-1')
  })
  it('stops offered-batch apply after a version conflict and opens current state', async () => {
    const onStory = vi.fn()
    vi.spyOn(creativeApi, 'applyChange').mockRejectedValue(new ApiProblemError('changed', 409, 'STORY_APPLY_CONFLICT'))
    render(<StoryReceipt bookId="b1" receipt={receipt()} onChanged={() => {}} onReread={() => {}} onAsset={() => {}} onStory={onStory} />)
    await userEvent.click(screen.getByRole('button', { name: '记下' }))
    expect(await screen.findByText('无法直接记下这批变化。请查看当前状态后继续讨论。')).toBeVisible()
    expect(screen.queryByRole('button', { name: '记下' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '查看当前状态' }))
    expect(onStory).toHaveBeenCalledOnce()
  })
})
