import {
  publicHomeSchema,
  publicBookSchema,
  publicChapterSchema,
  publicAuthorSchema,
  publicCatalogSchema,
  publicCategoriesSchema,
} from '@writer-agent/contracts'
import type { SiteData } from './context'
import { emptySite } from './context'
import { mapAuthor, mapBook } from './mapper'
export { publicPath } from './routes'
export async function loadSite(
  url: URL,
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<SiteData> {
  const data: SiteData = {
    ...emptySite,
    path: url.pathname,
    query: Object.fromEntries(
      [...url.searchParams].filter(([key]) =>
        ['q', 'category', 'status', 'sort', 'cursor', 'limit'].includes(key),
      ),
    ),
  }
  const get = async (path: string) => {
    const response = await fetcher(origin + path, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok)
      throw new Error(response.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE')
    return response.json() as Promise<unknown>
  }
  try {
    if (url.pathname === '/') {
      const home = publicHomeSchema.parse(await get('/v1/public/home'))
      data.books = home.items.map((b) =>
        mapBook(
          b,
          undefined,
          b.slug === home.featured?.slug
            ? (home.opening ?? undefined)
            : undefined,
        ),
      )
      data.total = home.total
      data.cats = home.categories
    } else if (url.pathname.startsWith('/discover')) {
      const [page, cats] = await Promise.all([
        get('/v1/public/books?' + url.searchParams),
        get('/v1/public/categories'),
      ])
      const catalog = publicCatalogSchema.parse(page)
      data.books = catalog.items.map((b) => mapBook(b))
      data.total = catalog.total
      data.nextCursor = catalog.nextCursor
      data.cats = publicCategoriesSchema.parse(cats).items
    } else if (url.pathname.startsWith('/books/')) {
      const parts = url.pathname.split('/')
      const [bookResult, chapterResult] = await Promise.all([
        get(`/v1/public/books/${parts[2]}`),
        parts[3] === 'chapters'
          ? get(`/v1/public/books/${parts[2]}/chapters/${parts[4]}`)
          : Promise.resolve(undefined),
      ])
      const book = publicBookSchema.parse(bookResult),
        chapter =
          chapterResult === undefined
            ? undefined
            : publicChapterSchema.parse(chapterResult)
      data.books = [mapBook(book, chapter)]
      data.total = 1
      if (parts[3] !== 'chapters') {
        const author = publicAuthorSchema.parse(
          await get(`/v1/public/authors/${book.authorSlug}`),
        )
        data.authors = [mapAuthor(author)]
      }
    } else if (url.pathname.startsWith('/authors/')) {
      const author = publicAuthorSchema.parse(
        await get(`/v1/public/authors/${url.pathname.split('/')[2]}`),
      )
      data.authors = [mapAuthor(author)]
      data.books = author.books.map((b) => mapBook(b))
      data.total = data.books.length
    }
    for (const b of data.books)
      if (!data.authors.some((a) => a.slug === b.authorSlug))
        data.authors.push({
          slug: b.authorSlug,
          name: b.penName,
          bio: '',
          demo: false,
        })
    return data
  } catch (error) {
    return {
      ...emptySite,
      path: url.pathname,
      query: data.query,
      status:
        error instanceof Error && error.message === 'NOT_FOUND' ? 404 : 503,
      error:
        error instanceof Error && error.message === 'NOT_FOUND'
          ? '作品不存在或已下架'
          : '作品服务暂时无法连接，请稍后重试。',
    }
  }
}
