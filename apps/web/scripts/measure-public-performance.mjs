// Reproducible lab only: built Worker SSR, public synthetic DTOs, no private API.
import { createServer } from 'node:http'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'
import lighthouse from 'lighthouse'
import { handlePublicSite } from '../dist-server/public.js'
const output = new URL('../test-results-performance/', import.meta.url)
await mkdir(output, { recursive: true })
const at = '2026-10-17T08:00:00Z'
const ref = {
  slug: 'chapter-one',
  title: '合成章节',
  volumeOrder: 1,
  chapterOrder: 1,
  publishedAt: at,
  updatedAt: at,
}
const book = {
  slug: 'synthetic-book',
  title: '合成性能故事',
  penName: '合成作者',
  authorSlug: 'synthetic-author',
  tagline: '隔离性能测试公开介绍',
  description: '用于测量构建后公开页面，不含真实作品。',
  category: '科幻',
  serialStatus: 'ongoing',
  coverUrl: '',
  firstPublishedAt: at,
  updatedAt: at,
  chapterCount: 1,
  chapters: [ref],
}
const markdown = Array.from(
  { length: 120 },
  (_, n) =>
    `第${n + 1}段，河流绕过村庄，窗边的人打开远方来信。这是隔离的性能测试正文。`,
).join('\n\n')
const originalFetch = globalThis.fetch
// Imported Worker uses only this synthetic public origin. No bearer, state or model.
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : (input.url ?? input.href),
  )
  if (url.origin !== 'https://public-fixture.test')
    return originalFetch(input, init)
  const path = url.pathname
  const data = path.endsWith('/home')
    ? {
        items: [book],
        total: 1,
        featured: book,
        opening: markdown,
        categories: ['科幻'],
      }
    : path.endsWith('/categories')
      ? { items: ['科幻'] }
      : path === '/v1/public/books'
        ? { items: [book], total: 1, nextCursor: null }
        : path.includes('/chapters/')
          ? {
              ...ref,
              bookSlug: book.slug,
              markdown,
              previous: null,
              next: null,
            }
          : path.includes('/authors/')
            ? {
                slug: book.authorSlug,
                penName: book.penName,
                bio: '合成介绍',
                books: [book],
              }
            : book
  return Response.json(data)
}
const assets = new URL('../dist/', import.meta.url)
const contentType = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
}
async function asset(request) {
  const path = new URL(request.url).pathname
  const file =
    path.startsWith('/assets/') || path === '/favicon.svg' || path === '/og.svg'
      ? path.slice(1)
      : 'index.html'
  if (file.includes('..')) return new Response('Not found', { status: 404 })
  try {
    return new Response(await readFile(new URL(file, assets)), {
      headers: {
        'content-type':
          contentType[extname(file)] ?? 'application/octet-stream',
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
const server = createServer(async (req, res) => {
  try {
    const request = new Request('https://www.story2u.xyz' + req.url)
    const response =
      (await handlePublicSite(request, {
        BETTER_AUTH_URL: 'https://www.story2u.xyz',
        WRITER_AGENT_API_ORIGIN: 'https://public-fixture.test',
        ASSETS: { fetch: asset },
      })) ?? (await asset(request))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    res.writeHead(503)
    res.end('Fixture unavailable')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port
let browser
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--remote-debugging-port=9227'],
  })
  const rows = []
  for (const [name, path] of [
    ['home', '/'],
    ['book', '/books/synthetic-book'],
    ['reader', '/books/synthetic-book/chapters/chapter-one'],
    ['writers', '/writers'],
  ]) {
    const result = await lighthouse(base + path, {
      port: 9227,
      output: ['json', 'html'],
      onlyCategories: ['performance', 'seo', 'accessibility'],
      logLevel: 'error',
      blockedUrlPatterns: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'],
    })
    await writeFile(new URL(name + '.json', output), result.report[0])
    await writeFile(new URL(name + '.html', output), result.report[1])
    const lhr = result.lhr,
      audits = lhr.audits
    rows.push({
      page: name,
      performance: lhr.categories.performance.score,
      seo: lhr.categories.seo.score,
      accessibility: lhr.categories.accessibility.score,
      LCP_ms: audits['largest-contentful-paint'].numericValue,
      CLS: audits['cumulative-layout-shift'].numericValue,
      TBT_ms: audits['total-blocking-time'].numericValue,
      TTFB_ms: audits['server-response-time'].numericValue,
      INP: 'NOT VERIFIED: navigation lab has no field interaction distribution',
    })
  }
  const bundles = []
  for (const name of await readdir(new URL('assets/', assets))) {
    if (!/\.(js|css)$/.test(name)) continue
    const data = await readFile(new URL('assets/' + name, assets))
    bundles.push({ name, bytes: data.length, gzipBytes: gzipSync(data).length })
  }
  const timings = []
  for (let i = 0; i < 10; i++) {
    const begin = performance.now()
    const response = await originalFetch(
      base + '/books/synthetic-book/chapters/chapter-one',
    )
    await response.text()
    timings.push(performance.now() - begin)
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    fixture:
      'built local SSR + synthetic public metadata; lab mobile simulated throttling; external fonts blocked; no real production or author data',
    rows,
    bundles,
    localSSR_ms: timings,
    limitations:
      'Local TTFB excludes internet/EC2/TLS. Lighthouse scores are lab observations, not field p75 or real traffic. Inspect raw reports for accessibility/SEO opportunities.',
  }
  await writeFile(
    new URL('summary.json', output),
    JSON.stringify(summary, null, 2) + '\n',
  )
  console.log(JSON.stringify(summary, null, 2))
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
  globalThis.fetch = originalFetch
}
