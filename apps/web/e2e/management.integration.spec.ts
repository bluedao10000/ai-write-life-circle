import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { ManagedBook } from '@writer-agent/contracts'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
async function create(api: APIRequestContext, title?: string) {
  const r = await api.post('/v1/studio/books', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: {
      operation: 'create',
      baseVersion: 0,
      ...(title ? { title } : {}),
    },
  })
  expect(r.status()).toBe(201)
  return (await r.json()) as ManagedBook
}
async function open(page: Page, b: ManagedBook) {
  await page.addInitScript(
    (id) => { if(!sessionStorage.getItem('writer-agent:selected-book')) sessionStorage.setItem('writer-agent:selected-book', id) },
    b.bookId,
  )
  await page.goto('/studio?view=read&compose=1')
  await expect(page.getByLabel('正文编辑器')).toBeVisible()
}
async function directory(page: Page) {
  const toggle = page.getByRole('button', { name: '目录与本章相关' })
  if(await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
  await expect(page.getByRole('heading', { name: '目录', exact: true })).toBeVisible()
}
async function addChapter(page: Page) {
  await page.getByLabel('新建章节或卷').click()
  await page.getByRole('button', { name: '新章节', exact: true }).click()
}
async function workMenu(page: Page, title?: string) {
  const trigger = title
    ? page.getByRole('button', { name: `当前作品：${title}，切换作品` })
    : page.getByRole('button', { name: /^当前作品：.*，切换作品$/ })
  if ((await trigger.getAttribute('aria-pressed')) !== 'true') await trigger.click()
  return page.getByRole('menu', { name: '作品菜单' })
}

async function syntheticEPUB() {
  const dir = await mkdtemp(join(tmpdir(), 'story2u-epub-e2e-'))
  const path = join(dir, 'synthetic.epub')
  await promisify(execFile)(process.execPath, [join(import.meta.dirname, 'make-epub.mjs'), path])
  return { dir, path }
}

test('zero-config first work, focused editor, 200 characters autosave and refresh', async ({
  page,
}) => {
  await page.goto('/studio?view=read&compose=1')
  await expect(page.getByRole('heading', { name: '你的故事，从这里开始' })).toBeVisible()
  await page.getByRole('button', { name: '开始写作' }).click()
  const editor = page.getByLabel('正文编辑器')
  await expect(editor).toBeFocused()
  const prose = '雨落在窗前，他记起昨日约定。'.repeat(20)
  await editor.fill(prose)
  await expect(page.getByText(/^已保存 /)).toBeVisible()
  await page.reload()
  await expect(editor).toHaveText(prose)
  await page.screenshot({
    path: '/tmp/story2u-managed-first-chapter.png',
    fullPage: true,
  })
})
test('create second chapter without losing the first draft', async ({ page, request }) => {
  const b = await create(request)
  await open(page, b)
  await page.getByLabel('正文编辑器').fill('第一章合成正文，切章前自动保存。')
  await directory(page)
  await addChapter(page)
  await expect(page.getByRole('heading', { name: '第2章', exact: true })).toBeVisible()
  await page.getByLabel('正文编辑器').fill('独立的第二章。')
  await page.getByRole('button', { name: '第一章', exact: true }).click()
  await expect(page.getByLabel('正文编辑器')).toContainText('第一章合成正文')
})
test('create empty volumes, inline rename, move chapter and persist order', async ({
  page,
  request,
}) => {
  const b = await create(request)
  await open(page, b)
  await directory(page)
  for (const title of ['第一卷', '第二卷']) {
    await page.getByLabel('新建章节或卷').click()
    await page.getByRole('button', { name: '新卷', exact: true }).click()
    const input = page.getByLabel('卷名称')
    await expect(input).toBeFocused()
    await input.fill(title)
    await page.getByRole('button', { name: '保存名称', exact: true }).click()
    await expect(input).toHaveCount(0)
  }
  await page.getByLabel('第一章菜单').click()
  await page.getByLabel('第一章移动到卷').selectOption({ label: '第二卷' })
  await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: '第二卷', exact: true }) }).getByRole('button', { name: '第一章', exact: true })).toBeVisible()
  // Archived entries must survive a later active-volume permutation.
  await page.getByLabel('新建章节或卷').click()
  await page.getByRole('button', { name: '新卷', exact: true }).click()
  await page.getByLabel('卷名称').fill('第三卷')
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await expect(page.getByRole('heading', { name: '第三卷', exact: true })).toBeVisible()
  await page.getByLabel('第一卷菜单').click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '归档空卷', exact: true }).click()
  await expect(page.getByRole('heading', { name: '第一卷', exact: true })).toHaveCount(0)
  await page.getByLabel('第三卷菜单').click()
  await page.getByRole('button', { name: '卷上移', exact: true }).click()
  await expect.poll(async () => (await (await request.get(`/v1/studio/books/${b.bookId}`)).json()).volumes.filter((v: { archived?: boolean }) => !v.archived).map((v: { title: string }) => v.title)).toEqual(['第三卷', '第二卷'])
  const ordered = await (await request.get(`/v1/studio/books/${b.bookId}`)).json()
  expect(ordered.volumes).toHaveLength(3)
  expect(ordered.volumes.find((v: { title: string }) => v.title === '第一卷').archived).toBe(true)
  await page.reload()
  await directory(page)
  await expect(
    page
      .locator('section')
      .filter({
        has: page.getByRole('heading', { name: '第二卷', exact: true }),
      })
      .getByRole('button', { name: '第一章', exact: true }),
  ).toBeVisible()
})
test('create and switch books; independent draft, Review and Publication scope', async ({
  page,
  request,
}) => {
  const b = await create(request)
  const invalidTitle = await request.post('/v1/studio/books', { headers: { 'idempotency-key': crypto.randomUUID() }, data: { operation: 'create', baseVersion: 0, title: '😀'.repeat(101) } })
  expect(invalidTitle.status()).toBe(422)
  await open(page, b)
  await page.getByLabel('正文编辑器').fill('作品甲专属文字。')
  await workMenu(page, b.title)
  await page.getByRole('menuitem', { name: '新建空白作品' }).click()
  await expect(page.getByRole('menu', { name: '作品菜单' })).toHaveCount(0)
  await expect(page.getByLabel('正文编辑器')).toHaveText('')
  const list = (await (await request.get('/v1/studio/books')).json()) as {
    items: ManagedBook[]
  }
  const other = list.items.at(-1)!
  expect(other.bookId).not.toBe(b.bookId)
  const review = await request.get(`/v1/projects/${other.bookId}/chapters/CH-000001/reviews`)
  expect(review.ok()).toBe(true)
  expect((await review.json()).items).toHaveLength(0)
  const publication = await (
    await request.get(`/v1/studio/books/${other.bookId}/publication`)
  ).json()
  expect(publication.publication).toBeNull()
  expect(publication.drafts[0].isEmpty).toBe(true)
  const detail = await (await request.get(`/v1/projects/${b.bookId}/chapters/CH-000001`)).json()
  expect(detail.headRevision.markdown).toContain('作品甲专属文字')
  // A direct bookmark must select the same book as the Studio menu, too.
  const selectedPublication = page.waitForResponse(response => response.url().endsWith(`/v1/studio/books/${other.bookId}/publication`) && response.ok())
  await page.goto('/studio/publish')
  await selectedPublication
  await expect(page.getByRole('heading', { name: '读者会看到的资料' })).toBeVisible()
})
test('archive confirmation and restore preserve saved prose', async ({ page, request }) => {
  const b = await create(request)
  await open(page, b)
  await page.getByLabel('正文编辑器').fill('归档后仍然保留的合成正文。')
  await directory(page)
  await expect(page.getByText(/^已保存 /)).toBeVisible()
  const publicationURL = `/v1/studio/books/${b.bookId}/publication`
  const drafts = (await (await request.get(publicationURL)).json()).drafts
  const metadata = {
    slug: 'synthetic-archive-' + b.bookId.slice(-8),
    title: '合成归档作品',
    penName: '合成作者',
    tagline: '隔离发布测试',
    description: '归档不改变公开快照。',
    authorBio: '',
    coverUrl: '',
    category: '科幻',
    serialStatus: 'ongoing',
  }
  const preview = await request.post(publicationURL + '/preview', {
    data: {
      baseVersionId: null,
      metadata,
      chapters: drafts.map(
        (d: {
          chapterId: string
          revisionId: string
          contentHash: string
          volumeId: string
          chapterOrder: number
        }) => ({
          chapterId: d.chapterId,
          revisionId: d.revisionId,
          contentHash: d.contentHash,
          volumeId: d.volumeId,
          chapterOrder: d.chapterOrder,
        }),
      ),
    },
  })
  expect(preview.status()).toBe(200)
  const publication = await request.post(publicationURL + '/versions', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: { baseVersionId: null, previewId: (await preview.json()).previewId },
  })
  expect(publication.status()).toBe(201)
  const version = await publication.json()
  const publicURL = `/v1/public/books/${metadata.slug}/chapters/${version.chapters[0].slug}`
  const publicResponse = await request.get(publicURL)
  expect(publicResponse.status()).toBe(200)
  const beforeArchive = await publicResponse.json()
  expect(JSON.stringify(beforeArchive)).toContain('归档后仍然保留的合成正文。')
  await page.getByLabel('第一章菜单').click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '归档', exact: true }).click()
  await expect(page.getByText('还没有章节', { exact: true })).toBeVisible()
  expect(await (await request.get(publicURL)).json()).toEqual(beforeArchive)
  await page.getByText('已归档章节', { exact: true }).click()
  await page.getByRole('button', { name: '恢复', exact: true }).click()
  await expect(page.getByLabel('正文编辑器')).toContainText('归档后仍然保留')
})
test('two browser structure edits yield a visible 409; stale view can refresh safely', async ({
  browser,
  request,
}) => {
  const b = await create(request)
  const a = await browser.newPage(),
    z = await browser.newPage()
  await open(a, b)
  await open(z, b)
  await directory(a)
  await directory(z)
  await addChapter(a)
  await expect(a.getByRole('heading', { name: '第2章', exact: true })).toBeVisible()
  await addChapter(z)
  await expect(z.getByRole('alert')).toContainText('作品目录已在另一处更新')
  await z.getByRole('button', { name: '刷新目录' }).click()
  await expect(z.getByRole('button', { name: '第2章', exact: true })).toBeVisible()
  await a.close()
  await z.close()
})

