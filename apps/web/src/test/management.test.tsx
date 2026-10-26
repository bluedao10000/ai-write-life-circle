import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import {
  managedBooksSchema,
  structureInputSchema,
} from '@writer-agent/contracts'
import type { ManagedBook, StructureInput } from '@writer-agent/contracts'
import ManagedStudio, {
  ManagementContext,
  useManagement,
} from '../features/management/ManagedStudio'
import ManagedDirectory from '../features/management/ManagedDirectory'
import BookMenu from '../features/management/BookMenu'
import { createDemoWriterAgentAdapter } from '../mocks/demoWriterAgent'
import { chapters, initialDoc, knowledge } from '../mocks/demoData'
import {
  clearLocalChapterDrafts,
  readLocalChapterDraft,
  writeLocalChapterDraft,
} from '../services/localChapterDraft'
const b: ManagedBook = {
  bookId: 'book-one',
  title: '合成作品',
  version: 1,
  readOnly: false,
  chapters: [{ chapterId: 'CH-001', title: '第一章', archived: false }],
  volumes: [],
}
beforeEach(() => { sessionStorage.clear(); window.history.replaceState({}, '', '/') })
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
async function setup() {
  const adapter = createDemoWriterAgentAdapter({
    chapters,
    document: initialDoc,
    knowledge,
  })
  const snapshot = await adapter.loadWorkspace(b.bookId)
  const loadWorkspace = vi.fn(async () => snapshot)
  const mutate = vi.fn<
    (
      id: string | null,
      input: StructureInput,
      key: string,
    ) => Promise<ManagedBook>
  >(async () => b)
  const deleteBook = vi.fn(async () => undefined)
  const managed = {
    ...adapter,
    loadWorkspace,
    management: { list: vi.fn(async () => [b]), mutate, deleteBook },
  }
  return { snapshot, managed, loadWorkspace, mutate, deleteBook }
}
it('starts with an author-facing empty state and reuses the create key after a failed response', async () => {
  const user = userEvent.setup(),
    { managed, mutate } = await setup()
  mutate.mockRejectedValueOnce(Error('请求超时'))
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[]}
      render={(workspace) => <p>{workspace.projectTitle}</p>}
    />,
  )
  expect(
    screen.getByText('先写下第一章。书名、卷名和其他资料，都可以以后再整理。'),
  ).toBeVisible()
  await user.click(screen.getByRole('button', { name: '开始写作' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('请求超时')
  await user.click(screen.getByRole('button', { name: '开始写作' }))
  expect(await screen.findByText(b.title)).toBeVisible()
  expect(mutate).toHaveBeenCalledTimes(2)
  expect(mutate.mock.calls[0]?.[2]).toBe(mutate.mock.calls[1]?.[2])
})
function Guarded({ reject }: { reject: () => Promise<void> }) {
  const m = useManagement()!
  useEffect(() => {
    m.guard.current = reject
    return () => {
      m.guard.current = null
    }
  }, [m, reject])
  return (
    <>
      <BookMenu />
      <p>正文仍在当前编辑器</p>
    </>
  )
}

it('blocks book creation and switching when save or recovery guard fails', async () => {
  const user = userEvent.setup(),
    { managed, mutate, loadWorkspace } = await setup()
  const reject = vi.fn(async () => {
    throw Error('请先处理本地草稿恢复或版本冲突。')
  })
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[b, { ...b, bookId: 'book-two', title: '另一部' }]}
      render={() => <Guarded reject={reject} />}
    />,
  )
  await user.click(await screen.findByRole('button', { name: `当前作品：${b.title}，切换作品` }))
  await user.click(screen.getByRole('menuitem', { name: '新建空白作品' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('本地草稿恢复')
  expect(mutate).not.toHaveBeenCalled()
  expect(screen.getByText('正文仍在当前编辑器')).toBeVisible()
  await user.click(screen.getByRole('button', { name: `当前作品：${b.title}，切换作品` }))
  await user.click(screen.getByRole('menuitem', { name: /另一部/ }))
  await waitFor(() => expect(reject).toHaveBeenCalledTimes(2))
  expect(loadWorkspace).toHaveBeenCalledTimes(1)
})
it('edits chapter names inline, moves by stable volume ID and requires archive confirmation', async () => {
  const user = userEvent.setup()
  const book = { ...b, volumes: [{ volumeId: 'VOL-one', title: '第一卷' }] }
  const change = vi.fn(async () => book),
    create = vi.fn(),
    switchBook = vi.fn()
  function Directory() {
    const [editing, setEditing] = React.useState<string | null>(null)
    return (
      <ManagementContext.Provider
        value={{
          book,
          books: [book],
          canImport: false,
          openImport: vi.fn(),
          preferences: { current: undefined },
          activeChapter: { current: 'CH-001' },
          protect: (action) => {
            void action()
          },
          guard: { current: null },
          change,
          changeBook: vi.fn(async () => book),
          create,
          deleteBook: vi.fn(),
          canDelete: true,
          switchBook,
          editing,
          setEditing,
        }}
      >
        <ManagedDirectory current="CH-001" onOpen={vi.fn()} onClose={vi.fn()} />
      </ManagementContext.Provider>
    )
  }
  render(<Directory />)
  await user.click(screen.getByLabelText('第一章菜单'))
  await user.click(screen.getByRole('button', { name: '重命名' }))
  const input = screen.getByLabelText('章节名称')
  await user.clear(input)
  await user.type(input, '起点')
  await user.click(screen.getByRole('button', { name: '保存名称' }))
  await waitFor(() =>
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        chapters: [
          expect.objectContaining({ chapterId: 'CH-001', title: '起点' }),
        ],
      }),
    ),
  )
  await user.selectOptions(screen.getByLabelText('第一章移动到卷'), 'VOL-one')
  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({
      chapters: [expect.objectContaining({ volumeId: 'VOL-one' })],
    }),
  )
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const count = change.mock.calls.length
  await user.click(screen.getByRole('button', { name: '归档' }))
  expect(change).toHaveBeenCalledTimes(count)
  confirm.mockReturnValue(true)
  await user.click(screen.getByRole('button', { name: '归档' }))
  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({
      chapters: [expect.objectContaining({ archived: true })],
    }),
  )
  expect(confirm).toHaveBeenLastCalledWith(
    expect.stringContaining('可能仍可被阅读'),
  )
})
import React from 'react'

