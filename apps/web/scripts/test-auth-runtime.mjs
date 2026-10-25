import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { makeSignature } from 'better-auth/crypto'
import { identityFixture } from '../../../scripts/lib/identity-fixture.mjs'
const identity = identityFixture()

const root = await mkdtemp(join(tmpdir(), 'writer-auth-runtime-'))
let mf
try {
  await mkdir(join(root, 'assets'))
  await writeFile(
    join(root, 'assets/index.html'),
    '<!doctype html><title>Isolated auth fixture</title>',
  )
  const built = spawnSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'deploy',
      '--dry-run',
      '--assets',
      join(root, 'assets'),
      '--outdir',
      join(root, 'bundle'),
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  )
  assert.equal(built.status, 0)
  const origin = 'https://writer.example'
  const secret = 'isolated-workerd-auth-secret-no-production-credentials'
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: join(root, 'bundle'),
      scriptPath: join(root, 'bundle/index.js'),
      compatibilityDate: '2026-10-17',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { AUTH_DB: 'isolated-auth-db' },
      bindings: {
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: secret,
        GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'fixture',
        WRITER_AGENT_IDENTITY_PRIVATE_KEY: identity.privateKey,
        WRITER_AGENT_PROJECT_ID: 'local',
        WRITER_AGENT_API_TOKEN: 'fixture',
        WRITER_AGENT_API_ORIGIN: 'https://api.example',
      },
      outboundService: async (request) => {
        assert.equal(new URL(request.url).origin, 'https://api.example')
        if (new URL(request.url).pathname === '/v1/public/home') {
          assert.equal(request.headers.has('authorization'), false)
          assert.equal(request.headers.has('cookie'), false)
          return Response.json({
            items: [],
            total: 0,
            featured: null,
            opening: null,
            categories: [],
          })
        }
        assert.equal(request.headers.get('authorization'), 'Bearer fixture')
        assert.equal(request.headers.has('cookie'), false)
        // Every forwarded call names the signed-in user with a Worker-signed assertion.
        assert.match(request.headers.get('x-writer-agent-identity') ?? '', /^[\w-]+\.[\w-]+\.[\w-]+$/)
        return Response.json({ fixture: 'authenticated-upstream' }, { headers: { 'x-writer-agent-identity-mode': 'per-user-v1' } })
      },
      serviceBindings: {
        ASSETS: () =>
          new Response(
            '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
            { headers: { 'content-type': 'text/html' } },
          ),
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
  for (const method of ['GET','HEAD']) {
    const canonical = await mf.dispatchFetch('https://story2u.xyz/discover?q=route-check', {method, redirect:'manual'})
    assert.equal(canonical.status,308)
    assert.equal(canonical.headers.get('location'),origin+'/discover?q=route-check')
  }
  let response = await mf.dispatchFetch(origin + '/')
  assert.equal(response.status, 200)
  const publicHTML = await response.text()
  assert.match(publicHTML, /第一部故事/)
  assert.match(publicHTML, /story2u-data/)
  assert.match(publicHTML, /rel="canonical"/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  response = await mf.dispatchFetch(origin + '/books/synthetic/chapters/CH-002')
  assert.equal(response.status, 404)
  for (const path of [
    '/missing',
    '/missing.js',
    '/studio/missing',
    '/assets/missing.js',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const missing = await mf.dispatchFetch(origin + path, { method })
      assert.equal(missing.status, 404)
      assert.equal(missing.headers.get('x-robots-tag'), 'noindex')
      if (method === 'HEAD') assert.equal(await missing.text(), '')
    }
  }
  response = await mf.dispatchFetch(origin + '/v1/public/unknown')
  assert.equal(response.status, 404)
  response = await mf.dispatchFetch(
    origin + '/v1/studio/books/local/publication',
  )
  assert.equal(response.status, 401)
  response = await mf.dispatchFetch(origin + '/api/session')
  if (response.status !== 401) console.error(await response.clone().text())
  assert.equal(response.status, 401)
  response = await mf.dispatchFetch(origin + '/api/auth/sign-in/social', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: '{"provider":"google","callbackURL":"/"}',
  })
  assert.equal(response.status, 200)
  const { url } = await response.json()
  assert.equal(
    new URL(url).searchParams.get('redirect_uri'),
    origin + '/api/auth/google/callback',
  )
  assert.match(response.headers.get('set-cookie'), /HttpOnly/)
  const now = Date.now()
  await db
    .prepare(
      'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    )
    .bind('fixture-author', 'Author', 'author@example.com', 1, now, now)
    .run()
  const token = 'isolated-session-not-a-real-token'
  await db
    .prepare(
      'INSERT INTO session (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    )
    .bind('fixture-session', token, 'fixture-author', now + 3600000, now, now)
    .run()
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(token + '.' + (await makeSignature(token, secret)))}`
  response = await mf.dispatchFetch(origin + '/api/session', {
    headers: { cookie },
  })
  assert.equal(response.status, 200)
  const sessionBody = await response.json()
  assert.match(sessionBody.user.scope, /^[A-Za-z0-9_-]{22}$/)
  assert.deepEqual(sessionBody, {
    user: { name: 'Author', email: 'author@example.com', scope: sessionBody.user.scope },
    projectId: 'local',
  })
  response = await mf.dispatchFetch(origin + '/v1/projects/local/workspace', {
    headers: { cookie },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    fixture: 'authenticated-upstream',
  })
  response = await mf.dispatchFetch(
    origin + '/v1/studio/books/local/publication',
    { headers: { cookie } },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    fixture: 'authenticated-upstream',
  })
  response = await mf.dispatchFetch(
    origin + '/v1/studio/books/other/publication',
    { headers: { cookie } },
  )
  assert.equal(response.status, 404)
  response = await mf.dispatchFetch(
    origin + '/v1/studio/books/local/publication/versions',
    {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      },
      body: '{}',
    },
  )
  assert.equal(response.status, 403)
  response = await mf.dispatchFetch(origin + '/api/auth/sign-out', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 200)
  assert.equal(
    (await mf.dispatchFetch(origin + '/api/session', { headers: { cookie } }))
      .status,
    401,
  )
  console.log(
    'Real workerd + D1: Google OAuth initiation, signed sessions and logout passed. No external provider or manuscript requests.',
  )
} finally {
  await mf?.dispose()
  await rm(root, { recursive: true, force: true })
}
