import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const canonical = 'https://www.story2u.xyz'
async function verify() {
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch('https://story2u.xyz/discover?q=route-check', {
      method, redirect: 'manual', signal: AbortSignal.timeout(15000),
    })
    assert.equal(response.status, 308, 'HTTPS apex must redirect at the edge')
    assert.equal(response.headers.get('location'), canonical + '/discover?q=route-check')
    // Cloudflare may upgrade HTTP before the Worker runs; follow that upgrade.
    const http = await fetch('http://story2u.xyz/discover?q=route-check', {
      method, redirect: 'follow', signal: AbortSignal.timeout(15000),
    })
    assert.equal(http.status, 200)
    assert.equal(http.url, canonical + '/discover?q=route-check')
  }
  const home = await fetch(canonical, { redirect: 'error', signal: AbortSignal.timeout(15000) })
  assert.equal(home.status, 200)
  assert.ok((await home.text()).includes('story2u-data'), 'Canonical home must be SSR HTML')
  const missing = await fetch(canonical + '/missing', { redirect: 'error', signal: AbortSignal.timeout(15000) })
  assert.equal(missing.status, 404)
  const api = await fetch('https://api.story2u.xyz/healthz', { redirect: 'error', signal: AbortSignal.timeout(15000) })
  assert.equal(api.status, 200, 'API subdomain must remain independent')
}
// A route can take a short time to propagate after the deployment completes.
for (let attempt = 0; ; attempt++) {
  try {
    await verify()
    console.log('Apex HTTP/HTTPS GET/HEAD redirect, canonical SSR/404 and API health passed.')
    break
  } catch (error) {
    if (attempt === 5) throw error
    console.log('Waiting for canonical routes to propagate...')
    await delay(5000)
  }
}