it('recovers a committed create after refresh before accepting another create intent', async () => {
  const { managed, mutate } = await setup()
  const recovered = { ...b, bookId: 'recovered-book', title: '已恢复的作品' }
  sessionStorage.setItem(
    'writer-agent:pending-create-book',
    'stable-pending-key',
  )
  mutate.mockResolvedValue(recovered)
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[b]}
      render={(workspace) => <p>{workspace.projectTitle}</p>}
    />,
  )
  expect(await screen.findByText(recovered.title)).toBeVisible()
  expect(mutate).toHaveBeenCalledWith(
    null,
    { operation: 'create', baseVersion: 0 },
    'stable-pending-key',
  )
  expect(sessionStorage.getItem('writer-agent:pending-create-book')).toBeNull()
  expect(sessionStorage.getItem('writer-agent:selected-book')).toBe(
    recovered.bookId,
  )
})

it('preserves long legacy Harness headings while rejecting new oversized titles', () => {
  const title = '旧章'.repeat(150)
  const legacy = {
    ...b,
    readOnly: true,
    chapters: [{ ...b.chapters[0], title }],
  }
  expect(
    managedBooksSchema.parse({ items: [legacy] }).items[0].chapters[0].title,
  ).toBe(title)
  expect(
    structureInputSchema.safeParse({
      baseVersion: 0,
      operation: 'create',
      title,
    }).success,
  ).toBe(false)
  expect(
    structureInputSchema.safeParse({
      baseVersion: 1,
      operation: 'structure',
      chapters: legacy.chapters,
    }).success,
  ).toBe(false)
})

it('deletes after explicit confirmation and opens the next book', async () => {
  const user = userEvent.setup()
  const other = { ...b, bookId: 'book-two', title: '保留的作品' }
  const { managed, loadWorkspace, deleteBook } = await setup()
  const list = vi.fn(async () => [other])
  managed.management.list = list
  const draft = {
    projectId: b.bookId,
    chapterId: 'CH-unvisited',
    baseRevisionId: 'draft:old',
    markdown: '删除后不应保留的本地恢复正文。',
    idempotencyKey: 'draft-key',
    updatedAt: '2026-10-21T00:00:00.000Z',
  }
  writeLocalChapterDraft(draft)
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[b, other]}
      render={() => <BookMenu />}
    />,
  )
  await user.click(await screen.findByRole('button', { name: `当前作品：${b.title}，切换作品` }))
  await user.click(screen.getByRole('menuitem', { name: /^全部作品/ }))
  await user.click(screen.getByRole('button', { name: `删除《${b.title}》` }))
  expect(screen.getByRole('dialog', { name: '删除作品' })).toHaveTextContent(
    '无法撤销',
  )
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(deleteBook).not.toHaveBeenCalled()
  await user.click(
    await screen.findByRole('button', {
      name: `当前作品：${b.title}，切换作品`,
    }),
  )
  await user.click(screen.getByRole('menuitem', { name: /^全部作品/ }))
  await user.click(screen.getByRole('button', { name: `删除《${b.title}》` }))
  await user.click(screen.getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(deleteBook).toHaveBeenCalledWith(b.bookId, { baseVersion: b.version }, expect.any(String)))
  expect(list).toHaveBeenCalledTimes(1)
  expect(readLocalChapterDraft(b.bookId, draft.chapterId)).toBeNull()
  expect(await screen.findByRole('button', { name: `当前作品：${other.title}，切换作品` })).toBeVisible()
  expect(loadWorkspace).toHaveBeenCalledWith(other.bookId)
  expect(sessionStorage.getItem('writer-agent:selected-book')).toBe(other.bookId)
})

