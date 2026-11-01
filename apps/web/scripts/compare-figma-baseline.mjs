/* global document, Image, OffscreenCanvas, ImageData */
// Baseline (Figma Make prototype) vs implementation: screenshots, overlay,
// pixel diff and landmark bounding boxes for each scene and viewport.
//
// Usage (both apps already running; see harness/design/figma-v3-sync-report.md):
//   FIGMA=http://127.0.0.1:8443/#/studio OURS=http://127.0.0.1:5199/studio \
//   VIEWPORTS=1440x900 SCENES=book,inbox node scripts/compare-figma-baseline.mjs
// 灵感 scenes (idea, idea-thread, idea-models, idea-drawer) send the regression
// question; run OURS against the synthetic inspiration stack
// (INSPIRATION_VISUAL replies: node e2e/start-inspiration-stack.mjs) at
// OURS=http://127.0.0.1:5191/studio?view=inspire, never against production.
// Writes <scene>-<viewport>-{figma,ours,diff,overlay}.png and report.json to $OUT.
// Pixel diff: a pixel counts as changed when |ΔR|+|ΔG|+|ΔB| > 48.
// Content differs between the prototype's demo work and real data, so the
// landmark boxes (header, nav, asides, inputs, named buttons) are the layout signal.
import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const OUT = process.env.OUT ?? 'test-results-figma'
mkdirSync(OUT, { recursive: true })
const apps = {
  figma: process.env.FIGMA ?? 'http://127.0.0.1:8443/#/studio',
  ours: process.env.OURS ?? 'http://127.0.0.1:5199/studio',
}
const viewports = (process.env.VIEWPORTS ?? '1920x1080,1440x900,1280x800,768x1024,390x844,375x667').split(',').map((v) => v.split('x').map(Number))
const only = process.env.SCENES?.split(',')

