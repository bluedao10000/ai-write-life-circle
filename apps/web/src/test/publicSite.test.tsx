import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { PublicBook } from '@writer-agent/contracts'
import { renderPublic } from '../site/server'
import { PublicSite } from '../site/Root'
import { emptySite } from '../site/context'
import { mapBook } from '../site/mapper'
import { handlePublicSite } from '../../worker/public'
import { publicationRoute } from '../../worker/publication-route'
import { Markdown } from '../site/Markdown'

const at = '2026-10-17T08:00:00Z'
const book = (n = 1): PublicBook => ({
  slug: `story-${n}`,
  title: `故事 ${n}`,
  penName: '公开笔名',
  authorSlug: 'author-public',
  tagline: '真实的公开简介',
  description: '已发布作品的说明',
  category: n % 2 ? '科幻' : '悬疑',
  categories: n % 2 ? ['科幻', '奇幻'] : ['悬疑'],
  serialStatus: 'ongoing',
  coverUrl: '',
  firstPublishedAt: at,
  updatedAt: at,
  chapterCount: 2,
  chapters: [
    {
      slug: 'chapter-one',
      title: '第一章',
      volumeOrder: 1,
      chapterOrder: 10,
      publishedAt: at,
      updatedAt: at,
    },
    {
      slug: 'chapter-two',
      title: '第二卷开篇',
      volumeOrder: 2,
      chapterOrder: 1,
      publishedAt: at,
      updatedAt: at,
    },
  ],
})
const template =
  '<html><head><title>Studio</title></head><body><div id="root"></div></body></html>'
