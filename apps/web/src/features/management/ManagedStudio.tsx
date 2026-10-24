import { createContext, useContext, useRef, useState, useEffect, type ReactNode } from 'react'
import type { ManagedBook, StructureInput, WorkspaceSnapshot } from '@writer-agent/contracts'
import type { WriterAgentAdapter } from '../../services/writerAgent'
import { clearLocalChapterDrafts } from '../../services/localChapterDraft'
import EPUBImportDialog from './EPUBImportDialog'

type ManagementUI = {
  book: ManagedBook
  books: ManagedBook[]
  editing: string | null
  setEditing: (id: string | null) => void
  preferences: { current: WorkspaceSnapshot['preferences'] }
  activeChapter: { current: string }
  protect: (action: () => Promise<void>) => void
  guard: { current: (() => Promise<void>) | null }
  change: (
    input: Omit<StructureInput, 'baseVersion'>,
    focus?: string,
  ) => Promise<ManagedBook | undefined>
  changeBook: (
    target: ManagedBook,
    input: Omit<StructureInput, 'baseVersion'>,
    focus?: string,
  ) => Promise<ManagedBook | undefined>
  switchBook: (book: ManagedBook) => void
  deleteBook: (target?: ManagedBook) => Promise<boolean>
  canDelete: boolean
  create: () => void
  openImport: () => void
  canImport: boolean
}
export const ManagementContext = createContext<ManagementUI | null>(null)
export function useManagement() {
  return useContext(ManagementContext)
}
const selectedKey = 'writer-agent:selected-book'
const createKey = 'writer-agent:pending-create-book'
function stored(key: string) {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
function remember(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch {
    /* persistence is a convenience; server receipts remain authoritative */
  }
}

export default function ManagedStudio({
  adapter,
  initialBooks,
  render,
}: {
  adapter: WriterAgentAdapter
  initialBooks: ManagedBook[]
  render: (workspace: WorkspaceSnapshot, generation: number) => ReactNode
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [books, setBooks] = useState(initialBooks)
  const [book, setBook] = useState<ManagedBook | null>(
    initialBooks.find((b) => b.bookId === stored(selectedKey)) ?? initialBooks[0] ?? null,
  )
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [generation, setGeneration] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const activeChapter = useRef('')
  const preferences = useRef<WorkspaceSnapshot['preferences']>(undefined)
  const guard = useRef<(() => Promise<void>) | null>(null)
  const pending = useRef<{ signature: string; key: string } | null>(null)
  const lock = useRef(false)
  const initial = useRef(book)
  useEffect(() => {
    let active = true
    void (async () => {
      let selected = initial.current
      const pendingCreate = stored(createKey)
      if (selected && pendingCreate && adapter.management) {
        // Recover the exact author intent after a committed response was lost.
        selected = await adapter.management.mutate(
          null,
          { operation: 'create', baseVersion: 0 },
          pendingCreate,
        )
      }
      if (!selected) return
      const value = await adapter.loadWorkspace(selected.bookId)
      if (!active) return
      setSnapshot({ ...value, projectTitle: selected.title })
      setBook(selected)
      const recovered = selected
      setBooks((all) =>
        all.some((b) => b.bookId === recovered.bookId) ? all : [...all, recovered],
      )
      remember(selectedKey, selected.bookId)
      if (pendingCreate) remember(createKey, null)
    })().catch((e) => {
      if (active) setError(e instanceof Error ? e.message : '作品读取失败，请重试。')
    })
    return () => {
      active = false
    }
  }, [adapter])
  const open = async (next: ManagedBook, focus?: string) => {
    const value = await adapter.loadWorkspace(next.bookId)
    const current = focus ?? (next.bookId === book?.bookId ? activeChapter.current : undefined)
    setSnapshot({
      ...value,
      projectTitle: next.title,
      preferences: {
        theme: value.preferences?.theme ?? 'light',
        ...value.preferences,
        ...(next.bookId === book?.bookId ? preferences.current : {}),
      },
      ...(current && value.chapters.some((c) => c.id === current)
        ? {
            currentChapterId: current,
            preferences: {
              theme: value.preferences?.theme ?? 'light',
              ...value.preferences,
              ...(next.bookId === book?.bookId ? preferences.current : {}),
              lastChapterId: current,
            },
          }
        : {}),
      chapters: value.chapters.map((c) => ({
        ...c,
        volume:
          next.volumes.find(
            (v) => v.volumeId === next.chapters.find((x) => x.chapterId === c.id)?.volumeId,
          )?.title ?? c.volume,
      })),
    })
    setBook(next)
    remember(selectedKey, next.bookId)
    setGeneration((n) => n + 1)
  }
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      await guard.current?.()
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请保留正文后重试。')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const changeBook = async (
    target: ManagedBook,
    input: Omit<StructureInput, 'baseVersion'>,
    focus?: string,
  ) => {
    let result: ManagedBook | undefined
    await run(async () => {
      if (!adapter.management || target.readOnly)
        throw Error('外部作品资料的目录只读，请新建在线作品。')
      const body = { ...input, baseVersion: target.version }
      const signature = JSON.stringify({ bookId: target.bookId, ...body })
      if (pending.current?.signature !== signature)
        pending.current = { signature, key: crypto.randomUUID() }
      const next = await adapter.management.mutate(
        target.bookId,
        body,
        pending.current.key,
      )
      if (book?.bookId === target.bookId) {
        // Keep the receipt until workspace reload succeeds, so a failed reload can safely replay.
        await open(next, focus === 'new' ? next.chapters.at(-1)?.chapterId : focus)
      } else {
        setBook((current) => (current?.bookId === next.bookId ? next : current))
      }
      pending.current = null
      setBooks((all) => all.map((b) => (b.bookId === next.bookId ? next : b)))
      result = next
    })
    return result
  }
  const change = (
    input: Omit<StructureInput, 'baseVersion'>,
    focus?: string,
  ) => (book ? changeBook(book, input, focus) : Promise.resolve(undefined))
  const create = () => {
    void run(async () => {
      if (!adapter.management) return
      const key = stored(createKey) ?? crypto.randomUUID()
      remember(createKey, key)
      const next = await adapter.management.mutate(
        null,
        { operation: 'create', baseVersion: 0 },
        key,
      )
      await open(next, next.chapters[0]?.chapterId)
      remember(createKey, null)
      setBooks((all) => (all.some((b) => b.bookId === next.bookId) ? all : [...all, next]))
    })
  }
  const deleteBook = async (target = book) => {
    if (!target || !adapter.management?.deleteBook || target.readOnly) return false
    const currentID = target.bookId
    const deletingCurrent = book?.bookId === currentID
    let deleted = false
    await run(async () => {
      await adapter.management!.deleteBook!(
        currentID,
        { baseVersion: target.version },
        crypto.randomUUID(),
      )
      clearLocalChapterDrafts(currentID)
      if (deletingCurrent) {
        setBook(null)
        setSnapshot(null)
        remember(selectedKey, null)
        setEditing(null)
      }
      let remaining = books.filter((item) => item.bookId !== currentID)
      try {
        remaining = (await adapter.management!.list()).filter((item) => item.bookId !== currentID)
      } catch {
        setError('作品已删除，最新目录暂时无法读取，请稍后刷新目录。')
      }
      setBooks(remaining)
      pending.current = null
      if (!deletingCurrent) {
        deleted = true
        return
      }
      const next = remaining[0]
      if (!next) {
        setBook(null)
        setSnapshot(null)
        remember(selectedKey, null)
        setEditing(null)
        setGeneration((n) => n + 1)
        deleted = true
        return
      }
      await open(next)
      setEditing(null)
      deleted = true
    })
    return deleted
  }
  const canImport = Boolean(
    adapter.management?.uploadEPUB &&
      adapter.management.commitImport &&
      adapter.management.deleteImport,
  )
  const canDelete = Boolean(adapter.management?.deleteBook)
  const openImport = () => {
    if (!canImport) {
      setError('当前适配器尚未连接 EPUB 导入服务。')
      return
    }
    setError('')
    setImporting(true)
  }
  const refresh = () => {
    void run(async () => {
      if (!adapter.management) return
      let preferred = book?.bookId
      const pendingCreate = stored(createKey)
      if (pendingCreate) {
        const recovered = await adapter.management.mutate(
          null,
          { operation: 'create', baseVersion: 0 },
          pendingCreate,
        )
        preferred = recovered.bookId
        remember(createKey, null)
      }
      const fresh = await adapter.management.list()
      setBooks(fresh)
      const next = fresh.find((b) => b.bookId === preferred) ?? fresh[0]
      if (next) await open(next)
      else {
        setBook(null)
        setSnapshot(null)
        remember(selectedKey, null)
        setEditing(null)
      }
    })
  }
  return (
    <div className="relative h-dvh">
      {error && (
        <div
          role="alert"
          className="absolute inset-x-0 top-12 z-[70] flex gap-3 border bg-page p-3 text-danger"
        >
          {error}
          <button onClick={refresh}>刷新目录</button>
          <button onClick={() => setError('')}>关闭提示</button>
        </div>
      )}
      {busy && (
        <div role="status" className="absolute right-4 bottom-4 z-50 rounded border bg-page p-3">
          正在安全保存并更新作品…
        </div>
      )}
      {importing && adapter.management?.uploadEPUB && adapter.management.commitImport && adapter.management.deleteImport && (
        <EPUBImportDialog
          adapter={adapter.management}
          onCancel={() => setImporting(false)}
          onComplete={(next) => {
            void run(async () => {
              setBooks((all) => [...all.filter((item) => item.bookId !== next.bookId), next])
              await open(next, next.chapters[0]?.chapterId)
              setImporting(false)
            })
          }}
        />
      )}
      <div inert={busy} className="h-full">
        {!book ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 bg-page px-6 text-center text-ink">
            <h1 className="font-prose text-2xl">你的故事，从这里开始</h1>
            <p className="text-ink-2">先写下第一章。书名、卷名和其他资料，都可以以后再整理。</p>
            <button className="btn rounded border px-5 py-2" onClick={create}>
              开始写作
            </button>
            {canImport && (
              <button className="btn rounded border px-5 py-2" onClick={openImport}>
                从 EPUB 导入作品
              </button>
            )}
          </div>
        ) : snapshot ? (
          <ManagementContext.Provider
            value={{
              book,
              books,
              preferences,
              activeChapter,
              protect: (action) => {
                void run(action)
              },
              editing,
              setEditing,
              guard,
              change,
              changeBook,
              create,
              deleteBook,
              canDelete,
              openImport,
              canImport,
              switchBook: (next) => {
                if (next.bookId !== book.bookId) void run(() => open(next))
              },
            }}
          >
            {render(snapshot, generation)}
          </ManagementContext.Provider>
        ) : (
          <div role="status" className="p-8">
            正在读取作品…
          </div>
        )}
      </div>
    </div>
  )
}