it('allows renaming when the adapter does not implement deletion', async () => {
  const user = userEvent.setup()
  const { managed } = await setup()
  Reflect.deleteProperty(managed.management, 'deleteBook')
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[b]}
      render={() => <BookMenu />}
    />,
  )
  await user.click(await screen.findByRole('button', { name: `当前作品：${b.title}，切换作品` }))
  expect(screen.getByRole('button', { name: '修改作品名称' })).toBeEnabled()
  await user.click(screen.getByRole('menuitem', { name: /^全部作品/ }))
  expect(screen.queryByRole('button', { name: `删除《${b.title}》` })).toBeNull()
})

it('matches the work-switcher structure and closes from the outside scrim', async () => {
  const user = userEvent.setup()
  const other = { ...b, bookId: 'book-two', title: '另一部作品' }
  const { managed } = await setup()
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[b, other]}
      render={() => <BookMenu />}
    />,
  )

  const trigger = await screen.findByRole('button', {
    name: `当前作品：${b.title}，切换作品`,
  })
  expect(trigger).toHaveAttribute('aria-pressed', 'false')
  await user.click(trigger)

  const menu = screen.getByRole('menu', { name: '作品菜单' })
  expect(menu).toBeVisible()
  expect(trigger).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByLabelText('搜索作品')).toHaveFocus()
  expect(menu).toHaveTextContent('最近编辑')
  expect(menu).toHaveTextContent('另一部作品')
  expect(menu).toHaveTextContent('全部作品')
  expect(menu).toHaveTextContent('新建空白作品')
  expect(menu).not.toHaveTextContent('删除作品')

  await user.click(document.querySelector('[data-work-menu-scrim]')!)
  expect(screen.queryByRole('menu', { name: '作品菜单' })).toBeNull()
  expect(trigger).toHaveAttribute('aria-pressed', 'false')
  await waitFor(() => expect(trigger).toHaveFocus())
})

it('opens the shelf, filters all works, and closes with Escape', async () => {
  const user = userEvent.setup()
  const other = { ...b, bookId: 'book-two', title: '江宁旧事' }
  const third = { ...b, bookId: 'book-three', title: '北港往事' }
  const { managed } = await setup()
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[b, other, third]}
      render={() => <BookMenu />}
    />,
  )

  await user.click(
    await screen.findByRole('button', {
      name: `当前作品：${b.title}，切换作品`,
    }),
  )
  await user.click(screen.getByRole('menuitem', { name: '全部作品 3' }))
  const shelf = screen.getByRole('dialog', { name: '全部作品' })
  expect(shelf).toHaveTextContent('3 部作品')
  expect(shelf).toHaveTextContent(other.title)
  expect(shelf).toHaveTextContent(third.title)
  expect(
    screen.getByRole('button', { name: `打开《${b.title}》` }),
  ).toHaveAttribute('aria-current', 'page')

  await user.type(screen.getByLabelText('搜索书架'), '江宁')
  expect(shelf).toHaveTextContent(other.title)
  expect(shelf).not.toHaveTextContent(third.title)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '全部作品' })).toBeNull()
})

