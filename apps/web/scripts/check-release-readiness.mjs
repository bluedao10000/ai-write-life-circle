// GET/HEAD only. Never creates a session, book, revision or publication.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
const origin = process.env.STORY2U_CHECK_ORIGIN || 'https://www.story2u.xyz'
const site = new URL(origin)
assert.equal(site.protocol, 'https:')
assert.equal(site.pathname, '/')
const results = []
async function get(path, status = 200) {
  const begin = performance.now()
  const r = await fetch(new URL(path, site), {
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  })
  assert.equal(r.status, status, path)
  results.push({
    path,
    status: r.status,
    headers_ms: Math.round(performance.now() - begin),
  })
  return r
}
function htmlCheck(html, path) {
  const d = new JSDOM(html).window.document
  assert.equal(d.querySelectorAll('link[rel=canonical]').length, 1, path)
  assert.equal(
    d.querySelector('link[rel=canonical]').href,
    new URL(path, site).href,
  )
  assert.ok(d.title)
  assert.ok(d.querySelector('meta[name=description]')?.content)
  assert.ok(d.querySelector('meta[property="og:title"]')?.content)
  assert.ok(d.querySelector('#story2u-data'), 'SSR data missing')
  for (const script of d.querySelectorAll('script[type="application/ld+json"]'))
    JSON.parse(script.textContent)
  const hydration = JSON.parse(d.querySelector('#story2u-data').textContent)
  const forbidden = [
    'ownerUserId',
    'sourceRevisionId',
    'sourceContentHash',
    'auditReference',
    'access_token',
    'apiKey',
  ]
  for (const field of forbidden)
    assert.ok(
      !JSON.stringify(hydration).includes('"' + field + '"'),
      'Private field in SSR data',
    )
}
for (const path of ['/', '/writers', '/discover'])
  htmlCheck(await (await get(path)).text(), path)
await get('/release-readiness-nonexistent', 404)
const studio = await get('/studio')
assert.match(studio.headers.get('x-robots-tag') || '', /noindex/)
const privateAPI = await get('/v1/studio/books', 401)
assert.equal(privateAPI.headers.get('cache-control'), 'no-store')
const robots = await (await get('/robots.txt')).text()
assert.match(robots, /Disallow: \/studio/)
assert.ok(robots.includes(site.origin + '/sitemap.xml'))
const sitemap = await (await get('/sitemap.xml')).text()
assert.ok(!/\/studio|\/preview|\/v1\//.test(sitemap))
const home = await (await get('/v1/public/home')).json()
if (home.items.length) {
  const b = home.items[0]
  for (const path of [
    `/books/${b.slug}`,
    `/authors/${b.authorSlug}`,
    `/books/${b.slug}/chapters/${b.chapters[0].slug}`,
  ])
    htmlCheck(await (await get(path)).text(), path)
} else
  results.push({
    public_book_verification:
      'NOT VERIFIED: no listed work available; isolated fixtures cover this flow',
  })
for (const host of [
  'https://story2u.xyz',
  'http://story2u.xyz',
  'http://www.story2u.xyz',
]) {
  if (site.hostname !== 'www.story2u.xyz') break
  const r = await fetch(host + '/discover?q=readiness', {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  assert.equal(r.url, site.origin + '/discover?q=readiness')
  assert.equal(r.status, 200)
}
const health = await fetch('https://api.story2u.xyz/healthz', {
  redirect: 'error',
  signal: AbortSignal.timeout(20000),
})
assert.equal(health.status, 200)
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      mode: 'read-only, anonymous',
      origin: site.origin,
      results,
      production_writes: false,
      google_provider_login: 'NOT VERIFIED',
      search_console_or_analytics: 'NOT VERIFIED',
    },
    null,
    2,
  ),
)
