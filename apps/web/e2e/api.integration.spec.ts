import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('real Harness chapter read, save, recovery, conflict safety, and Workspace preferences', async ({ browser }) => {
  const requestsA: string[] = []
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pageA = await contextA.newPage()
  let revisionPostsA = 0
  pageA.on('request', (request) => {
    requestsA.push(request.url())
    if (request.method() === 'POST' && request.url().includes('/revisions')) revisionPostsA++
  })

  await pageA.goto('/')
  await pageA.getByRole('button', { name: '目录与本章相关' }).click()
  const chapterOne = pageA.getByRole('button', { name: /第一章 · 雨前/ })
  const chapterTwo = pageA.getByRole('button', { name: /第二章 · 风起/ })
  await expect(chapterOne).toBeVisible()
  await expect(chapterTwo).toBeVisible()
  await expect(pageA.getByRole('heading', { name: '第一章 · 雨前' })).toBeVisible()
  const editorA = pageA.getByLabel('正文编辑器')
  await expect(editorA).toContainText('这是隔离测试夹具中的中文正文。')
  await expect(editorA).toContainText('这段引用用于检查 Markdown 原文读取。')
  expect(await pageA.evaluate(() => localStorage.getItem('writer-agent.v2'))).toBeNull()

  await chapterTwo.click()
  await expect(pageA.getByRole('heading', { name: '第二章 · 风起' })).toBeVisible()
  await expect(pageA.getByLabel('正文编辑器')).toContainText('第二个测试章节用于验证真实 API 目录顺序和切换加载。')
  await chapterOne.click()
  await expect(pageA.getByLabel('正文编辑器')).toContainText('这是隔离测试夹具中的中文正文。')

  const firstEdit = '作者新写的第一段中文。'
  await pageA.getByLabel('正文编辑器').fill(firstEdit)
  await pageA.keyboard.press('Control+S')
  await expect(pageA.getByText(/^已保存 /)).toBeVisible()
  await pageA.reload()
  await expect(pageA.getByLabel('正文编辑器')).toContainText(firstEdit)

  const themePatch = pageA.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/workspace') && response.ok() && response.request().postDataJSON()?.theme === 'dark')
  await pageA.getByRole('button', { name: '深色主题' }).click()
  await expect(pageA.locator('.dark')).toHaveCount(1)
  await themePatch
  const layoutPatch = pageA.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/workspace') && response.ok() && response.request().postDataJSON()?.layout?.focus === true)
  await pageA.getByRole('button', { name: '专注' }).click()
  await expect(pageA.getByRole('button', { name: '退出专注' })).toBeVisible()
  await layoutPatch
  await pageA.reload()
  await expect(pageA.locator('.dark')).toHaveCount(1)
  await expect(pageA.getByRole('button', { name: '退出专注' })).toBeVisible()

  const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pageB = await contextB.newPage()
  await pageB.goto('/')
  await expect(pageB.getByLabel('正文编辑器')).toContainText(firstEdit)

  const localText = '浏览器 A 的未保存中文草稿。'
  const serverText = '浏览器 B 已确认保存的中文版本。'
  await pageA.getByLabel('正文编辑器').fill(localText)
  await pageB.getByLabel('正文编辑器').fill(serverText)
  await pageB.keyboard.press('Control+S')
  await expect(pageB.getByText(/^已保存 /)).toBeVisible()
  await pageA.keyboard.press('Control+S')
  await expect(pageA.getByRole('alert').filter({ hasText: '检测到版本冲突' })).toBeVisible()
  await expect(pageA.getByLabel('正文编辑器')).toContainText(localText)
  await pageA.reload()
  await expect(pageA.getByText('有待恢复草稿', { exact: true })).toBeVisible()
  await pageA.getByRole('button', { name: '恢复本地草稿' }).click()
  await expect(pageA.getByLabel('正文编辑器')).toContainText(localText)
  await expect(pageA.getByText(`${localText.replace(/\s/g, '').length} 字`, { exact: true })).toBeVisible()
  await expect(pageA.getByText('版本冲突', { exact: true })).toBeVisible()

  const contextC = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pageC = await contextC.newPage()
  await pageC.goto('/')
  await expect(pageC.getByLabel('正文编辑器')).toContainText(serverText)
  expect(requestsA.some((url) => /\/api\/(agent|chapters|projects)/.test(url))).toBe(false)

  const [download] = await Promise.all([
    pageA.waitForEvent('download'),
    pageA.getByRole('button', { name: '导出本地草稿' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('CH-901-local-draft.md')
  const recoveryExport = await download.path()
  expect(recoveryExport).not.toBeNull()
  expect(await readFile(recoveryExport!, 'utf8')).toContain(localText)

  await pageA.getByRole('button', { name: '处理冲突' }).click()
  const conflictDialog = pageA.getByRole('dialog', { name: '保存冲突' })
  await conflictDialog.getByRole('button', { name: '查看服务器版本' }).click()
  await expect(conflictDialog).toContainText(serverText)
  await expect(conflictDialog).toContainText(localText)
  await conflictDialog.getByRole('button', { name: '使用服务器版本…' }).click()
  const confirm = pageA.getByRole('dialog')
  await expect(confirm).toContainText('清除该章节浏览器中尚未确认保存的本地草稿')
  await expect(confirm.getByRole('button', { name: '使用服务器版本' })).toBeDisabled()
  await confirm.getByRole('checkbox').check()
  await confirm.getByRole('button', { name: '使用服务器版本' }).click()
  await expect(pageA.getByLabel('正文编辑器')).toContainText(serverText)
  expect(await pageA.evaluate(() => localStorage.getItem('writer-agent.api-draft.v1:e2e-fixture:CH-901'))).toBeNull()

  const postCountBeforeQuotaFailure = revisionPostsA
  await pageA.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (this: Storage, key, value) {
      if (key.startsWith('writer-agent.api-draft.v1:')) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return originalSetItem.call(this, key, value)
    }
  })
  const volatileText = '本地存储空间不足时仍可导出的草稿。'
  await pageA.getByLabel('正文编辑器').fill(volatileText)
  await pageA.keyboard.press('Control+S')
  await expect(pageA.getByText('保存失败', { exact: true })).toBeVisible()
  await expect(pageA.getByRole('button', { name: '导出当前草稿' })).toBeVisible()
  const [volatileDownload] = await Promise.all([
    pageA.waitForEvent('download'),
    pageA.getByRole('button', { name: '导出当前草稿' }).click(),
  ])
  const volatileExport = await volatileDownload.path()
  expect(volatileExport).not.toBeNull()
  expect(await readFile(volatileExport!, 'utf8')).toContain(volatileText)
  expect(revisionPostsA).toBe(postCountBeforeQuotaFailure)
  expect(pageA.getByRole('button', { name: '重试保存' })).toBeVisible()

  await contextA.close()
  await contextB.close()
  await contextC.close()
})

test('API notes survive refresh, stay outside canon and protect concurrent edits', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const urls: string[] = []
  page.on('request', (request) => urls.push(request.url()))
  const harnessBefore = await readFile('e2e/fixtures/harness/manuscript/CH-901.md', 'utf8')
  await page.request.patch('/v1/projects/e2e-fixture/workspace', { data: { layout: { focus: false, leftOpen: false, rightOpen: false } } })
  await page.goto('/')
  await expect(page.getByLabel('正文编辑器')).toBeVisible()
  await page.getByRole('button', { name: '随手记', exact: true }).click()
  await page.getByLabel('随手记内容').fill('作者的真实 API 笔记')
  await page.getByRole('button', { name: '标为“下次要写”' }).click()
  await page.getByRole('button', { name: '记下', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '随手记' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('region', { name: '继续写作' })).toContainText('作者的真实 API 笔记')
  await page.getByRole('tab', { name: '书', exact: true }).click()
  await expect(page.getByText('尚未启用自动知识维护')).toBeVisible()
  await page.getByRole('button', { name: '创作笔记', exact: true }).click()
  const note = page.getByRole('button', { name: /作者的真实 API 笔记/ })
  await expect(note).toBeVisible()
  await note.click()
  await expect(page.getByLabel('笔记内容')).toHaveValue('作者的真实 API 笔记')
  await expect(page.getByLabel('关联章节')).toHaveValue('CH-901')
  await expect(page.getByRole('button', { name: /这是一个设定变更/ })).toBeDisabled()

  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await pageB.goto('/')
  await pageB.getByRole('tab', { name: '书', exact: true }).click()
  await pageB.getByRole('button', { name: '创作笔记', exact: true }).click()
  await pageB.getByRole('button', { name: /作者的真实 API 笔记/ }).click()
  await pageB.getByLabel('笔记内容').fill('另一个浏览器已更新的笔记')
  await pageB.getByRole('button', { name: '保存笔记修改' }).click()
  await expect(pageB.getByRole('status').filter({ hasText: '笔记已保存' })).toBeVisible()
  await page.getByLabel('笔记内容').fill('本窗口尚未确认的笔记输入')
  await page.getByRole('button', { name: '保存笔记修改' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '笔记已在其他位置更新' })).toBeVisible()
  await expect(page.getByLabel('笔记内容')).toHaveValue('本窗口尚未确认的笔记输入')
  await page.getByRole('button', { name: '重新读取笔记' }).click()
  await expect(page.getByRole('button', { name: /另一个浏览器已更新的笔记/ })).toBeVisible()
  await expect(page.getByLabel('笔记内容')).toHaveValue('本窗口尚未确认的笔记输入')
  await page.getByRole('button', { name: /另一个浏览器已更新的笔记/ }).click()
  await page.getByRole('button', { name: '放弃并打开' }).click()
  await page.getByRole('button', { name: '归档笔记' }).click()
  await expect(page.getByRole('status').filter({ hasText: '笔记已归档' })).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: '书', exact: true }).click()
  await page.getByRole('button', { name: '创作笔记', exact: true }).click()
  await page.getByRole('button', { name: '已归档', exact: true }).click()
  await expect(page.getByRole('button', { name: /另一个浏览器已更新的笔记/ })).toBeVisible()
  await page.getByRole('tab', { name: '思考', exact: true }).click()
  await expect(page.getByLabel('思考 Agent')).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('思考服务暂不可用')
  expect(urls.some((url) => /vnextData|vnextAgent|demoWriterAgent|demoData/.test(url))).toBe(false)
  expect(await readFile('e2e/fixtures/harness/manuscript/CH-901.md', 'utf8')).toBe(harnessBefore)
  await context.close(); await contextB.close()
})
