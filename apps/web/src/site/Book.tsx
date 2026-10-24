import { useState } from 'react'
import { Btn } from '../components/vnext/ui'
import { allChapters, latest, when } from './data'
import {
  A,
  BookCard,
  Container,
  Cover,
  DemoMark,
  EmptyState,
  Footer,
  Header,
  Meta,
  useCatalog,
} from './kit'
import { progress, useTitle } from './store'

export function BookDetail({ slug }: { slug: string }) {
  const { books, authors } = useCatalog()
  const prog = progress.use()
  const book = books.find((b) => b.slug === slug)
  const [desc, setDesc] = useState(false)
  useTitle(book ? `${book.title} · story2u` : '作品不存在 · story2u')
  if (!book)
    return (
      <>
        <Header />
        <Container>
          <EmptyState
            title="这部作品不存在或已下架"
            action={
              <A to="/discover" variant="outline" className="">
                发现其他作品
              </A>
            }
          >
            作者可能已撤回公开，或链接有误。
          </EmptyState>
        </Container>
        <Footer />
      </>
    )
  const author = authors.find((a) => a.slug === book.authorSlug)
  const chapters = allChapters(book)
  const candidate = prog[book.slug]
  const p = chapters.some((c) => c.slug === candidate?.chapter)
    ? candidate
    : undefined
  return (
    <>
      <Header />
      <main>
        <Container className="grid gap-10 pt-8 md:grid-cols-[16rem_1fr] md:gap-16 md:pt-16 lg:grid-cols-[20rem_1fr]">
          <div className="mx-auto w-40 sm:w-52 md:w-full">
            <Cover book={book} size="lg" className="md:max-w-none" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <DemoMark book={book} />
            </div>
            <h1 className="mt-2 font-prose text-display font-medium text-ink">
              {book.title}
            </h1>
            <div className="mt-3">
              <Meta book={book} author={author} />
            </div>
            <p className="mt-6 font-prose text-ui-lg text-ink">{book.hook}</p>
            <p
              className={`mt-4 max-w-2xl text-ui text-ink-2 ${desc ? '' : 'line-clamp-4'}`}
            >
              {book.synopsis}
            </p>
            {book.synopsis.length > 120 && (
              <Btn
                variant="link"
                className="mt-1 text-ui-sm"
                onClick={() => setDesc(!desc)}
              >
                {desc ? '收起' : '展开简介'}
              </Btn>
            )}
            <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-ui-sm">
              <div>
                <dt className="inline text-ink-3">已公开 </dt>
                <dd className="inline text-ink">{chapters.length} 章</dd>
              </div>
              <div>
                <dt className="inline text-ink-3">最近更新 </dt>
                <dd className="inline text-ink">
                  {when(book.updatedAt)} · 第 {latest(book).no} 章
                </dd>
              </div>
            </dl>
            <div className="mt-8 flex flex-wrap gap-2">
              {p ? (
                <>
                  <A
                    to={`/books/${book.slug}/chapters/${p.chapter}`}
                    variant="primary"
                    className="h-10 px-5"
                  >
                    继续阅读 · 第{' '}
                    {chapters.find((c) => c.slug === p.chapter)?.no ?? 1} 章
                  </A>
                  <A
                    to={`/books/${book.slug}/chapters/${chapters[0].slug}`}
                    variant="outline"
                    className="h-10 px-5"
                  >
                    从头开始
                  </A>
                </>
              ) : (
                <A
                  to={`/books/${book.slug}/chapters/${chapters[0].slug}`}
                  variant="primary"
                  className="h-10 px-5"
                >
                  开始阅读
                </A>
              )}
              <Btn
                variant="quiet"
                className="h-10"
                onClick={() =>
                  document
                    .getElementById('toc')
                    ?.scrollIntoView({ behavior: 'smooth' })
                }
              >
                目录
              </Btn>
            </div>
          </div>
        </Container>

        <Container className="mt-20">
          <section
            id="toc"
            aria-label="目录"
            className="mx-auto max-w-3xl scroll-mt-20"
          >
            <div className="flex items-baseline gap-3">
              <h2 className="font-prose text-title font-medium text-ink">
                目录
              </h2>
              <span className="text-ui-sm text-ink-3">
                共 {chapters.length} 章 · {book.status}
              </span>
            </div>
            {book.volumes.map((v, index) => (
              <div key={index} className="mt-8">
                {v.title && (
                  <h3 className="text-ui-sm font-medium text-ink-3">
                    {v.title}
                  </h3>
                )}
                <ol className="mt-2 grid sm:grid-cols-2 sm:gap-x-10">
                  {v.chapters.map((c) => (
                    <li key={c.no}>
                      <A
                        to={`/books/${book.slug}/chapters/${c.slug}`}
                        className="flex items-baseline gap-3 border-b border-line-soft py-3 hover:text-accent"
                      >
                        <span className="w-8 shrink-0 text-ui-sm tabular-nums text-ink-3">
                          {c.no}
                        </span>
                        <span
                          className={`min-w-0 flex-1 truncate font-prose text-ui-lg ${p?.chapter === c.slug ? 'text-accent' : 'text-ink'}`}
                        >
                          {c.title}
                        </span>
                        {p?.chapter === c.slug && (
                          <span className="text-micro text-accent">
                            读到这里
                          </span>
                        )}
                        {c === latest(book) && book.status === '连载中' && (
                          <span className="text-micro text-ok">最新</span>
                        )}
                      </A>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            {book.status === '连载中' && (
              <p className="mt-8 text-ui-sm text-ink-3">
                连载中 · 新章节由作者发布后出现在这里。
              </p>
            )}
          </section>
        </Container>

        {author && (
          <Container className="mt-20">
            <div className="mx-auto max-w-3xl border-t border-line-soft pt-10">
              <div className="text-ui-sm text-ink-3">作者</div>
              <A
                to={`/authors/${author.slug}`}
                className="mt-1 inline-block font-prose text-title text-ink hover:underline hover:underline-offset-4"
              >
                {author.name}
              </A>
              <p className="mt-2 text-ui text-ink-2">{author.bio}</p>
            </div>
          </Container>
        )}
      </main>
      <Footer />
    </>
  )
}

export function AuthorPage({ slug }: { slug: string }) {
  const { books, authors } = useCatalog()
  const a = authors.find((x) => x.slug === slug)
  useTitle(a ? `${a.name} · story2u` : '作者 · story2u')
  const works = books.filter((b) => b.authorSlug === slug)
  return (
    <>
      <Header />
      <main>
        <Container className="pt-12 md:pt-20">
          {!a ? (
            <EmptyState title="作者不存在" />
          ) : (
            <>
              <div className="text-ui-sm text-ink-3">
                作者{a.demo && ' · 演示'}
              </div>
              <h1 className="mt-2 font-prose text-display font-medium text-ink">
                {a.name}
              </h1>
              <p className="mt-4 max-w-xl font-prose text-ui-lg text-ink-2">
                {a.bio || '这位作者还没有填写介绍。'}
              </p>
              <h2 className="mt-16 mb-6 text-ui-sm font-medium text-ink-3">
                已发布作品 · {works.length}
              </h2>
              {works.length ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-12 sm:grid-cols-4 lg:grid-cols-6">
                  {works.map((b) => (
                    <BookCard key={b.slug} book={b} author={a} />
                  ))}
                </div>
              ) : (
                <p className="text-ui text-ink-3">暂无公开作品。</p>
              )}
            </>
          )}
        </Container>
      </main>
      <Footer />
    </>
  )
}

export const staticPages: Record<string, [string, string[]]> = {
  writers: [
    '给写作的人',
    [
      'Writer Agent 是面向小说作者的写作工作台：编辑 Markdown 章节、自动保存修订、记录笔记，再由作者选择公开的章节。story2u 为已发布作品提供独立的阅读页面。',
      '你先写作并保存，再预览固定修订版本，确认后发布。继续修改草稿不会自动更新公开版本，撤回公开也不会删除私人草稿。',
      '人物与时间线审查需要你先预览并确认发送范围。模型提出候选问题，服务端核验引文是否来自允许的来源；引文存在不代表推断成立。审查不会自动改写正文或正式设定。',
      '当前审查最多使用四个历史章节与四份已确认知识，不是全书连续性审查；真实模型质量仍需独立验证。世界观、人物关系和伏笔的完整知识管理仍在建设中，演示界面不代表已可用的生产能力。',
      '你可以新建和切换作品，管理卷与章节，归档后恢复章节。Google 登录目前仅限受邀作者，不提供开放注册。',
      '作品版权归作者所有。只有你选择并确认的发布快照进入公开阅读；私人笔记和审查记录不会随之公开。你确认审查时，选定的写作上下文才会发送给配置的模型服务。',
    ],
  ],
  about: [
    '关于 story2u',
    [
      'story2u 是一个原创小说阅读平台，也是作者发布作品的地方。',
      '每一部公开作品都由作者主动选择并确认发布。',
    ],
  ],
  'policy/content': [
    '版权与内容政策',
    [
      '作品版权归作者所有。作者发布即表示确认对所发布内容拥有权利。',
      '正式条款正在完善；发布前请确认对正文拥有完整权利。',
    ],
  ],
  'policy/privacy': [
    '隐私政策',
    [
      '阅读进度在 MVP 中仅保存在你的浏览器中。',
      'Google 登录使用必要的会话 Cookie，访问仅限受邀作者。API 密钥和后端身份凭证保留在服务端。作者主动确认审查后，选定上下文会发送给配置的模型服务。',
      '本版本未默认启用第三方访问统计。公开阅读与私人创作数据分开处理；后续启用统计前将说明数据范围并更新此说明。',
    ],
  ],
  contact: ['联系我们', ['请通过作品作者的公开资料取得联系。']],
}
export function StaticPage({ id }: { id: string }) {
  const [t, ps] = staticPages[id] ?? ['页面不存在', ['请检查链接。']]
  useTitle(`${t} · story2u`)
  return (
    <>
      <Header />
      <main>
        <Container className="pt-16">
          <div className="max-w-read">
            <h1 className="font-prose text-display font-medium text-ink">
              {t}
            </h1>
            <div className="mt-8 space-y-4 font-prose text-ui-lg text-ink-2">
              {ps.map((p, i) =>
                id === 'writers' ? (
                  <section key={i}>
                    <h2 className="mb-2 text-ui-lg font-medium text-ink">
                      {
                        [
                          'Writer Agent 是什么',
                          '从写作到公开阅读',
                          '人物与时间线审查',
                          '能力范围与限制',
                          '作品管理与访问',
                          '作者决定与数据归属',
                        ][i]
                      }
                    </h2>
                    <p>{p}</p>
                  </section>
                ) : (
                  <p key={i}>{p}</p>
                ),
              )}
            </div>
            {id === 'writers' && (
              <A to="/studio" variant="primary" className="mt-10">
                进入 Writer Studio
              </A>
            )}
          </div>
        </Container>
      </main>
      <Footer />
    </>
  )
}
