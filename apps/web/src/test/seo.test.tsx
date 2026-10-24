import { afterEach, expect, it, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { pageMeta, renderPublic } from '../site/server'
import { emptySite } from '../site/context'
import { sitemap } from '../site/sitemap'
import { handlePublicSite } from '../../worker/public'
import {
  emitGrowth,
  installGrowthSink,
  sourceBucket,
} from '../observability/growth'
import { useTitle } from '../site/store'
const origin = 'https://www.story2u.xyz'
const at = '2026-10-17T08:00:00Z'
const book = {
  slug: 'real-book',
  title: '公开作品',
  penName: '公开笔名',
  authorSlug: 'public-author',
  tagline: '作者批准的介绍',
  description: '正式简介',
  category: '科幻',
  serialStatus: 'ongoing',
  coverUrl: '',
  firstPublishedAt: at,
  updatedAt: at,
  chapterCount: 1,
  chapters: [
    {
      slug: 'chapter-one',
      title: '公开章节',
      volumeOrder: 1,
      chapterOrder: 1,
      publishedAt: at,
      updatedAt: '2026-10-18T08:00:00Z',
    },
  ],
}
const catalog =
  (items: unknown[], total = items.length, nextCursor: string | null = null) =>
  async () =>
    Response.json({ items, total, nextCursor })
const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html')
afterEach(() => {
  cleanup()
  installGrowthSink()
  document.getElementById('story2u-data')?.remove()
  vi.restoreAllMocks()
})
it('keeps home/author descriptions independent from featured book and truthful WebSite schema', () => {
  const home = doc(pageMeta(emptySite, origin))
  expect(JSON.parse(home.querySelector('script')!.textContent!)['@type']).toBe(
    'WebSite',
  )
  expect(
    home.querySelector('meta[name=description]')!.getAttribute('content'),
  ).toContain('原创小说')
  const author = doc(
    pageMeta(
      {
        ...emptySite,
        path: '/authors/public-author',
        authors: [
          {
            slug: 'public-author',
            name: '公开笔名',
            bio: '作者的真实介绍',
            demo: false,
          },
        ],
      },
      origin,
    ),
  )
  expect(
    author.querySelector('meta[name=description]')!.getAttribute('content'),
  ).toBe('作者的真实介绍')
  expect(author.querySelector('meta[name="twitter:title"]')).not.toBeNull()
})
it('renders exactly one canonical/title/description and configurable escaped verification', async () => {
  const response = await renderPublic(
    new URL('/writers', origin),
    'https://api.test',
    origin,
    '<html lang="zh-CN"><head><title>old</title><link rel="canonical" href="https://old.test"><meta name="description" content="old"></head><body><div id="root"></div></body></html>',
    catalog([]),
    {
      GOOGLE_SITE_VERIFICATION: 'fixture_ABC-1',
      BING_SITE_VERIFICATION: '<script>',
    },
  )
  const html = await response!.text(),
    d = doc(html)
  expect(d.querySelectorAll('link[rel=canonical]')).toHaveLength(1)
  expect(d.querySelectorAll('meta[name=description]')).toHaveLength(1)
  expect(d.querySelectorAll('title')).toHaveLength(1)
  expect(html).toContain('fixture_ABC-1')
  expect(d.querySelector('meta[name="msvalidate.01"]')).toBeNull()
  expect(d.querySelector('a[href="/studio"]')).not.toBeNull()
  expect(d.body.textContent).toContain('不是全书连续性审查')
  expect(d.body.textContent).not.toContain('替你记住整本书')
})
it('does not overwrite authoritative SSR metadata during hydration', () => {
  document.title = 'SSR chapter title'
  const data = document.createElement('script')
  data.id = 'story2u-data'
  document.body.appendChild(data)
  function Title() {
    useTitle('client fallback')
    return null
  }
  render(<Title />)
  expect(document.title).toBe('SSR chapter title')
})
it('splits count-limited sitemap, validates shards and uses actual chapter lastmod', async () => {
  const fetcher = catalog([book]),
    limits = { urls: 3, bytes: 10000 }
  const first = await sitemap(
    new URL('/sitemap.xml', origin),
    'https://api.test',
    origin,
    fetcher,
    limits,
  )
  const xml = await first.text()
  expect(xml).toContain('<sitemapindex')
  const links = [...doc(xml).querySelectorAll('loc')].map(
    (el) => el.textContent!,
  )
  let combined = ''
  for (const link of links) {
    const shard = await sitemap(
      new URL(link),
      'https://api.test',
      origin,
      fetcher,
      limits,
    )
    const body = await shard.text()
    combined += body
    expect(doc(body).querySelectorAll('url').length).toBeLessThanOrEqual(3)
  }
  expect(combined).toContain('2026-10-18T08:00:00Z')
  expect(combined).not.toContain('/studio')
  expect(
    (
      await sitemap(
        new URL('/sitemaps/999.xml', origin),
        'https://api.test',
        origin,
        fetcher,
        limits,
      )
    ).status,
  ).toBe(404)
  const byteLimited = await sitemap(
    new URL('/sitemap.xml', origin),
    'https://api.test',
    origin,
    fetcher,
    { urls: 50000, bytes: 400 },
  )
  expect(await byteLimited.text()).toContain('<sitemapindex')
})
it.each([
  '0',
  '-1',
  'NaN',
  'https://evil.test',
  '1&secret=x',
  '9999999999999999999999',
])(
  'rejects invalid/non-progressing cursor %s without repeated requests',
  async (cursor) => {
    const fetcher = vi.fn(catalog([book], 2, cursor))
    const result = await sitemap(
      new URL('/sitemap.xml', origin),
      'https://api.test',
      origin,
      fetcher,
    )
    expect(result.status).toBe(503)
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(2)
  },
)
it('fails closed for repeated books, incomplete or changing pagination; deduplicates authors', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ items: [book], total: 2, nextCursor: '1' }),
    )
    .mockResolvedValueOnce(
      Response.json({ items: [book], total: 2, nextCursor: null }),
    )
  expect(
    (
      await sitemap(
        new URL('/sitemap.xml', origin),
        'https://api.test',
        origin,
        fetcher,
      )
    ).status,
  ).toBe(503)
  expect(
    (
      await sitemap(
        new URL('/sitemap.xml', origin),
        'https://api.test',
        origin,
        catalog([], 1),
      )
    ).status,
  ).toBe(503)
  const second = { ...book, slug: 'second-book' }
  const ok = await sitemap(
    new URL('/sitemap.xml', origin),
    'https://api.test',
    origin,
    catalog([book, second]),
  )
  expect(
    (await ok.text()).match(
      /<loc>https:\/\/www.story2u.xyz\/authors\/public-author<\/loc>/g,
    ),
  ).toHaveLength(1)
})
it('canonicalizes index.html, serves favicon and rejects invalid shards', async () => {
  const env = {
    BETTER_AUTH_URL: origin,
    WRITER_AGENT_API_ORIGIN: 'https://api.test',
    ASSETS: { fetch: vi.fn() },
  }
  expect(
    (await handlePublicSite(new Request(origin + '/index.html'), env))?.status,
  ).toBe(308)
  expect(
    await handlePublicSite(new Request(origin + '/favicon.svg'), env),
  ).toBeNull()
  expect(
    (await handlePublicSite(new Request(origin + '/sitemaps/00.xml'), env))
      ?.status,
  ).toBe(404)
})
it('metrics default off, have only enum fields, fail harmlessly and never export referrer details', () => {
  const transport = vi.spyOn(globalThis, 'fetch')
  emitGrowth('chapter_saved')
  expect(transport).not.toHaveBeenCalled()
  const sink = vi.fn()
  installGrowthSink(sink)
  emitGrowth(
    'book_view',
    sourceBucket('https://www.google.com/search?q=PRIVATE'),
  )
  expect(sink).toHaveBeenCalledWith({ event: 'book_view', source: 'google' })
  expect(sourceBucket('https://chatgpt.com/?private=1')).toBe('ai_referrer')
  expect(sourceBucket('https://google.com.evil.test')).toBe('direct_or_unknown')
  installGrowthSink(() => {
    throw Error('offline')
  })
  expect(() => emitGrowth('chapter_saved')).not.toThrow()
})

