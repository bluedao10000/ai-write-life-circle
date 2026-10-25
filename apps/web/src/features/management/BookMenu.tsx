import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { ManagedBook } from '@writer-agent/contracts'
import { useManagement } from './ManagedStudio'
import {
  Btn,
  buttonClassName,
  Dialog,
  Icon,
  IconBtn,
  TextInput,
} from '../../components/vnext/ui'

function Cover({
  title,
  active,
  size = 'sm',
}: {
  title: string
  active?: boolean
  size?: 'sm' | 'lg'
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-sm border font-prose ${
        size === 'lg' ? 'h-16 w-12 text-title' : 'h-8 w-6 text-ui-sm'
      } ${
        active
          ? 'border-accent/30 bg-surface text-ink'
          : 'border-line bg-surface-2 text-ink-2'
      }`}
    >
      {title.slice(0, 1) || '无'}
    </span>
  )
}

function chapterCount(book: ManagedBook) {
  return book.chapters.filter((chapter) => !chapter.archived).length
}

function Popover({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  if (!open) return null
  return (
    <>
      <div
        className="fixed inset-0 z-30"
        aria-hidden
        onClick={() => onClose()}
        data-work-menu-scrim
      />
      {children}
    </>
  )
}

type BookDialog =
  | { kind: 'shelf' }
  | { kind: 'rename' | 'delete'; bookId: string; returnTo?: 'shelf' }

export default function BookMenu() {
  const management = useManagement()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<BookDialog | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)

  const others = useMemo(() => {
    if (!management) return []
    const needle = query.trim()
    return management.books.filter(
      (book) =>
        book.bookId !== management.book.bookId &&
        (!needle || book.title.includes(needle)),
    )
  }, [management, query])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      restoreFocus.current = true
      setOpen(false)
      setQuery('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (open || !restoreFocus.current) return
    restoreFocus.current = false
    triggerRef.current?.focus()
  }, [open])

  if (!management) return null

  const closeMenu = (returnFocus = true) => {
    if (open) restoreFocus.current = returnFocus
    setOpen(false)
    setQuery('')
  }
  const openDialog = (next: BookDialog) => {
    closeMenu(false)
    setDialog(next)
  }
  const closeDialog = (returnTo?: 'shelf') => {
    if (returnTo) {
      setDialog({ kind: 'shelf' })
      return
    }
    setDialog(null)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const rename = async (
    book: ManagedBook,
    title: string,
    returnTo?: 'shelf',
  ) => {
    const next = await management.changeBook(book, {
      operation: 'rename',
      title,
    })
    if (next) closeDialog(returnTo)
    return Boolean(next)
  }
  const remove = async (book: ManagedBook, returnTo?: 'shelf') => {
    const deleted = await management.deleteBook(book)
    if (deleted) closeDialog(returnTo)
    return deleted
  }

  const renaming =
    dialog?.kind === 'rename'
      ? management.books.find((book) => book.bookId === dialog.bookId)
      : undefined
  const deleting =
    dialog?.kind === 'delete'
      ? management.books.find((book) => book.bookId === dialog.bookId)
      : undefined
  const portalHost =
    triggerRef.current?.closest('.dark') ??
    (typeof document === 'undefined' ? null : document.body)
  const overlays =
    dialog?.kind === 'shelf' ? (
      <ShelfDialog
        books={management.books}
        currentId={management.book.bookId}
        canImport={management.canImport}
        canDelete={management.canDelete}
        onClose={() => closeDialog()}
        onOpen={(book) => {
          setDialog(null)
          management.switchBook(book)
        }}
        onRename={(book) =>
          setDialog({ kind: 'rename', bookId: book.bookId, returnTo: 'shelf' })
        }
        onDelete={(book) =>
          setDialog({ kind: 'delete', bookId: book.bookId, returnTo: 'shelf' })
        }
        onCreate={() => {
          setDialog(null)
          management.create()
        }}
        onImport={() => {
          setDialog(null)
          management.openImport()
        }}
      />
    ) : renaming ? (
      <RenameBookDialog
        book={renaming}
        onClose={() => closeDialog(dialog?.returnTo)}
        onSave={(title) => rename(renaming, title, dialog?.returnTo)}
      />
    ) : deleting ? (
      <DeleteBookDialog
        book={deleting}
        onClose={() => closeDialog(dialog?.returnTo)}
        onDelete={() => remove(deleting, dialog?.returnTo)}
      />
    ) : null

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        className={`${buttonClassName(
          'quiet',
          'sm',
        )} max-w-full gap-2 pl-1`}
        aria-label={`当前作品：${management.book.title}，切换作品`}
        aria-pressed={open}
        data-current-book-id={management.book.bookId}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className="flex h-8 w-6 shrink-0 items-center justify-center rounded-sm border border-line bg-surface-2 font-prose text-ui-sm text-ink-2"
          aria-hidden
        >
          {management.book.title.slice(0, 1) || '无'}
        </span>
        <span className="min-w-0 truncate font-prose text-ui text-ink max-sm:hidden">
          {management.book.title}
        </span>
        <Icon name="chevronDown" className="text-ink-3" />
      </button>

      <Popover open={open} onClose={closeMenu}>
        <div
          role="menu"
          aria-label="作品菜单"
          className="fade-up absolute top-full left-0 z-40 mt-1 grid max-h-[min(34rem,calc(100dvh-4rem))] w-80 max-w-[calc(100vw-4rem)] origin-top-left grid-rows-[auto_auto_1fr_auto] gap-1 overflow-hidden rounded-xl border border-line-soft bg-surface p-1.5 shadow-soft"
        >
          <div className="p-1">
            <TextInput
              label="搜索作品"
              value={query}
              onChange={setQuery}
              placeholder="搜索作品"
              autoFocus
            />
          </div>

          {!query.trim() && (
            <div className="m-1 flex items-center gap-3 rounded-lg bg-accent-soft px-2.5 py-2">
              <Cover title={management.book.title} active />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 font-prose text-ui-lg text-ink">
                  <span className="truncate">{management.book.title}</span>
                  <Icon name="check" className="text-accent" />
                </div>
                <div className="mt-0.5 text-micro text-ink-3">
                  {chapterCount(management.book)} 章
                </div>
              </div>
              <IconBtn
                icon="edit"
                size="sm"
                label="修改作品名称"
                disabled={management.book.readOnly}
                onClick={() =>
                  openDialog({
                    kind: 'rename',
                    bookId: management.book.bookId,
                  })
                }
              />
            </div>
          )}

          <div className="scroll min-h-0 overflow-y-auto">
            <div className="px-2.5 pt-2 pb-1 text-micro text-ink-3">
              {query.trim() ? '搜索结果' : '最近编辑'}
            </div>
            {others.length === 0 && (
              <p className="px-2.5 py-2 text-ui-sm text-ink-3">
                {query.trim() ? '没有匹配的作品' : '只有这一部作品'}
              </p>
            )}
            {others.slice(0, 4).map((book) => (
              <button
                key={book.bookId}
                type="button"
                role="menuitem"
                className="btn flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-ink hover:bg-surface-2"
                onClick={() => {
                  closeMenu()
                  management.switchBook(book)
                }}
              >
                <Cover title={book.title} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-prose text-ui text-ink">
                    {book.title}
                  </span>
                  <span className="mt-0.5 block text-micro text-ink-3">
                    {chapterCount(book)} 章
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="border-t border-line-soft p-0.5">
            <button
              type="button"
              role="menuitem"
              className="btn flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ink-2 hover:bg-surface-2 hover:text-ink"
              onClick={() => openDialog({ kind: 'shelf' })}
            >
              <Icon name="grid" />
              全部作品
              <span className="ml-auto text-micro tabular-nums text-ink-3">
                {management.books.length}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="btn flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ink-2 hover:bg-surface-2 hover:text-ink"
              onClick={() => {
                closeMenu()
                management.create()
              }}
            >
              <Icon name="plus" />
              新建空白作品
            </button>
            {management.canImport && (
              <button
                type="button"
                role="menuitem"
                className="btn flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-ink-2 hover:bg-surface-2 hover:text-ink"
                onClick={() => {
                  closeMenu()
                  management.openImport()
                }}
              >
                <Icon name="upload" />
                从 EPUB 导入
                <span className="ml-auto text-micro text-ink-3">
                  EPUB 2 / 3
                </span>
              </button>
            )}
            {management.book.readOnly && (
              <p className="px-2 py-2 text-micro text-ink-3">
                当前为外部只读作品；正文仍可保存。
              </p>
            )}
          </div>
        </div>
      </Popover>

      {overlays && portalHost && createPortal(overlays, portalHost)}
    </div>
  )
}

function ShelfDialog({
  books,
  currentId,
  canImport,
  canDelete,
  onClose,
  onOpen,
  onRename,
  onDelete,
  onCreate,
  onImport,
}: {
  books: ManagedBook[]
  currentId: string
  canImport: boolean
  canDelete: boolean
  onClose: () => void
  onOpen: (book: ManagedBook) => void
  onRename: (book: ManagedBook) => void
  onDelete: (book: ManagedBook) => void
  onCreate: () => void
  onImport: () => void
}) {
  const [query, setQuery] = useState('')
  const filtered = books.filter((book) =>
    book.title.includes(query.trim()),
  )

  return (
    <Dialog
      size="xl"
      label="全部作品"
      title={
        <span className="flex items-baseline gap-2">
          书架
          <span className="text-ui text-ink-3">{books.length} 部作品</span>
        </span>
      }
      onClose={onClose}
      actions={
        <>
          <Btn variant="outline" onClick={onCreate}>
            <Icon name="plus" />
            新建空白作品
          </Btn>
          {canImport && (
            <Btn variant="outline" onClick={onImport}>
              <Icon name="upload" />
              从 EPUB 导入
            </Btn>
          )}
        </>
      }
    >
      <TextInput
        label="搜索书架"
        value={query}
        onChange={setQuery}
        placeholder="按名称搜索"
        className="mb-4"
        autoFocus
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {filtered.map((book) => {
          const current = book.bookId === currentId
          return (
            <div
              key={book.bookId}
              data-book-card={book.bookId}
              className={`flex gap-3 rounded-xl border p-3 ${
                current ? 'border-accent' : 'border-line'
              }`}
            >
              <button
                type="button"
                aria-label={`打开《${book.title}》`}
                aria-current={current ? 'page' : undefined}
                data-book-id={book.bookId}
                className="btn flex min-w-0 flex-1 gap-3 rounded-lg p-1 text-left hover:bg-surface-2"
                onClick={() => onOpen(book)}
              >
                <Cover title={book.title} size="lg" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-prose text-ui-lg text-ink">
                      {book.title}
                    </span>
                    {current && (
                      <span className="shrink-0 text-micro text-accent">
                        当前
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-micro text-ink-3">
                    {chapterCount(book)} 章
                    {book.readOnly ? ' · 外部只读资料' : ''}
                  </span>
                </span>
              </button>
              <div className="flex flex-col gap-0.5">
                <IconBtn
                  icon="edit"
                  size="sm"
                  label={`修改《${book.title}》名称`}
                  disabled={book.readOnly}
                  onClick={() => onRename(book)}
                />
                {canDelete && (
                  <IconBtn
                    icon="trash"
                    size="sm"
                    label={`删除《${book.title}》`}
                    disabled={book.readOnly}
                    onClick={() => onDelete(book)}
                  />
                )}
              </div>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <p className="text-ui text-ink-3">没有匹配的作品。</p>
        )}
      </div>
    </Dialog>
  )
}

function RenameBookDialog({
  book,
  onClose,
  onSave,
}: {
  book: ManagedBook
  onClose: () => void
  onSave: (title: string) => Promise<boolean>
}) {
  const [title, setTitle] = useState(book.title)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    const next = title.trim()
    if (!next || next === book.title || saving || book.readOnly) return
    setSaving(true)
    const changed = await onSave(next)
    if (!changed) setSaving(false)
  }
  return (
    <Dialog
      label="修改作品名称"
      title="修改作品名称"
      onClose={onClose}
      actions={
        <>
          <Btn variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Btn>
          <Btn
            variant="primary"
            disabled={saving || !title.trim() || title.trim() === book.title}
            onClick={() => void submit()}
          >
            保存
          </Btn>
        </>
      }
    >
      <label className="grid gap-1.5">
        <span className="text-ui-sm text-ink-3">作品名称</span>
        <input
          aria-label="作品名称"
          autoFocus
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            void submit()
          }}
          className="h-9 rounded-md border border-line bg-page px-3 font-prose text-ui text-ink focus:border-ink-3"
        />
      </label>
      <p className="mt-3 text-ui-sm text-ink-3">
        只修改 Writer Studio 的私有作品名称；已发布版本仍需在发布管理中确认。
      </p>
    </Dialog>
  )
}

function DeleteBookDialog({
  book,
  onClose,
  onDelete,
}: {
  book: ManagedBook
  onClose: () => void
  onDelete: () => Promise<boolean>
}) {
  const [deleting, setDeleting] = useState(false)
  const confirm = async () => {
    if (deleting || book.readOnly) return
    setDeleting(true)
    const deleted = await onDelete()
    if (!deleted) setDeleting(false)
  }
  return (
    <Dialog
      size="lg"
      label="删除作品"
      title={
        <span className="flex items-center gap-2 text-danger">
          <Icon name="alert" />
          永久删除《{book.title}》？
        </span>
      }
      onClose={onClose}
      actions={
        <>
          <Btn variant="outline" disabled={deleting} onClick={onClose}>
            取消
          </Btn>
          <Btn
            variant="danger"
            disabled={deleting || book.readOnly}
            onClick={() => void confirm()}
          >
            <Icon name="trash" />
            确认删除
          </Btn>
        </>
      }
    >
      <p>
        删除后无法恢复。正文与全部历史版本、作品知识、作者笔记、审查记录和私有设置都会一并删除；此操作无法撤销。
      </p>
      {book.readOnly && (
        <p className="mt-3 text-ui-sm text-danger">
          外部只读作品的资料不能在这里删除。
        </p>
      )}
    </Dialog>
  )
}
