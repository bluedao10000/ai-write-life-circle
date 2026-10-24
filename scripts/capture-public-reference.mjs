// Developer-only visual evidence. Reads the author-provided latest Make export;
// never imports its Demo store into the production app or modifies the export.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
const require = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
)
const exportRoot = process.argv[2]
if (!exportRoot)
  throw Error('Pass the directory of the current Figma Make export.')
const { createServer } = await import(pathToFileURL(require.resolve('vite')))
const react = (
  await import(pathToFileURL(require.resolve('@vitejs/plugin-react')))
).default
const tailwind = (
  await import(pathToFileURL(require.resolve('@tailwindcss/vite')))
).default
const { chromium } = require('@playwright/test')
const server = await createServer({
  root: resolve(exportRoot),cacheDir:new URL('../apps/web/node_modules/.vite-figma-reference',import.meta.url).pathname,
  configFile: false,
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      ...Object.fromEntries(
        ['core', 'react', 'starter-kit', 'pm'].map((name) => [
          '@tiptap/' + name,
          new URL('../apps/web/node_modules/@tiptap/' + name, import.meta.url)
            .pathname,
        ]),
      ),
      react: dirname(require.resolve('react/package.json')),
      'react-dom': dirname(require.resolve('react-dom/package.json')),
      tailwindcss: require.resolve('tailwindcss/index.css'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    fs: { allow: [resolve(exportRoot), resolve('node_modules')] },
  },
})
const browser = await chromium.launch()
try {
  await server.listen()
  const page = await browser.newPage()
  await page.route('**/fonts.googleapis.com/**', (r) => r.abort())
  await page.route('**/fonts.gstatic.com/**', (r) => r.abort())
  const dir = new URL('../apps/web/test-results-reference/', import.meta.url)
    .pathname
  await mkdir(dir, { recursive: true })
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('http://127.0.0.1:5188/')
    await page.getByRole('heading', { name: '雾港来信', exact: true }).waitFor()
    await page.screenshot({
      path: resolve(dir, `home-${width}.png`),
      fullPage: true,
    })
    await page.goto('http://127.0.0.1:5188/#/books/letters-from-the-fog-harbor')
    await page.getByRole('heading', { name: '雾港来信', exact: true }).waitFor()
    await page.screenshot({
      path: resolve(dir, `book-${width}.png`),
      fullPage: true,
    })
    await page.goto(
      'http://127.0.0.1:5188/#/books/letters-from-the-fog-harbor/chapters/1',
    )
    await page
      .getByRole('heading', { name: '十月十七日', exact: true })
      .waitFor()
    await page.screenshot({
      path: resolve(dir, `reader-${width}.png`),
      fullPage: true,
    })
  }
  console.log('Latest exported Make visual references saved to ' + dir)
} finally {
  await browser.close()
  await server.close()
}
