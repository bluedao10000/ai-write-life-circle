// Isolated production-mode Go + actual workerd/D1 + signed Google test session + built browser UI.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { makeSignature } from 'better-auth/crypto'
import { chromium, expect } from '@playwright/test'
import { identityFixture } from '../../../scripts/lib/identity-fixture.mjs'
const identity = identityFixture()
const root = await mkdtemp(join(tmpdir(), 'story2u-release-'))
const origin = 'https://writer.example',
  secret = 'isolated-release-secret-with-no-production-credentials',
  bearer = 'abcdef0123456789'.repeat(4)
let mf, api, browser
const run = (args, env = {}) => {
  const r = spawnSync('pnpm', args, {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...env },
  })
  assert.equal(r.status, 0)
}
try {
  await mkdir(join(root, 'harness'))
  await writeFile(join(root, 'token'), bearer, { mode: 0o600 })
  api = spawn('../api-go/dist/writer-agent-api', [], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      WRITER_AGENT_ENV: 'production',
      WRITER_AGENT_AUTH_MODE: 'bearer',
      WRITER_AGENT_AUTH_TOKEN_FILE: join(root, 'token'),
      WRITER_AGENT_AUTHOR_ID: 'fixture-author',
      ...identity.goEnv,
      WRITER_AGENT_PROJECT_ID: 'empty-external',
      WRITER_AGENT_API_PORT: '8796',
      WRITER_AGENT_HARNESS_ROOT: join(root, 'harness'),
      WRITER_AGENT_STATE_DIR: join(root, 'state'),
      WRITER_AGENT_LLM_API_KEY: '',
      WRITER_AGENT_LLM_BASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  for (let i = 0; ; i++) {
    try {
      if ((await fetch('http://127.0.0.1:8796/healthz')).ok) break
    } catch {}
    if (i > 100) throw Error('Go did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
  const assets = join(root, 'assets')
  run(['exec', 'vite', 'build', '--outDir', assets], {
    VITE_WRITER_AGENT_MODE: 'api',
    VITE_WRITER_AGENT_AUTH: 'google',
    VITE_STORY2U_PUBLIC_SITE: 'true',
    VITE_WRITER_AGENT_PROJECT_ID: 'empty-external',
  })
  run([
    'exec',
    'wrangler',
    'deploy',
    '--dry-run',
    '--assets',
    assets,
    '--outdir',
    join(root, 'bundle'),
  ])
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: join(root, 'bundle'),
      scriptPath: join(root, 'bundle/index.js'),
      compatibilityDate: '2026-10-17',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { AUTH_DB: 'release-isolated' },
      bindings: {
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: secret,
        GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'fixture',
        WRITER_AGENT_IDENTITY_PRIVATE_KEY: identity.privateKey,
        WRITER_AGENT_PROJECT_ID: 'empty-external',
        WRITER_AGENT_API_TOKEN: bearer,
        WRITER_AGENT_API_ORIGIN: 'https://api.example',
      },
      outboundService: async (request) => {
        const url = new URL(request.url)
        assert.equal(url.origin, 'https://api.example')
        assert.equal(request.headers.has('cookie'), false)
        if (!url.pathname.startsWith('/v1/public/'))
          assert.equal(request.headers.get('authorization'), 'Bearer ' + bearer)
        else assert.equal(request.headers.has('authorization'), false)
        const headers = new Headers(request.headers)
        for (const key of [
          'host',
          'content-length',
          'transfer-encoding',
          'connection',
        ])
          headers.delete(key)
        const response = await fetch(
          'http://127.0.0.1:8796' + url.pathname + url.search,
          {
            method: request.method,
            headers,
            ...(request.method !== 'GET' && request.method !== 'HEAD'
              ? { body: await request.arrayBuffer() }
              : {}),
          },
        )
        if (response.status >= 400)
          console.log(
            'Fixture Go response',
            request.method,
            url.pathname,
            response.status,
            await response.clone().text(),
          )
        return response
      },
      serviceBindings: {
        ASSETS: async (request) => {
          const path = new URL(request.url).pathname
          const file =
            path.startsWith('/assets/') ||
            path === '/favicon.svg' ||
            path === '/og.svg'
              ? path.slice(1)
              : 'index.html'
          const target = resolve(assets, file)
          assert.ok(target.startsWith(assets + '/'))
          try {
            return new Response(await readFile(target), {
              headers: {
                'content-type':
                  {
                    '.html': 'text/html',
                    '.js': 'application/javascript',
                    '.css': 'text/css',
                    '.svg': 'image/svg+xml',
                  }[extname(file)] ?? 'application/octet-stream',
              },
            })
          } catch {
            return new Response('Not found', { status: 404 })
          }
        },
      },
    }),
  )
  const db = await mf.getD1Database('AUTH_DB')
  await db.exec(
    (
      await readFile(
        new URL('../migrations/0001_better_auth.sql', import.meta.url),
        'utf8',
      )
    )
      .replace(/^--.*$/gm, '')
      .trim(),
  )
  const now = Date.now(),
    token = 'isolated-google-session'
  await db
    .prepare(
      'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    )
    .bind('fixture-user', 'Fixture Author', 'author@example.com', 1, now, now)
    .run()
  await db
    .prepare(
      'INSERT INTO session (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    )
    .bind('fixture-session', token, 'fixture-user', now + 3600000, now, now)
    .run()
  const signed = encodeURIComponent(
      token + '.' + (await makeSignature(token, secret)),
    ),
    cookie = '__Secure-better-auth.session_token=' + signed
  const call = (path, data, auth = true) =>
    mf.dispatchFetch(origin + path, {
      method: data ? 'POST' : 'GET',
      headers: {
        ...(auth ? { cookie } : {}),
        ...(data
          ? {
              origin,
              'content-type': 'application/json',
              'idempotency-key': crypto.randomUUID(),
            }
          : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    })
  assert.equal((await call('/v1/studio/books', undefined, false)).status, 401)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  await context.addCookies([
    {
      name: '__Secure-better-auth.session_token',
      value: signed,
      url: origin,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  async function route(ctx) {
    await ctx.route('**/*', async (route) => {
      const r = route.request()
      if (!r.url().startsWith(origin + '/')) return route.abort()
      const response = await mf.dispatchFetch(r.url(), {
        method: r.method(),
        headers: await r.allHeaders(),
        ...(r.postDataBuffer() ? { body: r.postDataBuffer() } : {}),
        redirect: 'manual',
      })
      if (response.status >= 400)
        console.log(
          'Fixture Worker response',
          r.method(),
          new URL(r.url()).pathname,
          response.status,
          await response.clone().text(),
        )
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      })
    })
  }
  await route(context)
  const page = await context.newPage(),
    errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  console.log('Funnel: open studio')
  await page.goto(origin + '/studio')
  await expect(
    page.getByRole('heading', { name: '你的故事，从这里开始' }),
  ).toBeVisible()
  console.log('Funnel: create work')
  await page.getByRole('button', { name: '开始写作', exact: true }).click()
  const prose = '隔离合成故事，河流绕过村庄，窗边的人打开远方来信。'.repeat(100)
  await expect(page.getByLabel('正文编辑器')).toBeFocused()
  await page.getByLabel('正文编辑器').fill(prose)
  await expect(page.getByText(/^已保存 /)).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('正文编辑器')).toHaveText(prose)
  console.log('Funnel: saved and restored')
  const b = (await (await call('/v1/studio/books')).json()).items[0]
  const toggle = page.getByRole('button', { name: '目录与本章相关' })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click()
  await page.getByLabel('新建章节或卷').click()
  await page.getByRole('button', { name: '新章节', exact: true }).click()
  await page.getByLabel('正文编辑器').fill('NEVER_PUBLIC_SECOND_CHAPTER')
  await page.getByLabel('新建章节或卷').click()
  await page.getByRole('button', { name: '新卷', exact: true }).click()
  await page.getByLabel('卷名称').fill('合成第一卷')
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await expect(page.getByLabel('卷名称')).toHaveCount(0)
  await page.getByLabel('第一章菜单').click()
  await page.getByLabel('第一章移动到卷').selectOption({ label: '合成第一卷' })
  console.log('Funnel: publish')
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '读者会看到的资料' }),
  ).toBeVisible()
  for (const [label, value] of [
    ['书名', '隔离发布故事'],
    ['公开地址', 'release-fixture'],
    ['笔名', '合成作者'],
    ['一句话简介', '合成介绍'],
    ['作品简介', '作者确认的合成作品说明'],
  ])
    await page.getByRole('textbox', { name: label, exact: true }).fill(value)
  await page.getByRole('button', { name: '科幻', exact: true }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  // Only the moved first chapter is selected; unpublished second stays private.
  await page.getByRole('checkbox').last().check()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(page.getByRole('heading', { name: '读者将看到' })).toBeVisible()
  await expect(page.getByText(prose, { exact: false }).first()).toBeVisible()
  await expect(page.getByText('合成第一卷', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('checkbox').nth(0).check()
  await page.getByRole('checkbox').nth(1).check()
  console.log('Funnel: publish')
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '《隔离发布故事》已发布' }),
  ).toBeVisible()
  const management = await (
      await call(`/v1/studio/books/${b.bookId}/publication`)
    ).json(),
    version = management.publication.versions.at(-1)
  assert.equal(version.chapters.length, 1)
  assert.equal(version.chapters[0].volumeTitle, '合成第一卷')
  assert.equal(version.chapters[0].chapterId, 'CH-000001')
  const reader = '/books/release-fixture/chapters/' + version.chapters[0].slug
  const anon = await browser.newContext()
  await route(anon)
  const rp = await anon.newPage()
  await rp.goto(origin + '/')
  await expect(
    rp.getByRole('heading', { name: '隔离发布故事', exact: true }),
  ).toBeVisible()
  await rp.goto(origin + '/books/release-fixture')
  await expect(rp.getByRole('heading', { name: '合成第一卷', exact: true })).toBeVisible()
  await rp.goto(origin + reader)
  await expect(rp.getByRole('article')).toContainText(prose)
  await expect(rp.getByRole('article')).toContainText('合成第一卷')
  await expect(rp.locator('html')).toHaveAttribute('data-site-hydrated', 'true')
  // Hydration precedes the Reader's font/layout restoration lifecycle. Wait for
  // its first persisted position before issuing the simulated user scroll.
  await expect.poll(()=>rp.evaluate(()=>JSON.parse(localStorage.getItem('story2u.progress.v2')||'{}')['release-fixture']?.chapter)).toBe(version.chapters[0].slug)
  await rp.evaluate(() =>
    scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * 0.5),
  )
  await expect
    .poll(() =>
      rp.evaluate(
        () =>
          JSON.parse(localStorage.getItem('story2u.progress.v2') || '{}')[
            'release-fixture'
          ]?.ratio,
      ),
    )
    .toBeGreaterThan(0.4)
  await rp.reload()
  await expect.poll(() => rp.evaluate(() => scrollY)).toBeGreaterThan(100)
  const raw = await (await call(reader, undefined, false)).text()
  assert.ok(raw.includes(prose))
  assert.ok(!raw.includes('NEVER_PUBLIC_SECOND_CHAPTER'))
  assert.ok(!raw.includes(bearer))
  assert.ok(!raw.includes('ownerUserId'))
  assert.equal(
    (await call('/books/release-fixture/chapters/CH-000002', undefined, false))
      .status,
    404,
  )
  console.log('Funnel: open studio')
  // V3 opens 灵感 by default; the manuscript lives in the reading space.
  await page.goto(origin + '/studio?view=read&compose=1')
  await expect(page.getByLabel('正文编辑器')).toBeVisible()
  const reopen = page.getByRole('button', { name: '目录与本章相关' })
  if ((await reopen.getAttribute('aria-pressed')) !== 'true')
    await reopen.click()
  await page.getByRole('button', { name: '第一章', exact: true }).click()
  await page.getByLabel('正文编辑器').fill(prose + 'PRIVATE_AFTER_PUBLICATION')
  await expect(page.getByText(/^已保存 /)).toBeVisible()
  assert.ok(
    !(await (await call(reader, undefined, false)).text()).includes(
      'PRIVATE_AFTER_PUBLICATION',
    ),
  )
  const unlist = await call(`/v1/studio/books/${b.bookId}/publication/unlist`, {
    baseVersionId: version.versionId,
  })
  assert.equal(unlist.status, 201)
  assert.equal((await call(reader, undefined, false)).status, 404)
  assert.ok(
    !(await (await call('/sitemap.xml', undefined, false)).text()).includes(
      'release-fixture',
    ),
  )
  assert.deepEqual(errors, [])
  console.log(
    'PASS: signed Google test session → production-mode Go managed writing → fixed-revision wizard → anonymous SSR/progress → draft isolation/unlist/sitemap. No real Google or production data used.',
  )
} finally {
  await browser?.close()
  await mf?.dispose()
  api?.kill()
  await rm(root, { recursive: true, force: true })
}
