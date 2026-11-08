import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ImportPreview, ManagedBook, WorkspaceSnapshot } from '@writer-agent/contracts'
import ManagedStudio, { ManagementContext, useManagement } from '../features/management/ManagedStudio'
import ManagedDirectory from '../features/management/ManagedDirectory'
import BookMenu from '../features/management/BookMenu'
import { createDemoWriterAgentAdapter } from '../mocks/demoWriterAgent'
import { chapters, initialDoc, knowledge } from '../mocks/demoData'

const book: ManagedBook = {
  bookId: 'book-one',
  title: '合成作品',
  version: 1,
  readOnly: false,
  volumes: [
    { volumeId: 'VOL-1', title: '第一卷' },
    { volumeId: 'VOL-2', title: '第二卷' },
  ],
  chapters: [
    { chapterId: 'CH-001', title: '第一章 开端', volumeId: 'VOL-1', archived: false },
    { chapterId: 'CH-002', title: '第二章 转折', volumeId: 'VOL-1', archived: false },
    { chapterId: 'CH-003', title: '第三章 归途', volumeId: 'VOL-2', archived: false },
  ],
}
const wordCounts = { 'CH-001': 1200, 'CH-002': 800, 'CH-003': 500 }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

function renderDirectory(
  target: ManagedBook,
  options: {
    current?: string
    wordCounts?: Record<string, number>
    busy?: boolean
    error?: string
    refresh?: () => void
  } = {},
) {
  const change = vi.fn(async () => target)
  const onOpen = vi.fn()
  const onClose = vi.fn()
  render(
    <ManagementContext.Provider
      value={{
        book: target,
        books: [target],
        editing: null,
        setEditing: vi.fn(),
        preferences: { current: undefined },
        activeChapter: { current: options.current ?? target.chapters[0]?.chapterId ?? '' },
        protect: (action) => {
          void action()
        },
        guard: { current: null },
        change,
        changeBook: vi.fn(async () => target),
        switchBook: vi.fn(),
        deleteBook: vi.fn(async () => true),
        canDelete: true,
        create: vi.fn(),
        openImport: vi.fn(),
        canImport: false,
        wordCounts: options.wordCounts ?? wordCounts,
        busy: options.busy,
        error: options.error,
        refresh: options.refresh,
      }}
    >
      <ManagedDirectory
        current={options.current ?? target.chapters[0]?.chapterId ?? ''}
        onOpen={onOpen}
        onClose={onClose}
      />
    </ManagementContext.Provider>,
  )
  return { change, onOpen, onClose }
}

it('shows chapter names, numbers, per-chapter words and volume totals', () => {
  renderDirectory(book)
  expect(screen.getByRole('status')).toHaveTextContent('3 章 · 2 卷 · 2,500 字')
  expect(screen.getByRole('button', { name: /开端/ })).toHaveTextContent('开端')
  expect(screen.getByRole('button', { name: /转折/ })).toHaveTextContent('转折')
  expect(screen.getByRole('button', { name: /归途/ })).toHaveTextContent('归途')
  expect(screen.getByText('1,200 字')).toBeVisible()
  expect(
    screen.getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === '2 章 · 2,000 字'),
  ).toBeVisible()
})

it('marks the current chapter and expands its volume', async () => {
  const user = userEvent.setup()
  renderDirectory(book, { current: 'CH-003' })
  expect(screen.getByRole('button', { name: /归途/ })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('button', { name: '收起第二卷' })).toHaveAttribute('aria-expanded', 'true')
  await user.click(screen.getByRole('button', { name: '收起第一卷' }))
  expect(screen.queryByRole('button', { name: /开端/ })).toBeNull()
  await user.click(screen.getByRole('button', { name: '展开第一卷' }))
  expect(screen.getByRole('button', { name: /开端/ })).toBeVisible()
})

