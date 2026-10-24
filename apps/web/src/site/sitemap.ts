import { publicCatalogSchema } from '@writer-agent/contracts'

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  )
const ns = 'http://www.sitemaps.org/schemas/sitemap/0.9'
const header = '<?xml version="1.0" encoding="UTF-8"?>'
const bytes = (s: string) => new TextEncoder().encode(s).length
export const sitemapPath = (path: string) =>
  path === '/sitemap.xml' || /^\/sitemaps\/[1-9]\d{0,3}\.xml$/.test(path)
// Limits apply to uncompressed output. Smaller injected limits exercise splitting.
export async function sitemap(
  url: URL,
  apiOrigin: string,
  siteOrigin: string,
  fetcher: typeof fetch,
  limits = { urls: 50000, bytes: 50 * 1024 * 1024 },
) {
  const response = (body: string, status = 200) =>
    new Response(body, {
      status,
      headers: {
        'content-type':
          status === 200 ? 'application/xml; charset=utf-8' : 'text/plain',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    })
  try {
    const urls = new Map<string, string | undefined>(
      [
        '/',
        '/writers',
        '/about',
        '/policy/content',
        '/policy/privacy',
        '/contact',
      ].map((p) => [p, undefined]),
    )
    const books = new Set<string>()
    let cursor = 0,
      total: number | undefined
    const signal = AbortSignal.timeout(20000)
    for (let pageNo = 0; ; pageNo++) {
      if (pageNo >= 1000 || signal.aborted)
        throw Error('Catalog budget exceeded')
      const upstream = await fetcher(
        `${apiOrigin}/v1/public/books?limit=100&cursor=${cursor}`,
        { redirect: 'manual', signal, cache: 'no-store' },
      )
      if (!upstream.ok) throw Error('Catalog unavailable')
      const page = publicCatalogSchema.parse(await upstream.json())
      if (total !== undefined && page.total !== total)
        throw Error('Catalog changed during pagination')
      total = page.total
      if (page.items.length > 100) throw Error('Invalid page size')
      for (const b of page.items) {
        if (books.has(b.slug)) throw Error('Repeated catalog item')
        books.add(b.slug)
        urls.set(`/books/${b.slug}`, b.contentUpdatedAt ?? b.updatedAt)
        // No reliable author-profile modification time is exposed by this DTO.
        urls.set(`/authors/${b.authorSlug}`, undefined)
        for (const c of b.chapters) {
          const path = `/books/${b.slug}/chapters/${c.slug}`
          if (urls.has(path)) throw Error('Repeated chapter')
          urls.set(path, c.updatedAt)
        }
        if (urls.size > 500000) throw Error('Catalog URL budget exceeded')
      }
      if (page.nextCursor === null) {
        if (books.size !== total) throw Error('Incomplete catalog')
        break
      }
      if (!/^(0|[1-9]\d{0,8})$/.test(page.nextCursor))
        throw Error('Invalid cursor')
      const next = Number(page.nextCursor)
      if (!page.items.length || next !== cursor + page.items.length)
        throw Error('Non-progressing cursor')
      cursor = next
    }
    const start = `${header}<urlset xmlns="${ns}">`,
      end = '</urlset>'
    const chunks: string[] = []
    let entries: string[] = [],
      size = bytes(start + end)
    for (const [path, at] of [...urls].sort(([a], [b]) =>
      a.localeCompare(b, 'en'),
    )) {
      const entry = `<url><loc>${escape(new URL(path, siteOrigin).href)}</loc>${at ? `<lastmod>${escape(at)}</lastmod>` : ''}</url>`
      const length = bytes(entry)
      if (length + bytes(start + end) > limits.bytes)
        throw Error('Entry exceeds limit')
      if (
        entries.length &&
        (entries.length >= limits.urls || size + length > limits.bytes)
      ) {
        chunks.push(start + entries.join('') + end)
        entries = []
        size = bytes(start + end)
      }
      entries.push(entry)
      size += length
    }
    if (entries.length) chunks.push(start + entries.join('') + end)
    if (url.pathname !== '/sitemap.xml') {
      const index =
        Number(url.pathname.split('/').at(-1)!.replace('.xml', '')) - 1
      return chunks[index]
        ? response(chunks[index])
        : response('Not found', 404)
    }
    if (chunks.length === 1) return response(chunks[0])
    const index = `${header}<sitemapindex xmlns="${ns}">${chunks.map((_, i) => `<sitemap><loc>${escape(new URL(`/sitemaps/${i + 1}.xml`, siteOrigin).href)}</loc></sitemap>`).join('')}</sitemapindex>`
    if (bytes(index) > 50 * 1024 * 1024 || chunks.length > 50000)
      throw Error('Index exceeds limit')
    return response(index)
  } catch {
    // Never return an empty successful sitemap when the source is unavailable.
    return response('Sitemap unavailable', 503)
  }
}
