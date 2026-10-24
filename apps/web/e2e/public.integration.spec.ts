import { expect, test } from '@playwright/test'
const studio = '/v1/studio/books/site-fixture/publication',
  project = '/v1/projects/site-fixture'
test('real Studio publish → anonymous SSR reading → draft isolation → update → withdraw/unlist/relist', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120000)
  let draftReads = 0
  page.on('request', (r) => {
    if (
      r.method() === 'GET' &&
      /\/v1\/projects\/[^/]+\/chapters\/[^/?]+(?:\?.*)?$/.test(r.url())
    )
      draftReads++
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/fonts.googleapis.com/**', (r) => r.abort())
  await page.route('**/fonts.gstatic.com/**', (r) => r.abort())
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: /第一部故事，\s*正在被写下。/ }),
  ).toBeVisible()
  await expect(page.getByText('雾港来信')).toHaveCount(0)
  const empty = await request.get('/')
  expect(await empty.text()).toContain('第一部故事')
  expect(empty.headers()['cache-control']).toBe('no-store')
  await page.goto('/studio')
  await expect(page.getByLabel('正文编辑器')).toBeVisible()
  draftReads = 0
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '读者会看到的资料' }),
  ).toBeVisible()
  expect(draftReads).toBe(0)
  for (const [label, value] of [
    ['书名', '合成来信'],
    ['公开地址', 'synthetic-letter'],
    ['笔名', '公开笔名'],
    ['一句话简介', '一封远方来信，一个尚未讲完的故事。'],
    ['作品简介', '这是隔离测试中作者主动发布的作品。'],
    ['作者介绍', '公开作者介绍。'],
  ])
    await page.getByRole('textbox', { name: label, exact: true }).fill(value)
  await page.getByRole('button', { name: '科幻', exact: true }).click()
  await page.getByRole('button', { name: '封面配色 1', exact: true }).click()
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({
      path: `test-results-public/wizard-metadata-${width}.png`,
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })

  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('checkbox').first().check()
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({
      path: `test-results-public/wizard-chapters-${width}.png`,
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(page.getByRole('heading', { name: '读者将看到' })).toBeVisible()
  expect(draftReads).toBe(0)
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.evaluate(() => scrollTo(0, 0))
    await page.screenshot({
      path: `test-results-public/wizard-preview-${width}.png`,
    })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '发布', exact: true }),
  ).toBeDisabled()
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({
      path: `test-results-public/wizard-confirm-${width}.png`,
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page
    .getByRole('textbox', { name: '发布说明（仅你可见）' })
    .fill('PRIVATE_AUTHOR_PUBLICATION_NOTE')
  await page.getByRole('checkbox').nth(0).check()
  await page.getByRole('checkbox').nth(1).check()
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '《合成来信》已发布' }),
  ).toBeVisible()
  let management = await (await request.get(studio)).json(),
    version = management.publication.versions.at(-1)
  expect(version.note).toBe('PRIVATE_AUTHOR_PUBLICATION_NOTE')
  expect(JSON.stringify(management)).not.toContain('markdown')
  const slug = version.chapters[0].slug,
    book = '/books/synthetic-letter',
    reader = `${book}/chapters/${slug}`
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: '合成来信', exact: true }),
  ).toBeVisible()
  await page.goto(book)
  await expect(page.getByRole('link', { name: /第1章 合成故事/ })).toHaveCount(
    1,
  )
  await expect(page.getByText('第2章 合成故事', { exact: true })).toHaveCount(0)
  for (const path of [
    book,
    reader,
    `/authors/${management.publication.authorSlug}`,
  ]) {
    const response = await request.get(path)
    expect(response.status()).toBe(200)
    const html = await response.text()
    expect(html).toContain('rel="canonical"')
    expect(html).toContain('property="og:title"')
    expect(html).toContain('application/ld+json')
    for (const secret of [
      'NEVER_PUBLIC_SITE_NOTE',
      'PRIVATE_AUTHOR_PUBLICATION_NOTE',
      'ownerUserId',
      'sourceRevisionId',
      'sourceContentHash',
      'local-author',
      '第2章第1段',
      '第3章第1段',
    ])
      expect(html).not.toContain(secret)
  }
  const rawBook = await request.get(book)
  const bookHTML = await rawBook.text()
  const authoritativeTitle = /<title>([^<]+)<\/title>/.exec(bookHTML)![1]
  await page.goto(book)
  await expect(page.locator('html')).toHaveAttribute('data-site-hydrated', 'true')
  await expect(page).toHaveTitle(authoritativeTitle)
  await expect(page.getByRole('link', { name: '开始阅读', exact: true })).toHaveAttribute('href', reader)
  const rawReader = await request.get(reader)
  expect(await rawReader.text()).toContain('第1章第1段')
  expect((await request.get(`${book}/chapters/CH-002`)).status()).toBe(404)
  expect(await (await request.get('/robots.txt')).text()).toContain(
    'Disallow: /studio',
  )
  expect((await request.get('/studio')).headers()['x-robots-tag']).toBe(
    'noindex,nofollow',
  )
  const sitemap = await (await request.get('/sitemap.xml')).text()
  expect(sitemap).toContain(slug)
  expect(sitemap).not.toContain('CH-002')
  expect(await (await request.get('/discover?q=missing')).text()).toContain(
    'noindex',
  )
  // Reader has no editor/author management. A separate anonymous browser gets SSR content.
  const anonymous = await browser.newContext({ javaScriptEnabled: false })
  const readerPage = await anonymous.newPage()
  await readerPage.goto('http://127.0.0.1:5177' + reader)
  await expect(
    readerPage.getByRole('heading', { name: '第1章 合成故事', exact: true }),
  ).toBeVisible()
  await expect(
    readerPage.getByText('第1章第1段。', { exact: false }).first(),
  ).toBeVisible()
  await anonymous.close()
  await page.goto(reader)
  await expect(page.getByRole('article')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute(
    'data-site-hydrated',
    'true',
  )
  await expect(page.getByLabel('正文编辑器')).toHaveCount(0)
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await page.getByRole('button', { name: '字号增大' }).click()
  await page.getByRole('button', { name: '柔和', exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(() =>
    window.scrollTo(
      0,
      (document.documentElement.scrollHeight - innerHeight) * 0.48,
    ),
  )
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('story2u.progress.v2') || '{}')[
            'synthetic-letter'
          ]?.ratio,
      ),
    )
    .toBeGreaterThan(0.4)
  const saved = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('story2u.progress.v2') || '{}')[
        'synthetic-letter'
      ],
  )
  await page.reload()
  await expect(page.getByRole('article')).toBeVisible()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          scrollY /
          Math.max(1, document.documentElement.scrollHeight - innerHeight),
      ),
    )
    .toBeGreaterThan(0.35)
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('story2u.progress.v2') || '{}')[
          'synthetic-letter'
        ].ratio,
    ),
  ).toBeGreaterThan(saved.ratio - 0.08)
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('story2u.reader.v2') || '{}').theme,
    ),
  ).toBe('soft')
  const anchorBefore = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('story2u.progress.v2') || '{}')[
        'synthetic-letter'
      ].anchor,
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(async () => page.evaluate(() => scrollY))
    .toBeGreaterThan(500)
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('story2u.progress.v2') || '{}')[
          'synthetic-letter'
        ].anchor,
    ),
  ).toBe(anchorBefore)
  // Private save remains private until explicitly previewed and committed.
  const detail = await (await request.get(`${project}/chapters/CH-001`)).json()
  await request.post(`${project}/chapters/CH-001/revisions`, {
    headers: { 'Idempotency-Key': 'private-edit' },
    data: {
      baseRevisionId: detail.headRevision.revisionId,
      markdown: detail.headRevision.markdown + '\n\nPRIVATE_NEW_DRAFT',
    },
  })
  expect(await (await request.get(reader)).text()).not.toContain(
    'PRIVATE_NEW_DRAFT',
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/studio/publish')
  await expect(
    page.getByText('已公开 · 草稿有新的修改', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '更新公开版本…', exact: true }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(
    page.getByText('PRIVATE_NEW_DRAFT', { exact: false }).first(),
  ).toBeVisible()
  // A later saved revision invalidates the fixed preview, never silently publishes it.
  const before = await (await request.get(`${project}/chapters/CH-001`)).json()
  await request.post(`${project}/chapters/CH-001/revisions`, {
    headers: { 'Idempotency-Key': 'concurrent-edit' },
    data: {
      baseRevisionId: before.headRevision.revisionId,
      markdown: before.headRevision.markdown + '\n\nCONCURRENT_DRAFT',
    },
  })
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('checkbox').nth(0).check()
  await page.getByRole('checkbox').nth(1).check()
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/changed|变化|冲突/)
  expect(
    (await (await request.get(studio)).json()).publication.versions,
  ).toHaveLength(1)
  // Retry in the same wizard: the next preview reloads saved revisions.
  await page.getByRole('button', { name: '上一步', exact: true }).click()
  await page.getByRole('button', { name: '上一步', exact: true }).click()
  await page.getByRole('checkbox').nth(1).check()
  await page.getByRole('checkbox').nth(2).check()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(
    page.getByText('CONCURRENT_DRAFT', { exact: false }).first(),
  ).toBeVisible()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('checkbox').nth(0).check()
  await page.getByRole('checkbox').nth(1).check()
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '《合成来信》已发布' }),
  ).toBeVisible()
  management = await (await request.get(studio)).json()
  version = management.publication.versions.at(-1)
  expect(version.versionNumber).toBe(2)
  expect(
    version.chapters.map((c: { chapterId: string }) => c.chapterId),
  ).toEqual(['CH-001', 'CH-002', 'CH-003'])
  expect(management.publication.versions[0].chapters).toHaveLength(1)
  expect(await (await request.get(reader)).text()).toContain('CONCURRENT_DRAFT')
  const second = version.chapters[1].slug,
    third = version.chapters[2].slug
  expect(
    (
      await (
        await request.get(
          `/v1/public/books/synthetic-letter/chapters/${second}`,
        )
      ).json()
    ).next,
  ).toBe(third)
  // Four viewport captures from real published snapshots.
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const [name, path] of [
      ['home', '/'],
      ['discover', '/discover'],
      ['book', book],
      ['reader', reader],
      ['publication', '/studio/publish'],
      ['writers', '/writers'],
    ]) {
      await page.goto(path)
      await expect(page.locator('main').first()).toBeVisible()
      if (!path.startsWith('/studio'))
        await expect(page.locator('html')).toHaveAttribute(
          'data-site-hydrated',
          'true',
        )
      await page.screenshot({
        path: `test-results-public/${name}-${width}.png`,
        fullPage: name !== 'reader',
      })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true)
    }
  }
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute(
    'data-site-hydrated',
    'true',
  )
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({
      path: `test-results-public/home-dark-${width}.png`,
      fullPage: true,
    })
    await page.goto('/studio/publish')
    await expect(
      page.getByRole('heading', { name: '合成来信', exact: true }),
    ).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.screenshot({
      path: `test-results-public/publication-dark-${width}.png`,
      fullPage: true,
    })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute(
      'data-site-hydrated',
      'true',
    )
  }
  // Withdraw chapter using a new complete fixed-revision set.
  const choices = version.chapters
    .filter((c: { chapterId: string }) => c.chapterId !== 'CH-001')
    .map(
      (c: {
        chapterId: string
        revisionId: string
        contentHash: string
        volumeId: string
        chapterOrder: number
      }) => ({
        chapterId: c.chapterId,
        revisionId: c.revisionId,
        contentHash: c.contentHash,
        volumeId: c.volumeId,
        chapterOrder: c.chapterOrder,
      }),
    )
  const preview = await (
    await request.post(studio + '/preview', {
      data: {
        baseVersionId: version.versionId,
        metadata: version.metadata,
        chapters: choices,
      },
    })
  ).json()
  const withdrawn = await (
    await request.post(studio + '/versions', {
      headers: { 'Idempotency-Key': 'withdraw' },
      data: { baseVersionId: version.versionId, previewId: preview.previewId },
    })
  ).json()
  expect((await request.get(reader)).status()).toBe(404)
  expect(await (await request.get('/sitemap.xml')).text()).not.toContain(slug)
  const unlisted = await (
    await request.post(studio + '/unlist', {
      headers: { 'Idempotency-Key': 'unlist' },
      data: { baseVersionId: withdrawn.versionId },
    })
  ).json()
  expect((await request.get(book)).status()).toBe(404)
  expect((await (await request.get('/v1/public/home')).json()).total).toBe(0)
  expect(await (await request.get('/sitemap.xml')).text()).not.toContain(
    'synthetic-letter',
  )
  expect(errors).toEqual([])
  await request.post(studio + '/relist', {
    headers: { 'Idempotency-Key': 'relist' },
    data: { baseVersionId: unlisted.versionId },
  })
  expect((await request.get(book)).status()).toBe(200)
})