it('filters by chapter title and number, and reports no matches', async () => {
  const user = userEvent.setup()
  renderDirectory(book)
  const search = screen.getByLabelText('查找章节')
  await user.type(search, '转折')
  expect(screen.getByRole('button', { name: /转折/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: /开端/ })).toBeNull()
  await user.clear(search)
  await user.type(search, '3')
  expect(screen.getByRole('button', { name: /归途/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: /转折/ })).toBeNull()
  await user.clear(search)
  await user.type(search, '不存在的章节')
  expect(screen.getByText('没有匹配的章节。')).toBeVisible()
})

it('renders an empty directory with a first-chapter action', async () => {
  const user = userEvent.setup()
  const empty = { ...book, chapters: [], volumes: [] }
  const { change } = renderDirectory(empty)
  expect(screen.getByText('还没有章节。')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '新建第一章' }))
  expect(change).toHaveBeenCalledWith({ operation: 'chapter' }, 'new')
})

it('keeps a read-only directory free of structure actions', () => {
  renderDirectory({ ...book, readOnly: true })
  expect(screen.getByRole('status')).toHaveTextContent('只读')
  expect(screen.queryByLabelText('新建章节或卷')).toBeNull()
  expect(screen.queryByLabelText('第一章 开端菜单')).toBeNull()
  expect(screen.queryByRole('button', { name: '重命名' })).toBeNull()
})

