import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { ImportPreview, ManagedBook } from '@writer-agent/contracts'
import EPUBImportDialog from '../features/management/EPUBImportDialog'

const preview: ImportPreview = {
  importId: 'imp-aaaaaaaaaaaaaaaaaaaaaaaa',
  status: 'previewed',
  title: '北港往事',
  author: '测试作者',
  volumes: [{ volumeId: 'VOL-one', title: '第一卷' }],
  chapters: [
    {
      chapterId: 'CH-000001',
      title: '第一章 雨夜',
      volumeId: 'VOL-one',
      wordCount: 1200,
      sourcePart: 'OEBPS/one.xhtml',
      excerpt: '雨落在青石板上。',
    },
    {
      chapterId: 'CH-000002',
      title: '第二章 来客',
      volumeId: 'VOL-one',
      wordCount: 1800,
      sourcePart: 'OEBPS/two.xhtml',
      excerpt: '来客带来了灯。',
    },
  ],
  warnings: [{ code: 'TOC_ANCHOR_INVALID', message: '一处目录锚点已按文件边界切分。' }],
  fingerprint: `sha256:${'a'.repeat(64)}`,
  knowledge: { status: 'awaiting_author_consent' },
  createdAt: '2026-10-20T00:00:00.000Z',
}
const book: ManagedBook = {
  bookId: 'book-one',
  title: '确认后的书名',
  version: 1,
  readOnly: false,
  volumes: preview.volumes,
  chapters: preview.chapters.map((chapter) => ({
    chapterId: chapter.chapterId,
    title: chapter.title,
    volumeId: chapter.volumeId,
    archived: false,
  })),
}

afterEach(cleanup)

it('previews structure and warning, then commits the confirmed title without invoking model work', async () => {
  const user = userEvent.setup()
  const uploadEPUB = vi.fn(async () => preview)
  const commitImport = vi.fn(async () => book)
  const deleteImport = vi.fn(async () => undefined)
  const complete = vi.fn()
  render(
    <EPUBImportDialog
      adapter={{ list: vi.fn(), mutate: vi.fn(), uploadEPUB, commitImport, deleteImport }}
      onComplete={complete}
      onCancel={vi.fn()}
    />,
  )
  const file = new File(['fixture'], 'novel.epub', { type: 'application/epub+zip' })
  await user.upload(screen.getByLabelText(/选择 EPUB 小说/), file)
  await user.click(screen.getByRole('button', { name: '解析并预览' }))
  expect(await screen.findByText('2')).toBeVisible()
  expect(screen.getByText('3,000')).toBeVisible()
  expect(screen.getByText(/目录锚点已按文件边界切分/)).toBeVisible()
  expect(screen.getByText(/导入不会调用模型/)).toBeVisible()
  const title = screen.getByLabelText('作品名称')
  await user.clear(title)
  await user.type(title, '确认后的书名')
  await user.click(screen.getByRole('button', { name: '确认导入作品' }))
  await waitFor(() => expect(complete).toHaveBeenCalledWith(book))
  expect(uploadEPUB).toHaveBeenCalledTimes(1)
  expect(commitImport).toHaveBeenCalledWith(
    preview.importId,
    expect.objectContaining({
      fingerprint: preview.fingerprint,
      title: '确认后的书名',
      chapters: [
        expect.objectContaining({ chapterId: 'CH-000001', volumeId: 'VOL-one' }),
        expect.objectContaining({ chapterId: 'CH-000002', volumeId: 'VOL-one' }),
      ],
    }),
    expect.any(String),
  )
})

