import {
  A,
  BookCard,
  Container,
  EmptyState,
  Footer,
  Header,
  useCatalog,
} from './kit'
export default function Discover({ mode }: { mode?: string }) {
  const { books, authors, cats, total, query, nextCursor } = useCatalog()
  const clear = Object.keys(query).some((key) => query[key] && key !== 'cursor')
  const next = new URLSearchParams(query)
  if (nextCursor) next.set('cursor', nextCursor)
  return (
    <>
      <Header
        onSearch={() =>
          document.querySelector<HTMLInputElement>('input[name=q]')?.focus()
        }
      />
      <main>
        <Container className="pt-10 md:pt-16">
          <h1 className="font-prose text-display font-medium text-ink">
            {mode === 'recent' ? '最近更新' : query.category || '发现作品'}
          </h1>
          <form
            action={mode === 'recent' ? '/discover/recent' : '/discover'}
            method="get"
            className="mt-8 space-y-6"
            aria-label="筛选公开作品"
          >
            <label className="block max-w-xl rounded-md bg-surface-2 px-3 py-2 text-ui text-ink">
              <span className="sr-only">搜索书名、作者或简介</span>
              <input
                name="q"
                aria-label="搜索书名、作者或简介"
                defaultValue={query.q || ''}
                placeholder="搜索书名、作者或简介"
                className="h-6 w-full bg-transparent outline-none"
              />
            </label>
            <div className="flex flex-wrap items-center gap-4 text-ui text-ink-2">
              <label>
                题材{' '}
                <select
                  name="category"
                  defaultValue={query.category || ''}
                  className="rounded border border-line bg-page p-2"
                >
                  <option value="">全部题材</option>
                  {cats.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                连载状态{' '}
                <select
                  name="status"
                  defaultValue={query.status || ''}
                  className="rounded border border-line bg-page p-2"
                >
                  <option value="">全部状态</option>
                  <option value="ongoing">连载中</option>
                  <option value="completed">已完结</option>
                  <option value="paused">暂停中</option>
                </select>
              </label>
              <label>
                排序{' '}
                <select
                  name="sort"
                  defaultValue={query.sort || 'recent'}
                  className="rounded border border-line bg-page p-2"
                >
                  <option value="recent">最近更新</option>
                  <option value="title">书名</option>
                </select>
              </label>
              <button
                type="submit"
                className="btn rounded-md bg-ink px-4 py-2 text-page"
              >
                搜索
              </button>
              {clear && (
                <A to="/discover" className="text-accent">
                  清除筛选
                </A>
              )}
            </div>
          </form>
          <p aria-live="polite" className="mt-6 text-ui-sm text-ink-3">
            共 {total} 部作品{query.q && ` · 搜索“${query.q}”`}
          </p>
          {books.length === 0 ? (
            <EmptyState
              title={clear ? '没有找到符合条件的作品' : '还没有公开作品'}
              action={
                <A to={clear ? '/discover' : '/studio'} className="text-accent">
                  {clear ? '清除筛选' : '成为第一位作者'}
                </A>
              }
            >
              作品由作者发布后才会出现在这里。
            </EmptyState>
          ) : mode === 'recent' ? (
            <div className="mt-6 max-w-3xl">
              {books.map((b) => (
                <BookCard
                  key={b.slug}
                  book={b}
                  author={authors.find((a) => a.slug === b.authorSlug)}
                  variant="compact"
                />
              ))}
            </div>
          ) : (
            <>
              <div className="mt-8 hidden grid-cols-3 gap-x-6 gap-y-12 sm:grid md:grid-cols-4 lg:grid-cols-6">
                {books.map((b) => (
                  <BookCard
                    key={b.slug}
                    book={b}
                    author={authors.find((a) => a.slug === b.authorSlug)}
                  />
                ))}
              </div>
              <div className="mt-4 divide-y divide-line-soft sm:hidden">
                {books.map((b) => (
                  <BookCard
                    key={b.slug}
                    book={b}
                    author={authors.find((a) => a.slug === b.authorSlug)}
                    variant="row"
                  />
                ))}
              </div>
            </>
          )}
          {nextCursor && (
            <div className="mt-12 text-center">
              <A
                to={`/discover?${next}`}
                className="inline-block rounded-md border border-line px-5 py-2 text-ui text-ink"
              >
                下一页 →
              </A>
            </div>
          )}
        </Container>
      </main>
      <Footer />
    </>
  )
}