test('upload EPUB, preview corrected names, atomically import and restore saved prose', async ({
  page,
  request,
}) => {
  const fixture = await syntheticEPUB()
  try {
    await page.goto('/studio?view=read&compose=1')
    await expect(page.getByRole('heading', { name: '合成导入作品', exact: true })).toHaveCount(0)
    const emptyStateImport = page.getByRole('button', {
      name: '从 EPUB 导入作品',
      exact: true,
    })
    if (await emptyStateImport.isVisible()) {
      await emptyStateImport.click()
    } else {
      await workMenu(page)
      await page.getByRole('menuitem', { name: '从 EPUB 导入' }).click()
    }
    await expect(page.getByRole('heading', { name: '从 EPUB 导入作品' })).toBeVisible()
    await page.getByLabel(/选择 EPUB 小说/).setInputFiles(fixture.path)
    await page.getByRole('button', { name: '解析并预览' }).click()
    await expect(page.getByLabel('作品名称')).toHaveValue('合成导入作品')
    await expect(page.getByLabel('章名 1')).toHaveValue('第一章')
    await page.getByLabel('作品名称').fill('浏览器确认书名')
    await page.getByLabel('章名 1').fill('第一章 合成改名')
    await page.getByRole('button', { name: '确认导入作品' }).click()
    await expect(page.getByLabel('正文编辑器')).toContainText('合成第一章正文')

    const books = (await (await request.get('/v1/studio/books')).json()) as {
      items: ManagedBook[]
    }
    const imported = books.items.find((book) => book.title === '浏览器确认书名')
    expect(imported).toBeDefined()
    expect(imported?.chapters).toHaveLength(2)
    expect(imported?.chapters[0]?.title).toBe('第一章 合成改名')
    const detail = await (
      await request.get(`/v1/projects/${imported?.bookId}/chapters/CH-000002`)
    ).json()
    expect(detail.headRevision.markdown).toContain('合成第二章正文')

    await page.reload()
    await expect(page.getByLabel('正文编辑器')).toContainText('合成第一章正文')
    await directory(page)
    await page.getByRole('complementary').getByRole('button', { name: '第二章', exact: true }).click()
    await expect(page.getByLabel('正文编辑器')).toContainText('合成第二章正文')
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})
test('failed save blocks structure changes and preserves editor text', async ({
  page,
  request,
}) => {
  const b = await create(request)
  await open(page, b)
  await directory(page)
  await page.route('**/revisions', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            code: 'UNAVAILABLE',
            status: 503,
            detail: '合成存储故障',
          }),
        })
      : route.continue(),
  )
  await page.getByLabel('正文编辑器').fill('保存失败时不可丢失的内容。')
  await addChapter(page)
  await expect(page.getByRole('alert').filter({ hasText: '正文尚未安全保存' })).toBeVisible()
  await expect(page.getByLabel('正文编辑器')).toContainText('保存失败时不可丢失的内容')
  const current = await (await request.get(`/v1/studio/books/${b.bookId}`)).json()
  expect(current.chapters).toHaveLength(1)
})

