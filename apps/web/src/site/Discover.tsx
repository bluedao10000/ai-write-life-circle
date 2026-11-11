import { Btn, buttonClassName, Icon } from '../components/vnext/ui'
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
  const path = mode === 'recent' ? '/discover/recent' : '/discover'
  const filtered = !!(query.q || query.category || query.status)
  const filterLink = (field: string, value: string) => {
    const params = new URLSearchParams(query)
    params.delete('cursor')
    if (value) params.set(field, value)
    else params.delete(field)
    return params.size ? `${path}?${params}` : path
  }
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
            action={path}
            method="get"
            className="mt-8 flex max-w-xl items-center gap-2"
            aria-label="搜索公开作品"
          >
            {['category', 'status', 'sort'].map((field) =>
              query[field] ? <input key={field} type="hidden" name={field} value={query[field]} /> : null,
            )}
            <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md bg-surface-2 px-3 text-ink-3 focus-within:text-ink">
              <Icon name="search" />
              <span className="sr-only">搜索书名、作者或简介</span>
              <input
                type="search"
                name="q"
                defaultValue={query.q || ''}
                placeholder="搜索书名、作者或简介"
                autoFocus={mode === 'search'}
                className="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-3"
              />
            </label>
            <Btn type="submit" variant="outline" className="h-10 px-4">搜索</Btn>
          </form>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
            {cats.length > 1 && (
              <nav aria-label="题材" className="flex flex-wrap gap-1">
                <A
                  to={filterLink('category', '')}
                  current={!query.category ? 'page' : undefined}
                  className={buttonClassName(query.category ? 'quiet' : 'primary', 'sm')}
                >全部</A>
                {cats.map((category) => (
                  <A
                    key={category}
                    to={filterLink('category', query.category === category ? '' : category)}
                    current={query.category === category ? 'page' : undefined}
                    className={buttonClassName(query.category === category ? 'primary' : 'quiet', 'sm')}
                  >{category}</A>
                ))}
              </nav>
            )}
            <nav aria-label="连载状态" className="inline-flex flex-wrap gap-0.5 rounded-md bg-surface-2 p-0.5">
              {[
                ['', '全部状态'],
                ['ongoing', '连载中'],
                ['completed', '已完结'],
                ['paused', '暂停中'],
              ].map(([value, label]) => {
                const active = (query.status || '') === value
                return (
                  <A
                    key={value}
                    to={filterLink('status', value)}
                    current={active ? 'page' : undefined}
                    className={`${buttonClassName('quiet', 'sm')} ${active ? 'bg-surface text-ink shadow-soft' : ''}`}
                  >{label}</A>
                )
              })}
            </nav>
            <nav aria-label="排序" className="inline-flex gap-0.5 rounded-md bg-surface-2 p-0.5">
              {[
                ['recent', '最近更新'],
                ['title', '书名'],
              ].map(([value, label]) => {
                const active = (query.sort || 'recent') === value
                return (
                  <A
                    key={value}
                    to={filterLink('sort', value)}
                    current={active ? 'page' : undefined}
                    className={`${buttonClassName('quiet', 'sm')} ${active ? 'bg-surface text-ink shadow-soft' : ''}`}
                  >{label}</A>
                )
              })}
            </nav>
          </div>
          <div className="mt-6 flex flex-wrap items-baseline gap-3 text-ui-sm">
            <p aria-live="polite" className="text-ink-3">
              {filtered ? `找到 ${total} 部作品` : `共 ${total} 部作品`}{query.q && ` · 搜索“${query.q}”`}
            </p>
            {filtered && <A to={path} className="text-ink-2 hover:text-ink">清除筛选</A>}
          </div>
          {books.length === 0 ? (
            <EmptyState
              title={filtered ? `没有找到${query.q ? `与“${query.q}”相关` : '符合条件'}的作品` : '还没有公开作品'}
              action={
                <A to={filtered ? path : '/studio'} variant={filtered ? 'outline' : 'primary'}>
                  {filtered ? '清除筛选' : '成为第一位作者'}
                </A>
              }
            >
              {filtered ? '试试换一个词，或者查看全部作品。' : '作品由作者发布后才会出现在这里。'}
            </EmptyState>
          ) : mode === 'recent' ? (
            <div className="mt-6 max-w-3xl">
              {books.map((b) => (
                <BookCard key={b.slug} book={b} author={authors.find((a) => a.slug === b.authorSlug)} variant="compact" />
              ))}
            </div>
          ) : (
            <>
              <div className="mt-8 hidden grid-cols-3 gap-x-6 gap-y-12 sm:grid md:grid-cols-4 lg:grid-cols-6">
                {books.map((b) => (
                  <BookCard key={b.slug} book={b} author={authors.find((a) => a.slug === b.authorSlug)} />
                ))}
              </div>
              <div className="mt-4 divide-y divide-line-soft sm:hidden">
                {books.map((b) => (
                  <BookCard key={b.slug} book={b} author={authors.find((a) => a.slug === b.authorSlug)} variant="row" />
                ))}
              </div>
            </>
          )}
          {nextCursor && (
            <div className="mt-12 text-center">
              <A to={`${path}?${next}`} variant="outline" className="h-10 px-5">下一页 →</A>
            </div>
          )}
        </Container>
      </main>
      <Footer />
    </>
  )
}