it('surfaces busy and error states and retries from the directory', async () => {
  const user = userEvent.setup()
  const refresh = vi.fn()
  renderDirectory(book, { busy: true, refresh })
  expect(screen.getByText('正在更新目录…')).toBeVisible()
  cleanup()
  renderDirectory(book, { error: '目录读取失败', refresh })
  expect(screen.getByRole('alert')).toHaveTextContent('目录读取失败')
  await user.click(screen.getByRole('button', { name: '重试' }))
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('collapses large books to the current volume and searches across all volumes', async () => {
  const user = userEvent.setup()
  const many: ManagedBook = {
    ...book,
    chapters: Array.from({ length: 600 }, (_, index) => ({
      chapterId: `CH-${String(index + 1).padStart(3, '0')}`,
      title: `第${index + 1}章 事件${index + 1}`,
      volumeId: index < 300 ? 'VOL-1' : 'VOL-2',
      archived: false,
    })),
  }
  renderDirectory(many, { current: 'CH-500' })
  expect(screen.getByRole('button', { name: '收起第二卷' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: '展开第一卷' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('button', { name: /^1 事件1/ })).toBeNull()
  await user.type(screen.getByLabelText('查找章节'), '第1章')
  expect(screen.getByRole('button', { name: /^1 事件1/ })).toBeVisible()
})

it('closes from the directory header', async () => {
  const user = userEvent.setup()
  const { onClose } = renderDirectory(book)
  await user.click(screen.getByRole('button', { name: '关闭目录' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})

const importedBook: ManagedBook = {
  bookId: 'book-imported',
  title: '导入作品',
  version: 1,
  readOnly: false,
  volumes: [{ volumeId: 'VOL-1', title: '第一卷' }],
  chapters: [
    { chapterId: 'CH-001', title: '第一章 开端', volumeId: 'VOL-1', archived: false },
    { chapterId: 'CH-002', title: '第二章 转折', volumeId: 'VOL-1', archived: false },
  ],
}
const preview: ImportPreview = {
  importId: 'imp-0123456789abcdef01234567',
  status: 'previewed',
  title: '导入作品',
  volumes: [{ volumeId: 'VOL-1', title: '第一卷' }],
  chapters: [
    {
      chapterId: 'CH-001',
      title: '第一章 开端',
      volumeId: 'VOL-1',
      wordCount: 1200,
      sourcePart: 'part-1',
      excerpt: '开端',
    },
    {
      chapterId: 'CH-002',
      title: '第二章 转折',
      volumeId: 'VOL-1',
      wordCount: 800,
      sourcePart: 'part-2',
      excerpt: '转折',
    },
  ],
  warnings: [],
  fingerprint: `sha256:${'a'.repeat(64)}`,
  knowledge: { status: 'awaiting_author_consent' },
  createdAt: '2026-11-08T00:00:00.000Z',
}

async function importSetup(initial: ManagedBook | null, layout?: WorkspaceSnapshot['preferences']) {
  const demo = createDemoWriterAgentAdapter({ chapters, document: initialDoc, knowledge })
  const base = await demo.loadWorkspace('book-one')
  const snapshotFor = (target: ManagedBook, preferences = layout): WorkspaceSnapshot => ({
    ...base,
    projectId: target.bookId,
    projectTitle: target.title,
    chapters: target.chapters.map((chapter, index) => ({
      id: chapter.chapterId,
      title: chapter.title,
      volume: target.volumes.find((volume) => volume.volumeId === chapter.volumeId)?.title ?? '',
      meta: '',
      wordCount: 100 + index,
    })),
    currentChapterId: target.chapters[0]?.chapterId ?? '',
    preferences,
  })
  const loadWorkspace = vi.fn(async (id: string) =>
    id === importedBook.bookId ? snapshotFor(importedBook, undefined) : snapshotFor(initial ?? book),
  )
  const uploadEPUB = vi.fn(async () => preview)
  const commitImport = vi.fn(async () => importedBook)
  const deleteImport = vi.fn(async () => undefined)
  const adapter = {
    ...demo,
    loadWorkspace,
    management: {
      list: vi.fn(async () => (initial ? [initial, importedBook] : [importedBook])),
      mutate: vi.fn(async () => importedBook),
      deleteBook: vi.fn(async () => undefined),
      uploadEPUB,
      commitImport,
      deleteImport,
    },
  }
  return { adapter, snapshotFor, loadWorkspace }
}

async function runImport(user: ReturnType<typeof userEvent.setup>) {
  const input = await screen.findByLabelText(/选择 EPUB 小说/)
  await user.upload(input, new File(['epub'], 'novel.epub', { type: 'application/epub+zip' }))
  await user.click(screen.getByRole('button', { name: '解析并预览' }))
  await user.click(await screen.findByRole('button', { name: '确认导入作品' }))
}

it('opens the directory on the first chapter after import and closes the dialog', async () => {
  const user = userEvent.setup()
  const { adapter } = await importSetup(null)
  let workspace: WorkspaceSnapshot | undefined
  render(
    <ManagedStudio
      adapter={adapter}
      initialBooks={[]}
      render={(value) => {
        workspace = value
        return <p>{value.projectTitle}</p>
      }}
    />,
  )
  await user.click(screen.getByRole('button', { name: '从 EPUB 导入作品' }))
  await runImport(user)
  await waitFor(() => expect(workspace?.projectTitle).toBe('导入作品'))
  expect(workspace?.currentChapterId).toBe('CH-001')
  expect(workspace?.preferences?.layout).toMatchObject({ leftOpen: true })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps the author layout width and side panels when import opens the directory', async () => {
  const user = userEvent.setup()
  const layout = { leftOpen: false, rightOpen: true, leftW: 320, rightW: 420, focus: false }
  const { adapter } = await importSetup(book, { theme: 'dark', layout })
  let workspace: WorkspaceSnapshot | undefined
  function Capture({ value }: { value: WorkspaceSnapshot }) {
    const management = useManagement()!
    useEffect(() => {
      management.activeChapter.current = value.currentChapterId
      management.preferences.current = value.preferences
    }, [management, value])
    return (
      <>
        <BookMenu />
        <p>{value.projectTitle}</p>
      </>
    )
  }
  render(
    <ManagedStudio
      adapter={adapter}
      initialBooks={[book]}
      render={(value) => {
        workspace = value
        return <Capture value={value} />
      }}
    />,
  )
  await user.click(await screen.findByRole('button', { name: `当前作品：${book.title}，切换作品` }))
  await user.click(screen.getByRole('menuitem', { name: /从 EPUB 导入/ }))
  await runImport(user)
  await waitFor(() => expect(workspace?.projectTitle).toBe('导入作品'))
  expect(workspace?.preferences?.layout).toEqual({
    leftOpen: true,
    rightOpen: true,
    leftW: 320,
    rightW: 420,
    focus: false,
  })
})