test('delete requires confirmation, removes the book and selects the remaining work', async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const first = await create(request, `待删除作品-${suffix}`)
  const second = await create(request, `保留作品-${suffix}`)
  await open(page, first)
  await workMenu(page, first.title)
  await page.getByRole('menuitem', { name: /^全部作品/ }).click()
  const shelf = page.getByRole('dialog', { name: '全部作品' })
  await shelf
    .locator(`[data-book-card="${first.bookId}"]`)
    .getByRole('button', { name: `删除《${first.title}》` })
    .click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect((await request.get(`/v1/studio/books/${first.bookId}`)).status()).toBe(200)
  await page
    .locator(`[data-book-card="${first.bookId}"]`)
    .getByRole('button', { name: `删除《${first.title}》` })
    .click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await request.get(`/v1/studio/books/${first.bookId}`)).status(),
    )
    .toBe(404)
  const current = page.locator('[data-current-book-id]')
  await expect(current).toBeVisible()
  const retainedId = await current.getAttribute('data-current-book-id')
  expect(retainedId).not.toBe(first.bookId)
  await page.reload()
  await expect(
    page.locator(`[data-current-book-id="${retainedId}"]`),
  ).toBeVisible()
  await workMenu(page)
  await page.getByRole('menuitem', { name: /^全部作品/ }).click()
  await page
    .locator(`[data-book-card="${second.bookId}"]`)
    .getByRole('button', { name: `打开《${second.title}》` })
    .click()
  await expect(
    page.locator(`[data-current-book-id="${second.bookId}"]`),
  ).toBeVisible()
  await workMenu(page, second.title)
  await page.getByRole('menuitem', { name: /^全部作品/ }).click()
  await page
    .locator(`[data-book-card="${second.bookId}"]`)
    .getByRole('button', { name: `删除《${second.title}》` })
    .click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(
    page.locator(`[data-current-book-id="${second.bookId}"]`),
  ).toHaveCount(0)
  await expect
    .poll(
      async () =>
        (await request.get(`/v1/studio/books/${second.bookId}`)).status(),
    )
    .toBe(404)
})
test('timeout after committed create replays the same work, not a duplicate', async ({
  page,
  request,
}) => {
  let dropped = false
  await page.route('**/v1/studio/books', async (route) => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true
      await route.fetch()
      await route.abort('failed')
    } else await route.continue()
  })
  const before = (await (await request.get('/v1/studio/books')).json()).items.length
  await page.goto('/studio?view=read&compose=1')
  await expect(page.getByLabel('正文编辑器')).toBeVisible()
  await workMenu(page)
  await page.getByRole('menuitem', { name: '新建空白作品' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: '关闭提示' }).click()
  await workMenu(page, (await (await request.get('/v1/studio/books')).json()).items.at(-1).title)
  await page.getByRole('menuitem', { name: '新建空白作品' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(async () => (await (await request.get('/v1/studio/books')).json()).items.length)
    .toBe(before + 1)
})