const origin = 'https://www.story2u.xyz'
afterEach(() => vi.unstubAllGlobals())
describe('public rendering and privacy boundary', () => {
  it('renders all catalog scales without inventing books or metrics', () => {
    for (const count of [0, 1, 4, 5, 30, 301]) {
      const books = Array.from({ length: Math.min(count, 30) }, (_, i) =>
        mapBook(book(i + 1)),
      )
      const html = renderToString(
        <PublicSite
          data={{
            ...emptySite,
            total: count,
            books,
            cats: ['科幻', '悬疑', '奇幻'],
            authors: [
              {
                slug: 'author-public',
                name: '公开笔名',
                bio: '介绍',
                demo: false,
              },
            ],
          }}
        />,
      )
      expect(html.includes('第一部故事')).toBe(count === 0)
      expect(html.includes('最近更新</h2>')).toBe(count >= 5)
      expect(html.includes('浏览全部 301 部')).toBe(count === 301)
      for (const fake of [
        'aggregateRating',
        '排行榜',
        '评分',
        '演示作品',
        '雾港来信',
      ])
        expect(html).not.toContain(fake)
      expect(html).not.toContain('href="#')
    }
  })
  it('server-renders real chapter text and safe metadata/hydration without JavaScript', async () => {
    const b = book()
    b.title = '</script><script>alert(1)</script>'
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/chapters/chapter-one'))
        return Response.json({
          ...b.chapters[0],
          bookSlug: b.slug,
          markdown:
            '公开正文。\n\n<script>doNotRun()</script>\n\n**粗体**与私密草稿无关。',
          previous: null,
          next: 'chapter-two',
        })
      return Response.json(b)
    })
    const response = await renderPublic(
      new URL('/books/story-1/chapters/chapter-one', origin),
      'https://api.example.test',
      origin,
      template,
      fetcher,
    )
    expect(response?.status).toBe(200)
    const html = await response!.text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.body.textContent).toContain('公开正文。')
    expect(doc.querySelector('strong')?.textContent).toBe('粗体')
    expect(doc.querySelector('link[rel=canonical]')?.getAttribute('href')).toBe(
      origin + '/books/story-1/chapters/chapter-one',
    )
    expect(
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    ).toContain('/og/books/story-1.svg')
    expect(
      doc.querySelector('script[type="application/ld+json"]')?.textContent,
    ).toContain('datePublished')
    expect(
      doc.querySelectorAll(
        'script:not([type="application/json"]):not([type="application/ld+json"])',
      ),
    ).toHaveLength(0)
    for (const field of [
      'ownerUserId',
      'sourceRevisionId',
      'sourceContentHash',
      'createdBy',
      'auditReference',
    ])
      expect(html).not.toContain(field)
    expect(response?.headers.get('cache-control')).toBe('no-store')
  })
  it('does not hydrate unrecognized request query fields and gives search noindex', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      Response.json(
        String(input).includes('/categories')
          ? { items: [] }
          : { items: [], total: 0, nextCursor: null },
      ),
    )
    const response = await renderPublic(
      new URL('/discover?q=missing&access_token=SHOULD_NOT_HYDRATE', origin),
      'https://api.example.test',
      origin,
      template,
      fetcher,
    )
    const html = await response!.text()
    expect(html).toContain('noindex')
    expect(html).not.toContain('SHOULD_NOT_HYDRATE')
  })
  it('only emits current public URLs in sitemap and stops when content is withdrawn', async () => {
    let listed = true
    const fetcher = vi.fn(async () =>
      Response.json({
        items: listed ? [book()] : [],
        total: listed ? 1 : 0,
        nextCursor: null,
      }),
    )
    const first = await renderPublic(
      new URL('/sitemap.xml', origin),
      'https://api.example.test',
      origin,
      template,
      fetcher,
    )
    const xml = await first!.text()
    expect(xml).toContain('/chapters/chapter-two')
    expect(xml).not.toContain('/studio')
    expect(xml).not.toContain('revision')
    listed = false
    const second = await renderPublic(
      new URL('/sitemap.xml', origin),
      'https://api.example.test',
      origin,
      template,
      fetcher,
    )
    expect(await second!.text()).not.toContain('story-1')
  })
  it('does not render private Studio or API routes and keeps failure output generic', async () => {
    const unused = vi.fn()
    expect(
      await renderPublic(
        new URL('/studio/publish', origin),
        'https://api.example.test',
        origin,
        template,
        unused,
      ),
    ).toBeNull()
    expect(unused).not.toHaveBeenCalled()
    const response = await renderPublic(
      new URL('/books/missing', origin),
      'https://api.example.test',
      origin,
      template,
      async () => new Response('PRIVATE_REVISION', { status: 404 }),
    )
    expect(response?.status).toBe(404)
    expect(await response!.text()).not.toContain('PRIVATE_REVISION')
  })
  it('strips raw HTML and dangerous Markdown URL schemes', () => {
    const html = renderToString(
      <Markdown
        markdown={
          '# 书内标题\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n![跟踪](http://bad.test/pixel)'
        }
      />,
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('http://bad.test')
    expect(html).not.toContain('<h1>')
  })
})
describe('public Worker composition', () => {
  const env = {
    BETTER_AUTH_URL: origin,
    WRITER_AGENT_API_ORIGIN: 'https://api.example.test',
    WRITER_AGENT_API_TOKEN: 'DO_NOT_FORWARD',
    ASSETS: { fetch: vi.fn(async () => new Response(template)) },
  }
  it('delegates private routes even without public configuration and rejects malformed public URLs', async () => {
    expect(
      await handlePublicSite(new Request(origin + '/api/session'), {
        ...env,
        BETTER_AUTH_URL: '',
      }),
    ).toBeNull()
    expect(
      (
        await handlePublicSite(
          new Request(origin + '/books/story-1/chapters/CH-002'),
          env,
        )
      )?.status,
    ).toBe(404)
    expect(
      (await handlePublicSite(new Request(origin + '/v1/public/unknown'), env))
        ?.status,
    ).toBe(404)
    for (const path of [
      '/missing',
      '/missing.js',
      '/studio/missing',
      '/policy/missing',
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await handlePublicSite(
          new Request(origin + path, { method }),
          env,
        )
        expect(response?.status).toBe(404)
        expect(response?.headers.get('x-robots-tag')).toBe('noindex')
        if (method === 'HEAD') expect(await response!.text()).toBe('')
      }
    }
    expect(
      await handlePublicSite(new Request(origin + '/assets/app.js'), env),
    ).toBeNull()
  })
  it('forwards no cookie, browser credential, actor header, or backend bearer on public reads', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        expect(headers.get('authorization')).toBeNull()
        expect(headers.get('cookie')).toBeNull()
        expect(headers.get('x-actor-id')).toBeNull()
        return Response.json({
          items: [],
          total: 0,
          featured: null,
          opening: null,
          categories: [],
        })
      },
    )
    vi.stubGlobal('fetch', fetcher)
    const response = await handlePublicSite(
      new Request(origin + '/v1/public/home', {
        headers: {
          cookie: 'private-session',
          authorization: 'Bearer browser-secret',
          'x-actor-id': 'attacker',
        },
      }),
      env,
    )
    expect(response?.status).toBe(200)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('refuses contaminated public DTOs rather than leaking an upstream private field', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        items: [],
        total: 0,
        featured: null,
        opening: null,
        categories: [],
        ownerUserId: 'PRIVATE_OWNER',
      }),
    )
    const response = await handlePublicSite(
      new Request(origin + '/v1/public/home'),
      env,
    )
    expect(response?.status).toBe(503)
    expect(await response!.text()).not.toContain('PRIVATE_OWNER')
  })
  it('delegates private operations to the existing auth system without authenticating them', async () => {
    expect(
      await handlePublicSite(new Request(origin + '/studio/publish'), env),
    ).toBeNull()
    expect(
      publicationRoute(
        '/v1/studio/books/local/publication/versions',
        'POST',
        'local',
      ),
    ).toBe(true)
    expect(
      publicationRoute(
        '/v1/studio/books/other/publication/versions',
        'POST',
        'local',
      ),
    ).toBe(false)
    expect(
      publicationRoute(
        '/v1/studio/books/local/publication/%2e%2e',
        'POST',
        'local',
      ),
    ).toBe(false)
    expect(
      publicationRoute(
        '/v1/studio/books/local/publication/versions',
        'DELETE',
        'local',
      ),
    ).toBe(false)
  })
})

