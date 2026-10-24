import { Btn } from '../components/vnext/ui'
import { allChapters, latest, type PublicAuthor, type PublicBook } from './data'
import {
  A,
  BookCard,
  Container,
  Cover,
  DemoMark,
  Footer,
  Header,
  Meta,
  SectionHead,
  useCatalog,
} from './kit'
import { go, progress, useTitle } from './store'

export default function Home() {
  const { books, authors, cats, byUpdate, mine } = useCatalog()
  const { total } = useCatalog()
  const scale = total > 30 ? 'D' : 'B'
  const prog = progress.use()
  useTitle('story2u · 原创小说')
  const au = (b: PublicBook) => authors.find((a) => a.slug === b.authorSlug)
  const featured = mine ?? books[0]
  const reading = Object.entries(prog)
    .sort((a, b) => b[1].at - a[1].at)
    .map(([slug, p]) => ({ b: books.find((x) => x.slug === slug), p }))
    .filter((x) => x.b && allChapters(x.b).some((c) => c.slug === x.p.chapter))
    .slice(0, 3)
  const few = books.length > 0 && books.length <= 4
  const richCats = cats
    .map((c) => ({
      c,
      n: books.filter((b) => b.categories.includes(c)).length,
    }))
    .filter((x) => x.n >= 2)

  return (
    <>
      <Header />
      <main>
        {books.length === 0 ? (
          <Empty />
        ) : (
          <Hero
            book={featured}
            author={au(featured)}
            progress={
              allChapters(featured).some(
                (c) => c.slug === prog[featured.slug]?.chapter,
              )
                ? prog[featured.slug]?.chapter
                : undefined
            }
          />
        )}

        {reading.length > 0 && (
          <Container className="mt-24">
            <SectionHead
              title="继续阅读"
              sub="阅读进度仅保存在这台设备的浏览器中。"
            />
            <div className="grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
              {reading.map(({ b, p }) => (
                <A
                  key={b!.slug}
                  to={`/books/${b!.slug}/chapters/${p.chapter}`}
                  className="group flex items-center gap-4 py-2"
                >
                  <Cover book={b!} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-prose text-ui-lg text-ink group-hover:underline group-hover:underline-offset-4">
                      {b!.title}
                    </div>
                    <div className="text-ui-sm text-ink-3">
                      读到 第{' '}
                      {allChapters(b!).find((c) => c.slug === p.chapter)?.no ??
                        1}{' '}
                      章 · 共 {allChapters(b!).length} 章
                    </div>
                    <div className="mt-2 h-0.5 rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-ink-2"
                        style={{
                          width: `${Math.max(4, (((allChapters(b!).find((c) => c.slug === p.chapter)?.no ?? 1) - 1 + p.ratio) / allChapters(b!).length) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                </A>
              ))}
            </div>
          </Container>
        )}

        {few && books.length > 1 && (
          <Container className="mt-28">
            <SectionHead
              title={
                books.length === 2
                  ? '另一部作品'
                  : `另外 ${books.length - 1} 部作品`
              }
            />
            <div className="grid gap-16 lg:grid-cols-2">
              {books
                .filter((b) => b !== featured)
                .map((b) => (
                  <article
                    key={b.slug}
                    className="grid grid-cols-[7rem_1fr] gap-6 sm:grid-cols-[9rem_1fr]"
                  >
                    <A to={`/books/${b.slug}`}>
                      <Cover book={b} />
                    </A>
                    <div className="min-w-0">
                      <A
                        to={`/books/${b.slug}`}
                        className="font-prose text-title font-medium text-ink hover:underline hover:underline-offset-4"
                      >
                        {b.title}
                      </A>
                      <div className="mt-1">
                        <Meta book={b} author={au(b)} />
                      </div>
                      <p className="mt-3 font-prose text-ui-lg text-ink-2">
                        {b.hook}
                      </p>
                      <div className="mt-3 flex items-center gap-3 text-ui-sm text-ink-3">
                        <span>更新至 第 {latest(b).no} 章</span>
                        <DemoMark book={b} />
                      </div>
                      <Btn
                        variant="link"
                        className="mt-4"
                        onClick={() =>
                          go(
                            `/books/${b.slug}/chapters/${allChapters(b)[0].slug}`,
                          )
                        }
                      >
                        从第一章读起 →
                      </Btn>
                    </div>
                  </article>
                ))}
            </div>
          </Container>
        )}

        {!few && books.length > 0 && (
          <>
            <Container className="mt-28 grid gap-16 lg:grid-cols-[1fr_20rem]">
              <section>
                <SectionHead
                  title="最近更新"
                  more={{ label: '全部更新', to: '/discover/recent' }}
                />
                <div className="grid gap-x-10 md:grid-cols-2">
                  {byUpdate.slice(0, 8).map((b) => (
                    <BookCard
                      key={b.slug}
                      book={b}
                      author={au(b)}
                      variant="compact"
                    />
                  ))}
                </div>
              </section>
              {richCats.length >= 3 && (
                <section>
                  <SectionHead title="探索不同世界" />
                  <ul className="space-y-1">
                    {richCats.map(({ c, n }) => (
                      <li key={c}>
                        <A
                          to={`/discover?category=${encodeURIComponent(c)}`}
                          className="flex items-baseline justify-between border-b border-line-soft py-3 font-prose text-ui-lg text-ink hover:text-accent"
                        >
                          <span>{c}</span>
                          <span className="font-ui text-ui-sm text-ink-3">
                            {n} 部
                          </span>
                        </A>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-micro text-ink-3">
                    分类来自作者为作品填写的题材。
                  </p>
                </section>
              )}
            </Container>
            <Container className="mt-28">
              <SectionHead
                title="精选作品"
                sub="从已公开的作品中，遇见一个新的故事。"
                more={
                  scale === 'D'
                    ? { label: `浏览全部 ${total} 部`, to: '/discover' }
                    : undefined
                }
              />
              <div className="grid grid-cols-2 gap-x-6 gap-y-12 sm:grid-cols-3 lg:grid-cols-6">
                {books.slice(0, 6).map((b) => (
                  <BookCard key={b.slug} book={b} author={au(b)} />
                ))}
              </div>
            </Container>
          </>
        )}

        <Creators empty={books.length === 0} />
      </main>
      <Footer />
    </>
  )
}

function Hero({
  book,
  author,
  progress: p,
}: {
  book: PublicBook
  author?: PublicAuthor
  progress?: string
}) {
  const first = allChapters(book)[0]
  const opening = (first.paras ?? []).slice(0, 2)
  return (
    <section aria-label="精选作品">
      <Container className="grid items-center gap-12 pt-10 pb-6 md:grid-cols-[1fr_auto] md:gap-16 md:pt-20 lg:gap-24">
        <div className="order-2 md:order-1">
          <div className="flex items-center gap-3 text-ui-sm text-ink-3">
            <span>故事精选</span>
            <DemoMark book={book} />
          </div>
          <h1 className="mt-4 font-prose text-display font-medium text-ink sm:text-hero">
            {book.title}
          </h1>
          <p className="mt-5 max-w-xl font-prose text-read text-ink-2 sm:text-ui-lg">
            {book.hook}
          </p>
          <div className="mt-5">
            <Meta book={book} author={author} />
          </div>
          <div className="mt-1 text-ui-sm text-ink-3">
            已公开 {allChapters(book).length} 章 · 更新至「{latest(book).title}
            」
          </div>
          <div className="mt-8 flex flex-wrap gap-2">
            <A
              to={`/books/${book.slug}/chapters/${p ?? first.slug}`}
              variant="primary"
              className="h-10 px-5"
            >
              {p
                ? `继续阅读 · 第 ${allChapters(book).find((c) => c.slug === p)?.no ?? 1} 章`
                : '开始阅读'}
            </A>
            <A
              to={`/books/${book.slug}`}
              variant="outline"
              className="h-10 px-5"
            >
              查看详情
            </A>
          </div>
        </div>
        <A
          to={`/books/${book.slug}`}
          className="order-1 mx-auto w-44 sm:w-56 md:order-2 md:w-72 lg:w-80"
          label={`《${book.title}》详情`}
        >
          <Cover book={book} size="xl" />
        </A>
      </Container>
      {opening.length > 0 && (
        <Container className="mt-16 md:mt-24">
          <div className="mx-auto max-w-read">
            <div className="text-ui-sm text-ink-3">
              开篇 · 第 {first.no} 章 {first.title}
            </div>
            <div className="reader-text mt-4 font-prose text-read text-ink sm:text-ui-lg">
              {opening.map((t, i) => (
                <p key={i}>{t}</p>
              ))}
            </div>
            <A
              to={`/books/${book.slug}/chapters/${first.slug}`}
              className="mt-2 inline-block text-ui text-ink-2 hover:text-ink"
            >
              继续读下去 →
            </A>
          </div>
        </Container>
      )}
    </section>
  )
}

function Empty() {
  return (
    <Container className="pt-20 pb-10 md:pt-32">
      <div className="max-w-3xl">
        <div className="text-ui-sm text-ink-3">story2u · 原创小说</div>
        <h1 className="mt-4 font-prose text-display font-medium text-ink sm:text-hero">
          第一部故事，
          <br />
          正在被写下。
        </h1>
        <p className="mt-6 max-w-xl font-prose text-ui-lg text-ink-2">
          story2u
          是一个原创小说阅读平台。这里的每一部作品都由作者自己写成，也由作者自己决定何时与读者见面。
        </p>
        <p className="mt-4 text-ui text-ink-3">
          目前还没有公开发布的作品。作品发布后，会第一时间出现在这里。
        </p>
        <div className="mt-10 flex flex-wrap gap-2">
          <A to="/studio" variant="primary" className="h-10 px-5">
            成为第一位作者
          </A>
          <A to="/writers" variant="outline" className="h-10 px-5">
            了解 Writer Studio
          </A>
        </div>
      </div>
    </Container>
  )
}

function Creators({ empty }: { empty: boolean }) {
  if (empty) return null
  return (
    <section aria-label="创作者" className="mt-36 bg-paper py-20">
      <Container className="grid gap-12 md:grid-cols-2 md:items-end">
        <div>
          <div className="text-ui-sm text-ink-3">给写作的人</div>
          <h2 className="mt-3 font-prose text-title font-medium text-ink sm:text-display">
            专注于创造你的故事，
            <br />
            其余交给更安静的工具。
          </h2>
          <div className="mt-8 flex flex-wrap gap-2">
            <A to="/studio" variant="primary" className="">
              开始创作
            </A>
            <A to="/writers" variant="quiet" className="">
              了解 Writer Studio
            </A>
          </div>
        </div>
        <ul className="space-y-5 font-prose text-ui-lg text-ink-2">
          <li>
            <span className="text-ink">每一个字都是你写的。</span>
            工具不会替你续写，也不会改动你的正文。
          </li>
          <li>
            <span className="text-ink">它替你记住整本书。</span>
            人物、设定、伏笔，和十章之前写下的那句话。
          </li>
          <li>
            <span className="text-ink">发布什么、何时发布，只由你决定。</span>
            草稿和笔记永远不会被公开。
          </li>
        </ul>
      </Container>
    </section>
  )
}
