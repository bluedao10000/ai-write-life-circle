import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PublicationManagement } from '@writer-agent/contracts'
import Publish from '../site/Publish'
import { getPublication, suggestPublication } from '../services/api/publicationApi'

vi.mock('../services/api/publicationApi', () => ({
  getPublication: vi.fn(),
  previewPublication: vi.fn(),
  commitPublication: vi.fn(),
  suggestPublication: vi.fn(),
  transitionPublication: vi.fn(),
}))

const management: PublicationManagement = {
  bookTitle: '逐玉',
  publication: null,
  changedChapterIds: [],
  drafts: [
    {
      chapterId: 'CH-001',
      revisionId: 'rev-1',
      contentHash: 'sha256:' + 'a'.repeat(64),
      volumeId: '',
      chapterOrder: 0,
      title: '第1章 起',
      words: 1000,
      isEmpty: false,
    },
    {
      chapterId: 'CH-002',
      revisionId: 'rev-2',
      contentHash: 'sha256:' + 'b'.repeat(64),
      volumeId: '',
      chapterOrder: 1,
      title: '第2章 承',
      words: 2000,
      isEmpty: false,
    },
    {
      chapterId: 'CH-003',
      revisionId: 'rev-3',
      contentHash: 'sha256:' + 'c'.repeat(64),
      volumeId: 'vol-1',
      volumeTitle: '第一卷',
      chapterOrder: 2,
      title: '第3章 转',
      words: 3000,
      isEmpty: false,
    },
    {
      chapterId: 'CH-004',
      revisionId: 'rev-4',
      contentHash: 'sha256:' + 'd'.repeat(64),
      volumeId: 'vol-1',
      volumeTitle: '第一卷',
      chapterOrder: 3,
      title: '第4章 空',
      words: 0,
      isEmpty: true,
    },
  ],
}

beforeEach(() => {
  window.history.replaceState({}, '', '/publish?book=book-abc')
  vi.mocked(getPublication).mockResolvedValue(management)
  vi.mocked(suggestPublication).mockResolvedValue({
    title: '逐玉',
    penName: '逐玉',
    tagline: '侯夫人与杀猪刀。',
    description: '市井女子与侯府的纠葛。',
    authorBio: '写故事的人。',
    category: '历史',
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function openChapters(user: ReturnType<typeof userEvent.setup>) {
  render(<Publish />)
  await screen.findByLabelText('书名')
  await user.click(screen.getByRole('button', { name: /AI 帮我填/ }))
  await waitFor(() => expect(screen.getByLabelText('笔名')).toHaveValue('逐玉'))
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await screen.findByText('选择要公开的章节')
}

it('prefills the book title and a valid public slug, and explains what is missing', async () => {
  const user = userEvent.setup()
  render(<Publish />)
  expect(await screen.findByLabelText('书名')).toHaveValue('逐玉')
  expect(screen.getByLabelText('公开地址')).toHaveValue('book-abc')
  await user.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByRole('alert')).toHaveTextContent(
    '还需要填写：笔名、一句话简介、作品简介、题材',
  )
  expect(screen.queryByText('选择要公开的章节')).not.toBeInTheDocument()
})

it('fills blank fields from one assistant suggestion and then advances', async () => {
  const user = userEvent.setup()
  render(<Publish />)
  await screen.findByLabelText('书名')
  await user.click(screen.getByRole('button', { name: /AI 帮我填/ }))
  await waitFor(() => expect(screen.getByLabelText('笔名')).toHaveValue('逐玉'))
  expect(screen.getByLabelText('一句话简介')).toHaveValue('侯夫人与杀猪刀。')
  expect(screen.getByLabelText('作品简介')).toHaveValue('市井女子与侯府的纠葛。')
  expect(screen.getByLabelText('作者介绍')).toHaveValue('写故事的人。')
  await user.click(screen.getByRole('button', { name: '下一步' }))
  expect(await screen.findByText('选择要公开的章节')).toBeInTheDocument()
})

it('selects all publishable chapters and clears the selection', async () => {
  const user = userEvent.setup()
  await openChapters(user)
  const count = screen.getByRole('status', { name: '已选章节统计' })
  expect(count).toHaveTextContent('已选 0 / 3 章 · 0 字')
  await user.click(screen.getByRole('button', { name: '全选' }))
  expect(count).toHaveTextContent('已选 3 / 3 章 · 6,000 字')
  expect(screen.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([
    true,
    true,
    true,
    false,
  ])
  await user.click(screen.getByRole('button', { name: '清空选择' }))
  expect(count).toHaveTextContent('已选 0 / 3 章 · 0 字')
})

it('scopes select-all to the current search results', async () => {
  const user = userEvent.setup()
  await openChapters(user)
  await user.type(screen.getByLabelText('查找章节'), '第2章')
  expect(screen.queryByText('第1章 起')).not.toBeInTheDocument()
  expect(screen.getByText(/找到 1 章/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '全选结果' }))
  expect(screen.getByRole('status', { name: '已选章节统计' })).toHaveTextContent(
    '已选 1 / 3 章 · 2,000 字',
  )
  expect(
    screen.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked),
  ).toEqual([true])
})

it('selects a volume without including empty chapters', async () => {
  const user = userEvent.setup()
  await openChapters(user)
  const buttons = screen.getAllByRole('button', { name: '选择本卷' })
  await user.click(buttons[1])
  expect(screen.getByRole('status', { name: '已选章节统计' })).toHaveTextContent(
    '已选 1 / 3 章 · 3,000 字',
  )
  expect(screen.getByRole('button', { name: '取消本卷' })).toBeInTheDocument()
  expect(screen.getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([
    false,
    false,
    true,
    false,
  ])
})