it('reuses upload and commit keys after ambiguous failures', async () => {
  const user = userEvent.setup()
  const uploadEPUB = vi
    .fn<NonNullable<Parameters<typeof EPUBImportDialog>[0]['adapter']['uploadEPUB']>>()
    .mockRejectedValueOnce(new Error('请求超时'))
    .mockResolvedValueOnce(preview)
  const commitImport = vi
    .fn<NonNullable<Parameters<typeof EPUBImportDialog>[0]['adapter']['commitImport']>>()
    .mockRejectedValueOnce(new Error('响应中断'))
    .mockResolvedValueOnce(book)
  render(
    <EPUBImportDialog
      adapter={{ list: vi.fn(), mutate: vi.fn(), uploadEPUB, commitImport, deleteImport: vi.fn() }}
      onComplete={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  const file = new File(['fixture'], 'novel.epub', { type: 'application/epub+zip' })
  await user.upload(screen.getByLabelText(/选择 EPUB 小说/), file)
  await user.click(screen.getByRole('button', { name: '解析并预览' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('请求超时')
  await user.click(screen.getByRole('button', { name: '解析并预览' }))
  expect(await screen.findByDisplayValue('北港往事')).toBeVisible()
  expect(uploadEPUB.mock.calls[0]?.[1]).toBe(uploadEPUB.mock.calls[1]?.[1])
  await user.click(screen.getByRole('button', { name: '确认导入作品' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('响应中断')
  await user.click(screen.getByRole('button', { name: '确认导入作品' }))
  expect(commitImport.mock.calls[0]?.[2]).toBe(commitImport.mock.calls[1]?.[2])
})

it('allows small structure corrections and rotates the commit key after payload edits', async () => {
  const user = userEvent.setup()
  const commitImport = vi
    .fn<NonNullable<Parameters<typeof EPUBImportDialog>[0]['adapter']['commitImport']>>()
    .mockRejectedValueOnce(new Error('请重试'))
    .mockResolvedValueOnce(book)
  render(
    <EPUBImportDialog
      adapter={{
        list: vi.fn(),
        mutate: vi.fn(),
        uploadEPUB: vi.fn(async () => preview),
        commitImport,
        deleteImport: vi.fn(),
      }}
      onComplete={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  const file = new File(['fixture'], 'novel.epub', { type: 'application/epub+zip' })
  await user.upload(screen.getByLabelText(/选择 EPUB 小说/), file)
  await user.click(screen.getByRole('button', { name: '解析并预览' }))
  expect(await screen.findByRole('button', { name: '确认导入作品' })).toBeEnabled()

  const volumeTitle = screen.getByLabelText('卷名 第一卷')
  await user.clear(volumeTitle)
  await user.type(volumeTitle, '第一卷 · 北港')
  await user.clear(screen.getByLabelText('章名 1'))
  await user.type(screen.getByLabelText('章名 1'), '第一章 夜雨')

  await user.click(screen.getByRole('button', { name: '确认导入作品' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('请重试')
  const firstKey = commitImport.mock.calls[0]?.[2]
  await user.click(screen.getByRole('button', { name: '确认导入作品' }))
  expect(commitImport.mock.calls[1]?.[2]).toBe(firstKey)
  expect(commitImport).toHaveBeenLastCalledWith(
    preview.importId,
    expect.objectContaining({
      volumes: [{ volumeId: 'VOL-one', title: '第一卷 · 北港' }],
      chapters: [
        expect.objectContaining({ chapterId: 'CH-000001', title: '第一章 夜雨' }),
        expect.objectContaining({ chapterId: 'CH-000002', title: '第二章 来客' }),
      ],
    }),
    firstKey,
  )
})

it('discards a staged preview when the author chooses another file', async () => {
  const user = userEvent.setup()
  const deleteImport = vi.fn(async () => undefined)
  render(
    <EPUBImportDialog
      adapter={{
        list: vi.fn(),
        mutate: vi.fn(),
        uploadEPUB: vi.fn(async () => preview),
        commitImport: vi.fn(),
        deleteImport,
      }}
      onComplete={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  const file = new File(['fixture'], 'novel.epub', { type: 'application/epub+zip' })
  await user.upload(screen.getByLabelText(/选择 EPUB 小说/), file)
  await user.click(screen.getByRole('button', { name: '解析并预览' }))
  await screen.findByDisplayValue('北港往事')
  await user.click(screen.getByRole('button', { name: '重新选择' }))
  expect(deleteImport).toHaveBeenCalledWith(preview.importId)
})

it('rejects an oversized file before uploading it', async () => {
  const user = userEvent.setup()
  const uploadEPUB = vi.fn()
  render(
    <EPUBImportDialog
      adapter={{
        list: vi.fn(),
        mutate: vi.fn(),
        uploadEPUB,
        commitImport: vi.fn(),
        deleteImport: vi.fn(),
      }}
      onComplete={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  const file = new File(['x'], 'oversized.epub', { type: 'application/epub+zip' })
  Object.defineProperty(file, 'size', { value: 64 * 1024 * 1024 + 1 })
  await user.upload(screen.getByLabelText(/选择 EPUB 小说/), file)
  expect(screen.getByRole('alert')).toHaveTextContent('超过 64 MiB')
  expect(screen.getByRole('button', { name: '解析并预览' })).toBeDisabled()
  expect(uploadEPUB).not.toHaveBeenCalled()
})
