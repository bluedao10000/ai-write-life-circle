import { expect, test } from '@playwright/test'
import type { ManagedBook } from '@writer-agent/contracts'

// Scenario A (author-direct) and D in the browser: build settings for a book
// with no prose, write in compose mode, and keep everything after reload.
test('build settings before any prose, write in compose mode, and keep both', async ({ page, request }) => {
  const created = await request.post('/v1/studio/books', { headers: { 'idempotency-key': crypto.randomUUID() }, data: { operation: 'create', baseVersion: 0, title: '从零开始的书' } })
  expect(created.status()).toBe(201)
  const book = (await created.json()) as ManagedBook
  await page.addInitScript((id) => sessionStorage.setItem('writer-agent:selected-book', id), book.bookId)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // 灵感 is the default space.
  await page.goto('/studio')
  await expect(page.getByRole('tab', { name: '灵感' })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('tab', { name: '书', exact: true }).click()
  await page.getByRole('button', { name: '人物设定', exact: true }).click()
  await page.getByRole('button', { name: '新建人物' }).click()
  await page.getByRole('textbox', { name: '设定名称' }).fill('林舟')
  await page.getByRole('textbox', { name: '概述' }).fill('北港灯塔的年轻看守人。')
  await page.getByRole('textbox', { name: '属性名 1' }).fill('动机')
  await page.getByRole('textbox', { name: '属性值 1' }).fill('查清父亲出海的真相')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const detail = page.getByRole('article', { name: '设定：林舟' })
  await expect(detail).toContainText('已确认')
  await expect(detail).toContainText('版本 1')
  await detail.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByRole('textbox', { name: '概述' }).fill('北港灯塔的年轻看守人，怕水。')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(detail).toContainText('版本 2')
  await expect(detail.getByText('你修改')).toBeVisible()

  // A plan anchored to chapter one: an intention, shown beside the manuscript.
  await page.getByRole('button', { name: '剧情规划', exact: true }).click()
  await page.getByRole('button', { name: '新建剧情线' }).click()
  await page.getByRole('combobox', { name: '设定类型' }).selectOption('event')
  await page.getByRole('textbox', { name: '设定名称' }).fill('林舟背叛守塔会')
  await page.getByRole('combobox', { name: '计划章节' }).selectOption(book.chapters[0].chapterId)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('计划不等于正文已发生')).toBeVisible()

  await page.getByRole('tab', { name: '阅读', exact: true }).click()
  const editor = page.getByLabel('正文编辑器')
  await expect(editor).toHaveAttribute('contenteditable', 'false')
  await page.getByRole('button', { name: '本章设定' }).click()
  await expect(page.getByRole('complementary', { name: '本章设定' })).toContainText('林舟背叛守塔会')
  await page.getByRole('button', { name: '关闭本章设定' }).click()
  await page.getByRole('button', { name: '进入创作' }).click()
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await editor.click()
  await page.keyboard.type('天亮时，他最终选择留下。')
  await expect(page.getByRole('toolbar', { name: '创作工具栏' })).toContainText('本次')
  await expect(page.getByText(/^已保存 /)).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: '完成创作' }).click()
  await expect(editor).toHaveAttribute('contenteditable', 'false')

  // Reload keeps the space, the prose and the settings; back returns to 书.
  await page.reload()
  await expect(page.getByRole('tab', { name: '阅读' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('正文编辑器')).toContainText('他最终选择留下')
  // Back walks the space history: compose, then reading, then 书.
  await page.goBack()
  await expect(page).toHaveURL(/view=read&compose=1/)
  await expect(page.getByLabel('正文编辑器')).toHaveAttribute('contenteditable', 'true')
  await page.goBack()
  await page.goBack()
  await expect(page).toHaveURL(/view=book/)
  await expect(page.getByRole('button', { name: '剧情规划', exact: true })).toBeVisible()
  const assets = await (await request.get(`/v1/studio/books/${book.bookId}/creative/assets`)).json()
  expect(assets.total).toBe(2)
  const plan = assets.items.find((a: { kind: string }) => a.kind === 'event')
  expect(plan.version).toBe(1)
  expect(errors).toEqual([])
})