describe('published volume names', () => {
  it('renders confirmed volume titles and leaves explicitly ungrouped chapters unnumbered', () => {
    const dto = book()
    dto.chapters[0].volumeTitle = ''
    dto.chapters[1].volumeTitle = '第一卷 · 江宁往事'
    const mapped = mapBook(dto)
    expect(mapped.volumes.map((v) => v.title)).toEqual([
      '',
      '第一卷 · 江宁往事',
    ])
    const html = renderToString(
      <PublicSite
        data={{ ...emptySite, path: '/books/story-1', books: [mapped] }}
      />,
    )
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(
      [...doc.querySelectorAll('#toc h3')].map((el) => el.textContent),
    ).toEqual(['第一卷 · 江宁往事'])
    expect(html).not.toContain('第 1 卷')
    const chapter = {
      ...dto.chapters[0],
      bookSlug: dto.slug,
      markdown: '合成公开正文。',
      previous: null,
      next: dto.chapters[1].slug,
    }
    const reader = renderToString(
      <PublicSite
        data={{
          ...emptySite,
          path: '/books/story-1/chapters/chapter-one',
          books: [mapBook(dto, chapter)],
        }}
      />,
    )
    const readerDoc = new DOMParser().parseFromString(reader, 'text/html')
    expect(
      readerDoc.querySelector('article header div')?.textContent?.trim(),
    ).toBe('第 1 章')
  })
  it('keeps identically named volumes separate by their snapshot order and supports old DTOs', () => {
    const dto = book()
    dto.chapters.forEach((c) => {
      c.volumeTitle = '同名卷'
    })
    expect(mapBook(dto).volumes).toHaveLength(2)
    dto.chapters.forEach((c) => {
      delete c.volumeTitle
    })
    expect(mapBook(dto).volumes.map((v) => v.title)).toEqual([
      '第 1 卷',
      '第 2 卷',
    ])
  })
})
