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
      title: '第一章',
      words: 1200,
      isEmpty: false,
    },
  ],
}

beforeEach(() => {
  window.history.replaceState({}, '', '/publish?book=book-abc')
  vi.mocked(getPublication).mockResolvedValue(management)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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
  vi.mocked(suggestPublication).mockResolvedValue({
    title: '逐玉',
    penName: '逐玉',
    tagline: '侯夫人与杀猪刀。',
    description: '市井女子与侯府的纠葛。',
    authorBio: '写故事的人。',
    category: '历史',
  })
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