it('renames and deletes any book from the shelf with explicit confirmation', async () => {
  const user = userEvent.setup()
  const other = { ...b, bookId: 'book-two', title: '待整理作品' }
  const { managed, mutate, deleteBook } = await setup()
  mutate.mockResolvedValue({ ...other, title: '整理后的作品' })
  managed.management.list = vi.fn(async () => [b])
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[b, other]}
      render={() => <BookMenu />}
    />,
  )

  await user.click(
    await screen.findByRole('button', {
      name: `当前作品：${b.title}，切换作品`,
    }),
  )
  await user.click(screen.getByRole('menuitem', { name: '全部作品 2' }))
  await user.click(
    screen.getByRole('button', { name: `修改《${other.title}》名称` }),
  )
  expect(
    screen.getByRole('dialog', { name: '修改作品名称' }),
  ).toBeVisible()
  const title = screen.getByLabelText('作品名称')
  await user.clear(title)
  await user.type(title, '整理后的作品')
  await user.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledWith(
      other.bookId,
      expect.objectContaining({ operation: 'rename', title: '整理后的作品' }),
      expect.any(String),
    ),
  )
  expect(
    await screen.findByRole('button', { name: '打开《整理后的作品》' }),
  ).toBeVisible()

  await user.click(
    screen.getByRole('button', { name: '删除《整理后的作品》' }),
  )
  expect(screen.getByRole('dialog', { name: '删除作品' })).toHaveTextContent(
    '无法撤销',
  )
  await user.click(screen.getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(deleteBook).toHaveBeenCalledTimes(1))
  expect(
    await screen.findByRole('button', { name: `打开《${b.title}》` }),
  ).toHaveAttribute('aria-current', 'page')
})

it('keeps shelf dialogs in the studio theme and reports guard failures above them', async () => {
  const user = userEvent.setup()
  const { managed } = await setup()
  const reject = vi.fn(async () => {
    throw Error('请先处理本地草稿恢复或版本冲突。')
  })
  render(
    <div className="dark" data-testid="studio-theme">
      <ManagedStudio
        adapter={managed}
        initialBooks={[b]}
        render={() => <Guarded reject={reject} />}
      />
    </div>,
  )

  await user.click(
    await screen.findByRole('button', {
      name: `当前作品：${b.title}，切换作品`,
    }),
  )
  await user.click(screen.getByRole('menuitem', { name: /^全部作品/ }))
  const shelf = screen.getByRole('dialog', { name: '全部作品' })
  expect(shelf.closest('.dark')).toBe(screen.getByTestId('studio-theme'))

  await user.click(screen.getByRole('button', { name: `修改《${b.title}》名称` }))
  const input = screen.getByLabelText('作品名称')
  await user.clear(input)
  await user.type(input, '恢复后再改名')
  await user.click(screen.getByRole('button', { name: '保存' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('本地草稿恢复')
  expect(alert).toHaveClass('z-[70]')
  expect(screen.getByRole('dialog', { name: '修改作品名称' })).toBeVisible()
})

it('filters other works and closes when Escape is pressed', async () => {
  const user = userEvent.setup()
  const other = { ...b, bookId: 'book-two', title: '江宁旧事' }
  const { managed } = await setup()
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[b, other]}
      render={() => <BookMenu />}
    />,
  )

  const trigger = await screen.findByRole('button', {
    name: `当前作品：${b.title}，切换作品`,
  })
  await user.click(trigger)
  await user.type(screen.getByLabelText('搜索作品'), '江宁')
  expect(screen.getByRole('menuitem', { name: /江宁旧事/ })).toBeVisible()
  expect(screen.queryByText('另一部作品')).toBeNull()
  expect(screen.getByRole('menuitem', { name: /^全部作品/ })).toBeVisible()

  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu', { name: '作品菜单' })).toBeNull()
  await waitFor(() => expect(trigger).toHaveFocus())
})

it('shows the empty state after deleting the only book', async () => {
  const user = userEvent.setup()
  const { managed, deleteBook } = await setup()
  render(
    <ManagedStudio
      adapter={managed}
      initialBooks={[b]}
      render={() => <BookMenu />}
    />,
  )
  await user.click(await screen.findByRole('button', { name: `当前作品：${b.title}，切换作品` }))
  await user.click(screen.getByRole('menuitem', { name: /^全部作品/ }))
  await user.click(screen.getByRole('button', { name: `删除《${b.title}》` }))
  await user.click(screen.getByRole('button', { name: '确认删除' }))
  expect(await screen.findByRole('heading', { name: '你的故事，从这里开始' })).toBeVisible()
  expect(deleteBook).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem('writer-agent:selected-book')).toBeNull()
})

it('does not report server deletion as failed when browser storage is unavailable', () => {
  const spy = vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw Error('storage unavailable') })
  localStorage.setItem('unrelated', 'preserve')
  expect(() => clearLocalChapterDrafts(b.bookId)).not.toThrow()
  spy.mockRestore()
  expect(localStorage.getItem('unrelated')).toBe('preserve')
})

it('honors an explicit owned-book URL before automatic restoration', async () => {
 const { managed } = await setup()
 window.history.replaceState({}, '', '/?book=book-two')
 render(<ManagedStudio adapter={managed} initialBooks={[b,{...b,bookId:'book-two',title:'链接作品'}]} render={()=><BookMenu />} />)
 expect(await screen.findByRole('button',{name:'当前作品：链接作品，切换作品'})).toBeVisible()
})
