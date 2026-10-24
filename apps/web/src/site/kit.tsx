import { useState, type ReactNode } from 'react'
import { buttonClassName, IconBtn } from '../components/vnext/ui'
import { latest, when, type PublicAuthor, type PublicBook } from './data'
import { go, href, prefs } from './store'

export { useCatalog } from './context'

export function A({
  to,
  children,
  className = '',
  label,
  growth,
  variant,
}: {
  to: string
  children: ReactNode
  className?: string
  label?: string
  variant?: 'primary' | 'outline' | 'quiet'
  growth?: 'next_chapter'
}) {
  return (
    <a
      data-growth={growth}
      href={href(to)}
      aria-label={label}
      className={`${variant ? buttonClassName(variant) : 'btn'} ${className}`}
    >
      {children}
    </a>
  )
}

/** Cover. Author palette is content data; with no cover, a typographic default is drawn from the title. */
export function Cover({
  book,
  size = 'md',
  className = '',
}: {
  book: PublicBook
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}) {
  const c = book.cover
  const w = {
    sm: 'w-14',
    md: 'w-full',
    lg: 'w-full max-w-60',
    xl: 'w-full max-w-80',
  }[size]
  const t = {
    sm: 'text-micro',
    md: 'text-ui-lg',
    lg: 'text-title',
    xl: 'text-display',
  }[size]
  return (
    <div
      role="img"
      aria-label={`《${book.title}》封面`}
      className={`relative aspect-[2/3] shrink-0 overflow-hidden rounded-sm shadow-soft ${w} ${c ? '' : 'bg-surface-2'} ${className}`}
      style={c ? { background: c.bg, color: c.fg } : undefined}
    >
      {c?.mark === 'circle' && (
        <div className="absolute top-[18%] left-1/2 aspect-square w-1/2 -translate-x-1/2 rounded-full border border-current opacity-40" />
      )}
      {c?.mark === 'wave' && (
        <svg
          aria-hidden
          viewBox="0 0 100 40"
          className="absolute top-[30%] w-full opacity-35"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.6"
        >
          {[0, 6, 12, 18].map((y) => (
            <path key={y} d={`M0 ${10 + y} q12.5 -6 25 0 t25 0 t25 0 t25 0`} />
          ))}
        </svg>
      )}
      {c?.mark === 'grid' && (
        <div className="absolute inset-[12%] bottom-[45%] border border-current opacity-30 [background-image:linear-gradient(currentColor_1px,transparent_1px),linear-gradient(90deg,currentColor_1px,transparent_1px)] [background-size:20%_25%]" />
      )}
      <div
        className={`absolute inset-x-0 bottom-0 p-[10%] ${c ? '' : 'text-ink'}`}
      >
        {c?.mark === 'rule' && (
          <div className="mb-3 h-px w-8 bg-current opacity-60" />
        )}
        {size !== 'sm' && (
          <div className={`font-prose font-medium leading-tight ${t}`}>
            {book.title}
          </div>
        )}
        {size === 'sm' && (
          <div className="font-prose text-micro leading-tight">
            {book.title.slice(0, 4)}
          </div>
        )}
      </div>
      {book.coverUrl && (
        <img
          src={book.coverUrl}
          alt={book.title}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {!c && !book.coverUrl && (
        <div className="absolute top-[10%] left-[10%] font-prose text-display text-ink-4">
          {book.title.slice(0, 1)}
        </div>
      )}
    </div>
  )
}

export function Meta({
  book,
  author,
  linked = true,
}: {
  book: PublicBook
  author?: PublicAuthor
  linked?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-ui-sm text-ink-3">
      {author &&
        (linked ? (
          <A
            to={`/authors/${author.slug}`}
            className="text-ink-2 hover:text-ink"
          >
            {author.name}
          </A>
        ) : (
          <span className="text-ink-2">{author.name}</span>
        ))}
      {author && <span aria-hidden>·</span>}
      <span>{book.categories.join(' / ')}</span>
      <span aria-hidden>·</span>
      <span className={book.status === '连载中' ? 'text-ok' : ''}>
        {book.status}
      </span>
    </div>
  )
}

export function DemoMark({ book }: { book: PublicBook }) {
  if (!book.demo) return null
  return (
    <span
      className="inline-flex rounded border border-dashed border-line px-1.5 text-micro text-ink-3"
      title="原型演示内容，不是真实发布的作品"
    >
      演示作品
    </span>
  )
}

/** BookCard — grid (default), compact (recent updates list), row (mobile list). */
export function BookCard({
  book,
  author,
  variant = 'grid',
}: {
  book: PublicBook
  author?: PublicAuthor
  variant?: 'grid' | 'compact' | 'row'
}) {
  const l = latest(book)
  const to = `/books/${book.slug}`
  if (variant === 'compact')
    return (
      <A
        to={to}
        className="group flex items-center gap-4 rounded-md py-3 hover:bg-surface-2 sm:-mx-3 sm:px-3"
      >
        <Cover book={book} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-prose text-ui-lg text-ink">
              {book.title}
            </span>
            <span className="hidden shrink-0 text-ui-sm text-ink-3 sm:inline">
              {author?.name}
            </span>
          </div>
          <div className="truncate text-ui-sm text-ink-2">
            更新至 第 {l.no} 章 · {l.title}
          </div>
        </div>
        <div className="shrink-0 text-right text-micro text-ink-3">
          <div>{when(l.publishedAt)}</div>
          <div className={book.status === '连载中' ? 'text-ok' : ''}>
            {book.status}
          </div>
        </div>
      </A>
    )
  if (variant === 'row')
    return (
      <A to={to} className="flex gap-4 py-3">
        <div className="w-20 shrink-0">
          <Cover book={book} />
        </div>
        <div className="min-w-0">
          <div className="font-prose text-ui-lg text-ink">{book.title}</div>
          <div className="mt-0.5">
            <Meta book={book} author={author} linked={false} />
          </div>
          <p className="mt-1.5 line-clamp-2 text-ui-sm text-ink-2">
            {book.hook}
          </p>
        </div>
      </A>
    )
  return (
    <A to={to} className="group block">
      <div className="transition-transform duration-300 group-hover:-translate-y-1">
        <Cover book={book} />
      </div>
      <div className="mt-3 font-prose text-ui-lg text-ink group-hover:underline group-hover:underline-offset-4">
        {book.title}
      </div>
      <div className="mt-0.5 text-ui-sm text-ink-3">
        {author?.name} · {book.status}
      </div>
      <p className="mt-1.5 line-clamp-2 text-ui-sm text-ink-2">{book.hook}</p>
      <div className="mt-1.5 text-micro text-ink-3">
        第 {l.no} 章 · {when(l.publishedAt)}
      </div>
    </A>
  )
}

export function Container({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`mx-auto w-full max-w-site px-5 sm:px-8 lg:px-12 ${className}`}
    >
      {children}
    </div>
  )
}

export function SectionHead({
  title,
  sub,
  more,
}: {
  title: string
  sub?: string
  more?: { label: string; to: string }
}) {
  return (
    <div className="mb-8 flex items-end gap-4">
      <div>
        <h2 className="font-prose text-title font-medium text-ink">{title}</h2>
        {sub && <p className="mt-1 text-ui text-ink-3">{sub}</p>}
      </div>
      {more && (
        <A
          to={more.to}
          className="ml-auto shrink-0 text-ui text-ink-2 hover:text-ink"
        >
          {more.label} →
        </A>
      )}
    </div>
  )
}

export function Header({ onSearch }: { onSearch?: () => void }) {
  const [open, setOpen] = useState(false)
  const p = prefs.use()
  const links: [string, string][] = [
    ['/discover', '发现作品'],
    ['/discover/categories', '分类'],
    ['/discover/recent', '最近更新'],
  ]
  return (
    <header className="sticky top-0 z-30 bg-page/90 backdrop-blur">
      <Container className="flex h-16 items-center gap-6">
        <A
          to="/"
          className="font-prose text-ui-lg font-medium tracking-wide text-ink"
          label="story2u 首页"
        >
          story2u
        </A>
        <nav aria-label="主导航" className="hidden items-center gap-5 md:flex">
          {links.map(([to, l]) => (
            <A key={to} to={to} className="text-ui text-ink-2 hover:text-ink">
              {l}
            </A>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <IconBtn
            icon="search"
            label="搜索作品"
            onClick={() => (onSearch ? onSearch() : go('/discover/search'))}
          />
          <IconBtn
            icon={p.dark ? 'sun' : 'moon'}
            label={p.dark ? '浅色' : '深色'}
            onClick={() => prefs.set((x) => ({ ...x, dark: !x.dark }))}
          />
          <A
            to="/studio"
            className="ml-2 hidden h-8 items-center rounded-md px-3 text-ui text-ink-2 hover:bg-surface-2 hover:text-ink md:inline-flex"
          >
            创作者 · Writer Studio
          </A>
          <span className="ml-1 hidden md:inline-flex">
            <A to="/studio" variant="outline" className="">
              登录
            </A>
          </span>
          <span className="md:hidden">
            <IconBtn
              icon="menu"
              label="菜单"
              onClick={() => setOpen(!open)}
              active={open}
            />
          </span>
        </div>
      </Container>
      {open && (
        <nav
          aria-label="移动导航"
          className="fade-up border-t border-line-soft bg-page px-5 pt-2 pb-5 md:hidden"
        >
          {links.map(([to, l]) => (
            <A
              key={to}
              to={to}
              className="block py-3 font-prose text-ui-lg text-ink"
            >
              {l}
            </A>
          ))}
          <div className="mt-3 flex gap-2">
            <A
              to="/studio"
              className="inline-flex h-9 items-center rounded-md bg-ink px-4 text-ui text-page"
            >
              进入 Writer Studio
            </A>
            <A to="/studio" variant="outline" className="">
              登录
            </A>
          </div>
        </nav>
      )}
    </header>
  )
}

export function Footer() {
  const cols: [string, [string, string][]][] = [
    [
      'story2u',
      [
        ['/about', '关于 story2u'],
        ['/discover', '发现作品'],
      ],
    ],
    [
      '创作者',
      [
        ['/writers', '成为创作者'],
        ['/studio', 'Writer Studio 创作工具'],
      ],
    ],
    [
      '政策',
      [
        ['/policy/content', '版权与内容政策'],
        ['/policy/privacy', '隐私政策'],
        ['/contact', '联系我们'],
      ],
    ],
  ]
  return (
    <footer className="mt-32 bg-paper">
      <Container className="grid gap-10 py-14 sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <div className="font-prose text-ui-lg font-medium text-ink">
            story2u
          </div>
          <p className="mt-2 max-w-xs text-ui-sm text-ink-3">
            Writer Agent 帮助作者创造故事，story2u 帮助故事遇见读者。
          </p>
        </div>
        {cols.map(([t, ls]) => (
          <div key={t}>
            <div className="text-ui-sm font-medium text-ink-2">{t}</div>
            <ul className="mt-3 space-y-2">
              {ls.map(([to, l]) => (
                <li key={to}>
                  <A to={to} className="text-ui-sm text-ink-3 hover:text-ink">
                    {l}
                  </A>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Container>
      <Container className="pb-10 text-micro text-ink-3">
        原创故事，由作者亲自发布。
      </Container>
    </footer>
  )
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="py-16 text-center">
      <div className="font-prose text-title text-ink">{title}</div>
      {children && (
        <p className="mx-auto mt-3 max-w-md text-ui text-ink-3">{children}</p>
      )}
      {action && <div className="mt-6 flex justify-center gap-2">{action}</div>}
    </div>
  )
}
