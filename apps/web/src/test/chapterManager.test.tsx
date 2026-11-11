import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagedBook } from '@writer-agent/contracts'
import ChapterManager from '../features/management/ChapterManager'
import { useManagement } from '../features/management/ManagedStudio'
import { WorkNavigation } from '../features/management/StudioPage'
import type { useStudioController } from '../features/vnext/useStudioController'

vi.mock('../features/management/ManagedStudio', () => ({ useManagement: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function setup() {
  const book: ManagedBook = {
    bookId: 'work', title: '作品', version: 1, readOnly: false,
    volumes: [{ volumeId: 'v1', title: '第一卷' }, { volumeId: 'old-volume', title: '旧卷', archived: true }],
    chapters: [
      { chapterId: 'stable-a', title: '开端', volumeId: 'v1', archived: false },
      { chapterId: 'stable-b', title: '转折', volumeId: 'v1', archived: false },
      { chapterId: 'stable-old', title: '旧章', volumeId: 'old-volume', archived: true },
    ],
  }
  const change = vi.fn(async () => book)
  vi.mocked(useManagement).mockReturnValue({ book, change } as unknown as NonNullable<ReturnType<typeof useManagement>>)
  const open = vi.fn()
  const studio = {
    chapters: [{ id: 'stable-a', title: '开端', wordCount: 10 }, { id: 'stable-b', title: '转折', wordCount: 0 }],
    current: 'stable-a', workspace: { projectTitle: '作品' }, switchChapter: vi.fn(), setView: vi.fn(), enterCompose: vi.fn(),
  } as unknown as ReturnType<typeof useStudioController>
  render(<WorkNavigation.Provider value={{ page: 'chapters', open, historyAvailable: true }}><ChapterManager studio={studio} /></WorkNavigation.Provider>)
  return { change, book, open, studio }
}

it('archives selected chapters through one structure mutation and preserves stable IDs', async () => {
  const user = userEvent.setup()
  const { change, book } = setup()
  await user.click(screen.getByRole('checkbox', { name: '选择开端' }))
  await user.click(screen.getByRole('button', { name: '归档章节' }))
  expect(change).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '确认归档' }))
  await waitFor(() => expect(change).toHaveBeenCalledOnce())
  expect(change).toHaveBeenCalledWith({ operation: 'structure', volumes: book.volumes, chapters: book.chapters.map((chapter) => chapter.chapterId === 'stable-a' ? { ...chapter, archived: true } : chapter) })
})

it('keeps archived chapters in archived volumes reachable for restoration', async () => {
  const user = userEvent.setup()
  const { change, book } = setup()
  await user.click(screen.getByRole('tab', { name: '已归档 1' }))
  expect(screen.getByText('旧卷')).toBeVisible()
  expect(screen.getByRole('button', { name: '旧章' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '恢复' }))
  await waitFor(() => expect(change).toHaveBeenCalledWith({ operation: 'structure', volumes: book.volumes, chapters: book.chapters.map((chapter) => chapter.chapterId === 'stable-old' ? { ...chapter, archived: false } : chapter) }))
})

it('filters empty chapters using known word counts and opens the selected chapter for writing', async () => {
  const user = userEvent.setup()
  const { studio, open } = setup()
  await user.click(screen.getByRole('tab', { name: '空白' }))
  expect(screen.queryByRole('button', { name: '开端' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '写作：转折' }))
  expect(studio.switchChapter).toHaveBeenCalledWith('stable-b')
  expect(studio.enterCompose).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledWith(null)
})
