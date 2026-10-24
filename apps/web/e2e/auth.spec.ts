import { test, expect } from '@playwright/test'

test('Google login uses the same-origin auth endpoint before loading any manuscript', async ({ page }) => {
  const errors: string[] = []
  const manuscriptRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.url().includes('/v1/')) manuscriptRequests.push(request.url()) })
  await page.route('**/api/session', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"SESSION_REQUIRED"}' }))
  await page.route('**/api/auth/sign-in/social', async route => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toMatchObject({ provider: 'google', callbackURL: '/', errorCallbackURL: '/?login=failed' })
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"url":"https://accounts.google.com/o/oauth2/v2/auth?state=fixture","redirect":true}' })
  })
  await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Isolated Google authorization fixture</h1>' }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '回到你的写作工作台' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '正文编辑器' })).toHaveCount(0)
  await page.getByRole('button', { name: '使用 Google 登录' }).click()
  await expect(page).toHaveURL(/accounts\.google\.com/)
  expect(manuscriptRequests).toEqual([])
  expect(errors).toEqual([])
})