const tab = (name) => async (page) => {
  const t = page.getByRole('tab', { name, exact: true }).first()
  if (await t.isVisible().catch(() => false)) return t.click()
  // narrow layouts may hide the main tabs behind a menu
  await page.getByRole('button', { name, exact: true }).first().click()
}
const QUESTION = '我想讨论一个问题，什么样的人品才是真正的好人品。我想以明朝的张居正为原型，写一部背景是平行宇宙的科幻小说。'
const ask = async (page) => {
  await page.getByRole('textbox', { name: '说说你正在思考的问题' }).fill(QUESTION)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByText('判断的标准由你来定').first().waitFor({ timeout: 25000 })
  await page.waitForTimeout(1500)
}
const scenes = {
  idea: async () => {},
  'idea-thread': ask,
  'idea-models': async (page) => {
    await ask(page)
    await page.getByRole('button', { name: /^选择回复模型/ }).click()
  },
  'idea-drawer': async (page) => {
    if (page.viewportSize().width < 768) await page.getByRole('button', { name: '历史会话与导航', exact: true }).click()
    else await page.getByRole('button', { name: '收起历史会话', exact: true }).click()
  },
  read: tab('阅读'),
  write: async (page) => {
    await tab('阅读')(page)
    await page.waitForTimeout(600)
    const skip = page.getByRole('button', { name: '直接进入正文' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
    await page.locator('button[title^="沉浸式写作"]').first().click()
  },
  book: tab('书'),
  'book-drawer': async (page) => {
    await tab('书')(page)
    await page.waitForTimeout(800)
    await page.locator('main li button, main ul > li [role=button], main button.block').first().click()
  },
  inbox: async (page) => {
    await tab('书')(page)
    await page.waitForTimeout(600)
    if (page.viewportSize().width < 768) await page.locator('main header button').filter({ hasText: /^人物/ }).first().click()
    await page.getByRole('button', { name: /^待确认/ }).first().click()
  },
}

// Landmarks measured in both apps, matched by key.
const landmarkScript = () => {
  const out = {}
  const put = (key, el) => {
    if (!el || out[key]) return
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    out[key] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
  }
  put('header', document.querySelector('body header'))
  put('mainNav', document.querySelector('[role=tablist]'))
  for (const t of document.querySelectorAll('[role=tab]')) put('tab:' + t.textContent.trim().replace(/\s*\d+$/, ''), t)
  for (const a of document.querySelectorAll('aside')) put('aside:' + (a.getAttribute('aria-label') || '?'), a)
  for (const m of document.querySelectorAll('main')) put('main', m)
  for (const m of document.querySelectorAll('h1')) put('h1', m)
  for (const m of document.querySelectorAll('nav[aria-label="书的分区"], aside[aria-label="书的分类"]')) put('bookNav', m)
  put('textarea', document.querySelector('textarea'))
  put('editor', document.querySelector('.ProseMirror'))
  const named = ['新话题', '发送', '写作', '去灵感', '本章设定', '注记', '添加人物', '回到阅读', '收起整理面板']
  for (const b of document.querySelectorAll('button')) {
    const n = (b.textContent || '').trim().replace(/\s*\d+$/, '')
    if (named.includes(n)) put('btn:' + n, b)
  }
  for (const s of document.querySelectorAll('input[placeholder]')) put('input:' + s.getAttribute('placeholder').slice(0, 8), s)
  // 灵感: icon buttons are matched by their accessible name.
  for (const b of document.querySelectorAll('button[aria-label]')) {
    const n = b.getAttribute('aria-label')
    if (['发送', '停止回复', '更多', '新对话', '历史会话与导航', '收起历史会话', '展开历史会话'].includes(n)) put('btn:' + n, b)
    if (n.startsWith('选择回复模型')) put('modelPicker', b)
  }
  for (const t of document.querySelectorAll('textarea[aria-label="说说你正在思考的问题"]')) put('composer', t.closest('.vt-composer'))
  put('history', document.querySelector('nav[aria-label="历史会话"]'))
  put('reply', document.querySelector('article[aria-label="创作伙伴的回复"]'))
  put('modelMenu', document.querySelector('[aria-label="选择回复模型"][role=group], [aria-label="选择回复模型"][role=dialog] > div'))
  return out
}

async function capture(browser, app, scene, [w, h]) {
  const mobile = w < 768
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, locale: 'zh-CN' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(apps[app])
  await page.waitForTimeout(1800)
  try {
    await scenes[scene](page)
  } catch (e) {
    errors.push('scene: ' + e.message.split('\n')[0])
  }
  await page.waitForTimeout(1200)
  await page.mouse.move(1, h - 1)
  const file = `${OUT}/${scene}-${w}x${h}-${app}.png`
  await page.screenshot({ path: file })
  const boxes = await page.evaluate(landmarkScript)
  await context.close()
  return { file, boxes, errors }
}

async function diff(browser, a, b, [w, h], name) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const url = (f) => 'data:image/png;base64,' + readFileSync(f).toString('base64')
  const res = await page.evaluate(async ({ a, b, w, h }) => {
    const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const c = (img) => { const cv = new OffscreenCanvas(w, h); const x = cv.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h) }
    const da = c(ia), db = c(ib)
    const out = new ImageData(w, h)
    let changed = 0
    for (let i = 0; i < da.data.length; i += 4) {
      const d = Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1]) + Math.abs(da.data[i + 2] - db.data[i + 2])
      const g = (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 3
      if (d > 48) { changed++; out.data.set([255, 40, 60, 255], i) } else out.data.set([g, g, g, 70], i)
    }
    const dc = new OffscreenCanvas(w, h); dc.getContext('2d').putImageData(out, 0, 0)
    const oc = new OffscreenCanvas(w, h); const ox = oc.getContext('2d'); ox.drawImage(ia, 0, 0); ox.globalAlpha = 0.5; ox.drawImage(ib, 0, 0)
    const toUrl = async (cv) => { const blob = await cv.convertToBlob(); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const x of buf) s += String.fromCharCode(x); return btoa(s) }
    return { ratio: changed / (w * h), diff: await toUrl(dc), overlay: await toUrl(oc) }
  }, { a: url(a), b: url(b), w, h })
  writeFileSync(`${OUT}/${name}-diff.png`, Buffer.from(res.diff, 'base64'))
  writeFileSync(`${OUT}/${name}-overlay.png`, Buffer.from(res.overlay, 'base64'))
  await page.close()
  return res.ratio
}

const browser = await chromium.launch()
const report = []
for (const vp of viewports) {
  for (const scene of Object.keys(scenes)) {
    if (only && !only.includes(scene)) continue
    const f = await capture(browser, 'figma', scene, vp)
    const o = await capture(browser, 'ours', scene, vp)
    const name = `${scene}-${vp[0]}x${vp[1]}`
    const ratio = await diff(browser, f.file, o.file, vp, name)
    const keys = [...new Set([...Object.keys(f.boxes), ...Object.keys(o.boxes)])]
    const boxes = {}
    for (const k of keys) {
      const a = f.boxes[k], b = o.boxes[k]
      boxes[k] = a && b ? { figma: a, ours: b, delta: a.map((v, i) => b[i] - v), max: Math.max(...a.map((v, i) => Math.abs(b[i] - v))) } : { figma: a ?? null, ours: b ?? null }
    }
    report.push({ scene, viewport: vp.join('x'), pixelDiff: +(ratio * 100).toFixed(2), boxes, errors: { figma: f.errors, ours: o.errors } })
    console.log(name, (ratio * 100).toFixed(2) + '%', f.errors.concat(o.errors).join(' | '))
  }
}
await browser.close()
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1))