it('handles a real catalog exceeding the standard 50,000 URL limit without truncation', async () => {
  const books = Array.from({ length: 500 }, (_, n) => ({
    ...book, slug: `book-${n}`, chapterCount: 100,
    chapters: Array.from({ length: 100 }, (_, i) => ({ ...book.chapters[0], slug: `chapter-${i}`, chapterOrder: i })),
  }))
  const fetcher: typeof fetch = async input => {
    const cursor = Number(new URL(String(input)).searchParams.get('cursor'))
    return Response.json({ items: books.slice(cursor, cursor + 100), total: 500, nextCursor: cursor + 100 < 500 ? String(cursor + 100) : null })
  }
  const index = await sitemap(new URL('/sitemap.xml', origin), 'https://api.test', origin, fetcher)
  expect(await index.text()).toContain('<sitemapindex')
  let count = 0
  for (const shard of [1, 2]) {
    const response = await sitemap(new URL(`/sitemaps/${shard}.xml`, origin), 'https://api.test', origin, fetcher)
    const xml = await response.text(), entries = xml.match(/<url>/g)!.length
    expect(entries).toBeLessThanOrEqual(50000)
    expect(new TextEncoder().encode(xml).byteLength).toBeLessThanOrEqual(50 * 1024 * 1024)
    count += entries
  }
  expect(count).toBe(50507)
}, 20000)

it('allows crawlers to observe discover noindex rather than blocking its retrieval', async () => {
  const response = await renderPublic(new URL('/robots.txt', origin), 'https://api.test', origin, '', catalog([]))
  const robots = await response!.text()
  expect(robots).not.toContain('Disallow: /discover')
  expect(robots).toContain('Disallow: /v1/')
})