test('mobile book and directory controls remain usable without horizontal overflow', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const b = await create(request)
  await open(page, b)
  await directory(page)
  await page.getByLabel('新建章节或卷').click()
  await page.getByRole('button', { name: '新卷', exact: true }).click()
  await expect(page.getByLabel('卷名称')).toBeVisible()
  await page.getByLabel('卷名称').fill('移动端合成卷')
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await expect(page.getByRole('heading', { name: '移动端合成卷' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await workMenu(page, b.title)
  await page.getByRole('menuitem', { name: /^全部作品/ }).click()
  await page
    .locator(`[data-book-card="${b.bookId}"]`)
    .getByRole('button', { name: `删除《${b.title}》` })
    .click()
  await expect(page.getByText(/此操作无法撤销/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/story2u-managed-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '取消', exact: true }).click()
})

test('work switcher matches its menu and closes when the outside is clicked', async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const first = await create(request, `切换作品-${suffix}`)
  const second = await create(request, `目标作品-${suffix}`)
  await open(page, first)
  const trigger = page.getByRole('button', {
    name: `当前作品：${first.title}，切换作品`,
  })
  await trigger.click()
  const menu = page.getByRole('menu', { name: '作品菜单' })
  await expect(menu).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-pressed', 'true')
  await expect(menu.getByLabel('搜索作品')).toBeFocused()
  await expect(menu).toContainText('最近编辑')
  if ((await menu.getByText(second.title, { exact: true }).count()) === 0) {
    await menu.getByLabel('搜索作品').fill(second.title)
  }
  await expect(menu.getByText(second.title, { exact: true })).toBeVisible()
  await expect(menu).toContainText('全部作品')
  await expect(menu).toContainText('新建空白作品')
  await expect(menu).toContainText('从 EPUB 导入')
  const menuBox = await menu.boundingBox()
  const viewport = page.viewportSize()!
  expect(menuBox).not.toBeNull()
  expect(menuBox!.width).toBeLessThanOrEqual(320)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.mouse.click(8, 120)
  await expect(menu).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-pressed', 'false')
})

test('all-works shelf can search and switch books, and mobile menu stays in view', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const first = await create(request)
  const second = await create(request)
  await open(page, first)

  const trigger = page.getByRole('button', {
    name: `当前作品：${first.title}，切换作品`,
  })
  await trigger.click()
  const menu = page.getByRole('menu', { name: '作品菜单' })
  const box = await menu.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)

  await menu.getByRole('menuitem', { name: /^全部作品/ }).click()
  const shelf = page.getByRole('dialog', { name: '全部作品' })
  await expect(shelf).toBeVisible()
  await shelf.getByLabel('搜索书架').fill(second.title)
  const matches = shelf.getByRole('button', {
    name: `打开《${second.title}》`,
  })
  await expect(matches.first()).toBeVisible()
  await matches.first().click()
  await expect(
    page.getByRole('button', {
      name: `当前作品：${second.title}，切换作品`,
    }),
  ).toBeVisible()
  await expect(shelf).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})
