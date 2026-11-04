import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { createPiWorkerFixture, until } from '../../../scripts/lib/pi-worker-fixture.mjs'

const f = await createPiWorkerFixture({ modelBudget: { maxModelCalls: 10, maxTokens: 200000 } })
let vite, browser
try {
  const worker = f.start('pi-worker')
  await until(() => worker.output.includes('worker_started'), 'Worker ready')
  const book = await f.call('/v1/studio/books', { method: 'POST', status: 201, body: { operation: 'create', baseVersion: 0, title: '操作经验测试作品' } })
  const base = '/v1/studio/books/' + book.bookId
  await f.call(base + '/creative/settings/pause', { method: 'POST', body: {} })
  const settings = await f.call(base + '/knowledge')
  await f.call(base + '/knowledge/enable', { method: 'POST', body: { baseVersion: settings.version, consent: true, model: settings.model, dailyTokenBudget: 100000, dailyJobBudget: 3 } })
  const chapter = '/v1/projects/' + book.bookId + '/chapters/' + book.chapters[0].chapterId
  for (const markdown of ['林舟在北港等待。', '林舟在南港整理旧信。']) {
    const head = await f.call(chapter)
    const revision = await f.call(chapter + '/revisions', { method: 'POST', status: 201, body: { baseRevisionId: head.headRevision.revisionId, markdown } })
    await until(async () => (await f.call(base + '/knowledge/jobs')).items.some(job => job.revisionId === revision.revisionId && job.status === 'completed'), 'Knowledge completion')
  }
  await until(async () => (await f.call(base + '/procedural-memory/evidence')).items.length === 2, 'Task receipts')
  const net = createServer()
  await new Promise(resolve => net.listen(0, '127.0.0.1', resolve))
  const port = net.address().port
  await new Promise(resolve => net.close(resolve))
  const apiOrigin = f.api().output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)[1]
  const origin = `http://127.0.0.1:${port}`
  vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('..', import.meta.url), env: { ...process.env, VITE_WRITER_AGENT_MODE: 'api', VITE_WRITER_AGENT_AUTH: '', WRITER_AGENT_API_TARGET: apiOrigin }, stdio: 'ignore' })
  await until(async () => { if (vite.exitCode !== null) throw Error('Vite exited'); try { return (await fetch(origin)).ok } catch { return false } }, 'Vite ready', 30000)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.route('**/v1/**', route => { const request = route.request(); return route.continue({ headers: { ...request.headers(), authorization: 'Bearer ' + f.keys.bearer, ...f.identityHeaders(request.method(), request.url()) } }) })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(id => sessionStorage.setItem('writer-agent:selected-book', id), book.bookId)
  await page.goto(origin + '/studio')
  await page.getByRole('tab', { name: '书', exact: true }).click()
  await page.getByRole('navigation', { name: '书的分区' }).getByRole('button', { name: '操作经验' }).click()
  await expect(page.getByRole('checkbox')).toHaveCount(2)
  const evidence = (await f.call(base + '/procedural-memory/evidence')).items
  const preview = await f.call(base + '/procedural-memory/evidence/' + evidence[0].taskId)
  expect(preview.source.type).toBe('chapter')
  expect(['林舟在北港等待。', '林舟在南港整理旧信。']).toContain(preview.source.text)
  const callsBeforePreview = f.calls
  await page.getByRole('button', { name: `查看任务 ${evidence[0].taskId} 的原始来源`, exact: true }).click()
  await expect(page.getByRole('region', { name: '原始任务来源' }).getByText(preview.source.text, { exact: true })).toBeVisible()
  expect(f.calls).toBe(callsBeforePreview)
  const outcome = await f.call(base + '/procedural-memory/evidence/' + evidence[0].taskId + '/outcome')
  expect(outcome.basis).toBe('revision_observations')
  await page.getByRole('button', { name: '查看关联结果', exact: true }).click()
  const resultPanel = page.getByRole('region', { name: '任务关联结果', exact: true })
  await expect(resultPanel).toBeVisible()
  if (outcome.items.length) await expect(resultPanel.getByText(outcome.items[0].text, { exact: true })).toBeVisible()
  else await expect(resultPanel.getByText('未保留可展示的关联结果。')).toBeVisible()
  expect(f.calls).toBe(callsBeforePreview)
  const output = new URL('../../../.local/memory-ui/', import.meta.url)
  await mkdir(output, { recursive: true })
  await page.getByRole('region', { name: '原始任务来源' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: new URL('source-preview.png', output).pathname, fullPage: true })
  await page.getByRole('button', { name: `收起任务 ${evidence[0].taskId} 的原始来源`, exact: true }).click()
  for (const index of [0, 1]) {
    await page.getByRole('textbox', { name: '经验内容' }).fill('核对原文证据后，再整理人物观察。')
    await page.getByRole('checkbox').nth(index).check()
    await page.getByRole('button', { name: '保存候选' }).click()
    await expect(page.getByRole('article')).toHaveCount(index + 1)
    await expect(page.getByRole('textbox', { name: '经验内容' })).toHaveValue('')
  }
  for (const button of await page.getByRole('button', { name: '确认经验' }).all()) await expect(button).toBeDisabled()
  await page.getByRole('button', { name: '合并重复候选' }).click()
  await expect(page.getByText('重复候选已合并，仍需你确认后才供 AI 参考。')).toBeVisible()
  const merged = (await f.call(base + '/procedural-memory')).items
  expect(merged.filter(item => item.status === 'candidate')).toHaveLength(1)
  expect(merged.filter(item => item.status === 'rejected')).toHaveLength(1)
  expect(merged.every(item => !item.available)).toBe(true)
  const target = merged.find(item => item.status === 'candidate')
  expect(target.version).toBe(2)
  expect(new Set(target.provenance.map(source => source.taskId)).size).toBe(2)
  await page.getByRole('button', { name: '确认经验' }).click()
  await expect(page.getByText(/已确认 · 可供 AI 参考/)).toBeVisible()
  expect((await f.call(base + '/procedural-memory')).items.find(item => item.id === target.id).available).toBe(true)
  await page.getByRole('article').filter({ has: page.getByText(/^已撤回/) }).getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('article')).toHaveCount(1)
  await page.screenshot({ path: new URL('desktop.png', output).pathname, fullPage: true })
  await page.reload()
  await page.getByRole('navigation', { name: '书的分区' }).getByRole('button', { name: '操作经验' }).click()
  await expect(page.getByText(/已确认 · 可供 AI 参考/)).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('combobox', { name: '书的分区' })).toBeVisible()
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true)
  await page.screenshot({ path: new URL('mobile.png', output).pathname, fullPage: true })
  await page.getByRole('button', { name: '撤回', exact: true }).click()
  await expect(page.getByText(/^已撤回/)).toBeVisible()
  expect((await f.call(base + '/procedural-memory')).items[0].available).toBe(false)
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('还没有操作经验。')).toBeVisible()
  expect((await f.call(base + '/procedural-memory')).items).toEqual([])
  const pi=f.start('pi');await until(()=>pi.output.includes('agent_started'),'Thinking ready')
  await fetch(f.origin+'/control',{method:'POST',body:JSON.stringify({mode:'memory-extract'})})
  await page.getByRole('checkbox').nth(0).check()
  await page.getByRole('checkbox').nth(1).check()
  const callsBeforeExtraction=f.calls
  await page.getByRole('button',{name:'AI 提取经验',exact:true}).click()
  await expect(page.getByRole('button',{name:'同意发送并提取',exact:true})).toBeEnabled()
  expect(f.calls).toBe(callsBeforeExtraction)
  await page.getByRole('button',{name:'同意发送并提取',exact:true}).click()
  await expect(page.getByRole('button',{name:'保存提取候选',exact:true})).toBeVisible()
  expect(f.calls).toBe(callsBeforeExtraction+1)
  expect((await f.call(base+'/procedural-memory')).items).toEqual([])
  await page.getByRole('button',{name:'保存提取候选',exact:true}).click()
  await expect(page.getByRole('article')).toHaveCount(1)
  const extracted=(await f.call(base+'/procedural-memory')).items[0]
  expect(extracted.status).toBe('candidate');expect(extracted.available).toBe(false);expect(extracted.extractions[0].promptVersion).toBe('memory-extraction-v1');expect(extracted.provenance).toHaveLength(2)
  expect(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth)).toBe(true)
  await page.getByRole('region',{name:'AI 提取经验'}).scrollIntoViewIfNeeded()
  await page.screenshot({path:new URL('extraction-mobile.png',output).pathname,fullPage:true})
  await page.setViewportSize({width:1440,height:1000})
  await page.screenshot({path:new URL('extraction-desktop.png',output).pathname,fullPage:true})
  expect(errors).toEqual([])
  console.log('PASS: browser + Go + Pi Worker/Thinking, real task receipts, source/result previews, create/merge/review/reload/delete, governed model extraction with explicit disclosure and candidate import, desktop and mobile. Synthetic provider only.')
} finally {
  await browser?.close()
  if (vite && vite.exitCode === null) { const exited = new Promise(resolve => vite.once('exit', resolve)); vite.kill('SIGTERM'); await exited }
  await f.close()
}
