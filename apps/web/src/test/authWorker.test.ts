// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSignature } from 'better-auth/crypto'
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto'
import { createAuth, verifiedGoogleUser, type Env } from '../../worker/auth'
import worker, { handleRequest } from '../../worker/index'
const identityKeys = generateKeyPairSync('ed25519')
const identityPrivate = identityKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
/** Every per-user Go response advertises its identity mode; wrap mocks to model that API. */
function stubAPI(upstream: (...args: never[]) => unknown) {
  vi.stubGlobal('fetch', async (...args: unknown[]) => {
    const response = await (upstream as (...a: unknown[]) => Promise<Response | undefined>)(...args)
    if (!(response instanceof Response)) return response
    const headers = new Headers(response.headers)
    headers.set('x-writer-agent-identity-mode', 'per-user-v1')
    return new Response(response.body, { status: response.status, headers })
  })
}
function decodeAssertion(token: string | null) {
  const [head, body, signature] = (token ?? '').split('.')
  const ok = verifySignature(null, Buffer.from(`${head}.${body}`), identityKeys.publicKey, Buffer.from(signature, 'base64url'))
  return { ok, claims: JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown> }
}

const origin = 'https://writer.example'
let db: DatabaseSync
let env: Env
let cookie: string
let sessionToken: string
let signedUserId: string

async function signIn(email = 'author@example.com', verified = true, expires = Date.now() + 3600_000) {
  const auth = createAuth(env)
  await auth.options.user.validateUserInfo({ user: { name: 'Author', email, emailVerified: verified }, source: { action: 'create-user', method: 'oauth', oauth: { providerId: 'google' } } })
  const userId = crypto.randomUUID().replace(/-/g, '')
  signedUserId = userId
  const token = crypto.randomUUID()
  const now = Date.now()
  db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run(userId, 'Author', email, verified ? 1 : 0, now, now)
  db.prepare('INSERT INTO session (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), token, userId, expires, now, now)
  sessionToken = token
  cookie = `__Secure-better-auth.session_token=${encodeURIComponent(token + '.' + await makeSignature(token, env.BETTER_AUTH_SECRET))}`
}

function request(path: string, method = 'GET', body?: string, headers: Record<string, string> = {}) {
  return new Request(origin + path, { method, headers: { cookie, ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...headers }, body })
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../../migrations/0001_better_auth.sql', import.meta.url), 'utf8'))
  env = {
    AUTH_DB: db as unknown as Env['AUTH_DB'],
    ASSETS: { fetch: vi.fn(async () => new Response('static')) } as unknown as Env['ASSETS'],
    BETTER_AUTH_SECRET: 'fixture-only-secret-with-more-than-32-characters', BETTER_AUTH_URL: origin,
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    WRITER_AGENT_IDENTITY_PRIVATE_KEY: identityPrivate,
    WRITER_AGENT_API_TOKEN: 'fixture-backend-bearer', WRITER_AGENT_API_ORIGIN: 'https://api.example', WRITER_AGENT_PROJECT_ID: 'local',
  }
  cookie = ''
})
afterEach(() => { vi.unstubAllGlobals(); db.close() })

describe('Better Auth sessions and single-project authorization', () => {
  it('fails closed without configuration and never proxies an anonymous request', async () => {
    const upstream = vi.fn(); stubAPI(upstream)
    expect((await handleRequest(request('/v1/projects/local/workspace'), { ...env, BETTER_AUTH_SECRET: '' })).status).toBe(503)
    expect((await handleRequest(request('/v1/projects/local/workspace'), env)).status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })
  it('admits any verified Google account and blocks unverified addresses', async () => {
    expect(verifiedGoogleUser({ email: 'stranger@example.com', emailVerified: true })).toBe(true)
    await expect(signIn('author@example.com', false)).rejects.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM user').get()?.count).toBe(0)
    await signIn('stranger@example.com')
    expect((await handleRequest(request('/api/session'), env)).status).toBe(200)
    // Returning OAuth accounts must also pass the fresh provider profile.
    await expect(createAuth(env).options.user.validateUserInfo({ user: { email: 'stranger@example.com', emailVerified: false }, source: { action: 'sign-in', method: 'oauth', oauth: { providerId: 'google' } } })).rejects.toThrow()
  })
  it('checks a real signed database session, omits tokens, and rejects forged, expired and revoked sessions', async () => {
    await signIn()
    const response = await handleRequest(request('/api/session'), env)
    const body = await response.json() as { user: { scope: string } }
    expect(body).toEqual({ user: { name: 'Author', email: 'author@example.com', scope: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) }, projectId: 'local' })
    // The storage scope is stable per user and does not reveal the user ID.
    expect(body.user.scope).not.toContain(signedUserId)
    expect((await (await handleRequest(request('/api/session'), env)).json() as typeof body).user.scope).toBe(body.user.scope)
    cookie += 'forged'
    expect((await handleRequest(request('/api/session'), env)).status).toBe(401)
    cookie = `__Secure-better-auth.session_token=${encodeURIComponent(sessionToken + '.' + await makeSignature(sessionToken, env.BETTER_AUTH_SECRET))}`
    db.prepare('UPDATE session SET expiresAt = ?').run(Date.now() - 1000)
    expect((await handleRequest(request('/api/session'), env)).status).toBe(401)
  })
  it('revokes a real session on sign-out', async () => {
    await signIn()
    const response = await handleRequest(request('/api/auth/sign-out', 'POST', '{}'), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await handleRequest(request('/api/session'), env)).status).toBe(401)
  })
  it('starts Google OAuth with a fixed callback, state cookie, and rejects unsolicited callbacks', async () => {
    const response = await handleRequest(request('/api/auth/sign-in/social', 'POST', JSON.stringify({ provider: 'google', callbackURL: '/' })), env)
    expect(response.status).toBe(200)
    const body = await response.json() as { url: string }
    const target = new URL(body.url)
    expect(target.origin).toBe('https://accounts.google.com')
    expect(target.searchParams.get('redirect_uri')).toBe(origin + '/api/auth/google/callback')
    expect(target.searchParams.get('state')).toBeTruthy()
    expect(target.searchParams.get('code_challenge')).toBeTruthy()
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(response.headers.get('set-cookie')).toMatch(/Secure/i)
    const callback = await handleRequest(request('/api/auth/google/callback?code=unsolicited&state=invalid'), env)
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toContain('error=')
    expect(db.prepare('SELECT COUNT(*) AS count FROM session').get()?.count).toBe(0)
    // The code exchange must use the same custom URI even after routing through Better Auth's internal callback.
    const exchange = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new URLSearchParams(init?.body as string).get('redirect_uri')).toBe(origin + '/api/auth/google/callback')
      return Response.json({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600 })
    })
    vi.stubGlobal('fetch', exchange)
    const context = await createAuth(env).$context
    const provider = context.socialProviders.find(item => item.id === 'google')!
    await provider.validateAuthorizationCode({ code: 'fixture-code', codeVerifier: 'fixture-verifier', redirectURI: origin + '/api/auth/callback/google' })
    expect(exchange).toHaveBeenCalledTimes(1)
  })
  it('rejects external OAuth return URLs and cross-site mutations before processing them', async () => {
    expect((await handleRequest(request('/api/auth/sign-in/social', 'POST', '{"provider":"google","callbackURL":"https://evil.example"}'), env)).status).toBe(403)
    await signIn()
    const upstream = vi.fn(); stubAPI(upstream)
    expect((await handleRequest(request('/v1/projects/local/notes', 'POST', '{}', { origin: 'https://evil.example' }), env)).status).toBe(403)
    expect((await handleRequest(request('/v1/projects/local/notes', 'POST', '{}', { 'content-type': 'text/plain' }), env)).status).toBe(415)
    expect(upstream).not.toHaveBeenCalled()
  })
  it('forwards only approved routes and headers; preserves CAS conflicts and idempotency', async () => {
    await signIn()
    const upstream = vi.fn(async () => new Response('{"code":"REVISION_CONFLICT"}', { status: 409, headers: { 'content-type': 'application/problem+json', 'set-cookie': 'backend-secret=bad', 'access-control-allow-origin': '*' } }))
    stubAPI(upstream)
    const response = await handleRequest(request('/v1/projects/local/chapters/CH-001/revisions', 'POST', '{}', { 'Idempotency-Key': 'retry-key', authorization: 'Bearer attacker', 'x-actor-id': 'attacker' }), env)
    expect(response.status).toBe(409)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    const [target, options] = upstream.mock.calls[0] as unknown as [URL, RequestInit]
    expect(target.href).toBe('https://api.example/v1/projects/local/chapters/CH-001/revisions')
    const headers = new Headers(options.headers)
    expect(headers.get('authorization')).toBe('Bearer fixture-backend-bearer')
    expect(headers.get('idempotency-key')).toBe('retry-key')
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('x-actor-id')).toBe(false)
    for (const path of ['/v1/projects/other/workspace', '/v1/projects/local/chapters/a%2fb', '/v1/projects/local/chapters/a%252fb', '/v1/projects/local/internal']) {
      expect((await handleRequest(request(path), env)).status).toBe(404)
    }
    expect(upstream).toHaveBeenCalledTimes(1)
  })
  it('never follows backend redirects or exposes network errors, and leaves assets accessible', async () => {
    await signIn()
    const upstream = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://evil.example' } }))
    stubAPI(upstream)
    expect((await worker.fetch(request('/v1/projects/local/workspace'), env)).status).toBe(502)
    upstream.mockRejectedValueOnce(new Error('private backend details'))
    const response = await worker.fetch(request('/v1/projects/local/workspace'), env)
    expect(await response.text()).not.toContain('private backend details')
    expect(await (await worker.fetch(request('/'), env)).text()).toBe('static')
    const legacy = await worker.fetch(new Request('https://legacy.example/?from=bookmark'), env)
    expect(legacy.status).toBe(308)
    expect(legacy.headers.get('location')).toBe(origin + '/?from=bookmark')
    const externalPath = await worker.fetch(new Request('https://legacy.example//evil.example/'), env)
    expect(new URL(externalPath.headers.get('location')!).origin).toBe(origin)
  })
})

it('canonicalizes every noncanonical scheme/host with path/query and no loops', async () => {
  const canonical = 'https://www.story2u.xyz'
  const configured = { ...env, BETTER_AUTH_URL: canonical }
  for (const host of ['http://story2u.xyz', 'https://story2u.xyz', 'http://www.story2u.xyz']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(new Request(host + '/api/auth/google/callback?code=fixture&state=fixture', { method }), configured)
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe(canonical + '/api/auth/google/callback?code=fixture&state=fixture')
    }
  }
  const privateResponse = await worker.fetch(new Request(canonical + '/v1/projects/local/workspace'), configured)
  expect(privateResponse.status).toBe(401)
  expect(privateResponse.headers.get('x-robots-tag')).toBe('noindex,nofollow')
})

describe('trusted managed-book proxy selection', () => {
  const book = 'book-11111111-1111-4111-8111-111111111111'
  it('checks Go ownership before forwarding a dynamic project and preserves PUT idempotency', async () => {
    await signIn()
    const upstream = vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-backend-bearer')
      if(path === `/v1/studio/books/${book}`) return Response.json({ bookId: book })
      expect(path).toBe(`/v1/studio/books/${book}/structure`)
      expect(init?.method).toBe('PUT')
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('structure-retry')
      return Response.json({ code: 'STRUCTURE_CONFLICT' }, { status: 409 })
    })
    stubAPI(upstream)
    const result = await handleRequest(request(`/v1/studio/books/${book}/structure`, 'PUT', '{}', { 'idempotency-key': 'structure-retry', 'x-actor-id': 'attacker' }), env)
    expect(result.status).toBe(409)
    expect(upstream).toHaveBeenCalledTimes(2)
  })
  it('fails closed on missing ownership, API failure and malformed IDs', async () => {
    await signIn()
    for(const status of [404, 500]) {
      const upstream = vi.fn(async () => new Response('{}', { status })); stubAPI(upstream)
      expect((await handleRequest(request(`/v1/projects/${book}/workspace`), env)).status).toBe(status === 404 ? 404 : 502)
      expect(upstream).toHaveBeenCalledTimes(1)
    }
    const upstream = vi.fn(); stubAPI(upstream)
    for(const path of ['/v1/projects/not-registered/workspace', `/v1/projects/${book}/%2e%2e/workspace`, '/v1/studio/books/%2e%2e/structure']) expect((await handleRequest(request(path), env)).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
  it('forwards a same-origin versioned book deletion with idempotency', async () => {
    await signIn()
    const upstream = vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if(path === `/v1/studio/books/${book}` && (!init?.method || init.method === 'GET')) return Response.json({ bookId: book })
      expect(path).toBe(`/v1/studio/books/${book}`)
      expect(init?.method).toBe('DELETE')
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('delete-book')
      expect(await new Response(init?.body).text()).toBe('{"baseVersion":3}')
      return new Response(null, { status: 204 })
    })
    stubAPI(upstream)
    const result = await handleRequest(request(`/v1/studio/books/${book}`, 'DELETE', '{"baseVersion":3}', { 'idempotency-key': 'delete-book' }), env)
    expect(result.status).toBe(204)
    expect(upstream).toHaveBeenCalledTimes(2)
    expect((await handleRequest(request(`/v1/studio/books/${book}`, 'DELETE', '{"baseVersion":3}', { origin: 'https://evil.example', 'idempotency-key': 'delete-book' }), env)).status).toBe(403)
  })
  it('allows Go to verify an owner-scoped deletion replay after the book is absent', async () => {
    await signIn()
    const upstream = vi.fn(async (_input: unknown, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json({ code: 'NOT_FOUND' }, { status: 404 }),
    )
    stubAPI(upstream)
    const response = await handleRequest(request(`/v1/studio/books/${book}`, 'DELETE', '{"baseVersion":3}', { 'idempotency-key': 'delete-replay' }), env)
    expect(response.status).toBe(204)
    expect(upstream).toHaveBeenCalledTimes(2)
    expect((await handleRequest(request(`/v1/studio/books/${book}`, 'GET'), env)).status).toBe(404)
  })

})

describe('private EPUB import proxy',()=>{
 it('admits only authenticated multipart upload on the bounded import route',async()=>{
  await signIn()
  const upstream=vi.fn(async(input:unknown,init?:RequestInit)=>{
   expect(new URL(String(input)).pathname).toBe('/v1/studio/imports')
   expect(init?.method).toBe('POST')
   expect(new Headers(init?.headers).get('content-type')).toContain('multipart/form-data')
   expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-backend-bearer')
   return Response.json({importId:'imp-aaaaaaaaaaaaaaaaaaaaaaaa'},{status:201})
  });stubAPI(upstream)
  const form=new FormData();form.set('file',new File(['epub'],'book.epub',{type:'application/epub+zip'}))
  const ok=await handleRequest(new Request(origin+'/v1/studio/imports',{method:'POST',headers:{cookie,origin,'idempotency-key':'upload-key'},body:form}),env)
  expect(ok.status).toBe(201)
  expect(upstream).toHaveBeenCalledTimes(1)
 })
 it('rejects JSON uploads, unlisted import paths and cross-site mutations before upstream',async()=>{
  await signIn();const upstream=vi.fn();stubAPI(upstream)
  expect((await handleRequest(request('/v1/studio/imports','POST','{}',{'idempotency-key':'json-upload'}),env)).status).toBe(415)
  for(const path of ['/v1/studio/imports/imp-aaaaaaaaaaaaaaaaaaaaaaaa','/v1/studio/imports/imp-aaaaaaaaaaaaaaaaaaaaaaaa/status']){
   expect((await handleRequest(request(path,'GET'),env)).status).toBe(502)
  }
  expect(upstream).toHaveBeenCalledTimes(2)
  expect((await handleRequest(request('/v1/studio/imports/imp-aaaaaaaaaaaaaaaaaaaaaaaa','DELETE','{}',{origin:'https://evil.example'}),env)).status).toBe(403)
  expect(upstream).toHaveBeenCalledTimes(2)
 })
})

describe('private knowledge proxy',()=>{
 it('requires session, validates dynamic ownership and only exposes bounded action routes',async()=>{
  const book='book-11111111-1111-4111-8111-111111111111',root=`/v1/studio/books/${book}/knowledge`
  const upstream=vi.fn(async(input:unknown,init?:RequestInit)=>{
   const path=new URL(String(input)).pathname
   if(path===`/v1/studio/books/${book}`)return Response.json({bookId:book})
   expect(path).toBe(root+'/enable');expect(new Headers(init?.headers).get('idempotency-key')).toBe('consent-key');return Response.json({version:1})
  });stubAPI(upstream)
  expect((await handleRequest(request(root),env)).status).toBe(401);expect(upstream).not.toHaveBeenCalled();await signIn()
  expect((await handleRequest(request(root+'/enable','POST','{}',{'idempotency-key':'consent-key'}),env)).status).toBe(200);expect(upstream).toHaveBeenCalledTimes(2)
  expect((await handleRequest(request(root+'/entities/entity-1','POST','{}'),env)).status).toBe(404)
  expect((await handleRequest(request(root+'/enable','GET'),env)).status).toBe(404)
  expect((await handleRequest(request(root+'/correct','POST','{}',{origin:'https://evil.example'}),env)).status).toBe(403)
 })
 it('proxies the lightweight summary route without broadening other reads',async()=>{
  await signIn()
  const book='book-11111111-1111-4111-8111-111111111111',root=`/v1/studio/books/${book}/knowledge`
  const upstream=vi.fn(async(input:unknown)=>{
   const path=new URL(String(input)).pathname
   if(path===`/v1/studio/books/${book}`)return Response.json({bookId:book})
   expect(path).toBe(root+'/summary')
   return Response.json({bookId:book})
  });stubAPI(upstream)
  expect((await handleRequest(request(root+'/summary'),env)).status).toBe(200)
  expect((await handleRequest(request(root+'/raw'),env)).status).toBe(404)
  expect(upstream).toHaveBeenCalledTimes(2)
 })
})

describe('private creative asset proxy',()=>{
 it('forwards only declared creative routes and keeps origin protection',async()=>{
  await signIn()
  const book='book-11111111-1111-4111-8111-111111111111',root=`/v1/studio/books/${book}/creative`
  const asset='ca-11111111-1111-4111-8111-111111111111'
  const forwarded:string[]=[]
  const upstream=vi.fn(async(input:unknown,init?:RequestInit)=>{
   const path=new URL(String(input)).pathname
   if(path===`/v1/studio/books/${book}`)return Response.json({bookId:book})
   forwarded.push(`${init?.method??'GET'} ${path}`)
   return Response.json({})
  });stubAPI(upstream)
  for(const [path,method] of [[root,'GET'],[root+'/assets','GET'],[root+'/assets/'+asset,'GET'],[root+'/assets/'+asset,'PATCH'],[root+'/proposals/decide','POST'],[root+'/settings/enable','POST'],[root+'/turns','GET']] as const)
   expect((await handleRequest(request(path,method,method==='GET'?undefined:'{}'),env)).status).toBe(200)
  expect(forwarded).toHaveLength(7)
  for(const [path,method] of [[root+'/assets/'+asset,'DELETE'],[root+'/settings/raw','POST'],[root+'/assets/../knowledge','GET'],[root+'/proposals','POST'],[root+'/state','GET']] as const)
   expect((await handleRequest(request(path,method,method==='GET'?undefined:'{}'),env)).status).toBe(404)
  expect((await handleRequest(request(root+'/proposals/decide','POST','{}',{origin:'https://evil.example'}),env)).status).toBe(403)
  expect(forwarded).toHaveLength(7)
 })
})

describe('per-user identity for the Go API', () => {
  it('signs the session user, method and path on every forwarded request and ownership check', async () => {
    await signIn('author@example.com')
    const book = 'book-11111111-1111-4111-8111-111111111111'
    const seen: { path: string; method: string; assertion: string | null }[] = []
    stubAPI(vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET', assertion: headers.get('x-writer-agent-identity') })
      return Response.json({ bookId: book })
    }))
    const forged = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciJ9.'
    const response = await handleRequest(request(`/v1/studio/books/${book}/creative/assets`, 'POST', '{}', { 'x-writer-agent-identity': forged, 'idempotency-key': 'k' }), env)
    expect(response.status).toBe(200)
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /v1/studio/books/${book}`, `POST /v1/studio/books/${book}/creative/assets`])
    for (const call of seen) {
      expect(call.assertion).not.toBe(forged)
      const { ok, claims } = decodeAssertion(call.assertion)
      expect(ok).toBe(true)
      expect(claims).toMatchObject({ iss: 'story2u-worker', aud: 'writer-agent-api', sub: signedUserId, email: 'author@example.com', email_verified: true, mth: call.method, pth: call.path })
      expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(60)
    }
  })
  it('refuses an API that does not separate users, without leaking its response', async () => {
    await signIn()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [{ bookId: 'someone-elses-book' }] })))
    const response = await handleRequest(request('/v1/studio/books'), env)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('someone-elses-book')
    const book = 'book-11111111-1111-4111-8111-111111111111'
    expect((await handleRequest(request(`/v1/projects/${book}/workspace`), env)).status).toBe(502)
  })
  it('fails closed without a valid identity signing key', async () => {
    await signIn()
    const upstream = vi.fn(); stubAPI(upstream)
    expect((await handleRequest(request('/v1/studio/books'), { ...env, WRITER_AGENT_IDENTITY_PRIVATE_KEY: '' })).status).toBe(503)
    expect((await handleRequest(request('/v1/studio/books'), { ...env, WRITER_AGENT_IDENTITY_PRIVATE_KEY: 'c2hvcnQ=' })).status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })
  it('gives two accounts different assertions and storage scopes', async () => {
    const subjects: unknown[] = [], scopes: string[] = []
    stubAPI(vi.fn(async (_input: unknown, init?: RequestInit) => {
      subjects.push(decodeAssertion(new Headers(init?.headers).get('x-writer-agent-identity')).claims.sub)
      return Response.json({ items: [] })
    }))
    for (const email of ['one@example.com', 'two@example.com']) {
      await signIn(email)
      expect((await handleRequest(request('/v1/studio/books'), env)).status).toBe(200)
      scopes.push(((await (await handleRequest(request('/api/session'), env)).json()) as { user: { scope: string } }).user.scope)
    }
    expect(subjects[0]).not.toBe(subjects[1])
    expect(scopes[0]).not.toBe(scopes[1])
  })
})
describe('AI point account route', () => {
  it('forwards only GET /v1/account with the signed user', async () => {
    await signIn()
    const seen: string[] = []
    stubAPI(vi.fn(async (input: unknown, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname} ${decodeAssertion(new Headers(init?.headers).get('x-writer-agent-identity')).claims.sub}`)
      return Response.json({ plan: 'free' })
    }))
    expect((await handleRequest(request('/v1/account'), env)).status).toBe(200)
    expect((await handleRequest(request('/v1/account', 'POST', '{}'), env)).status).toBe(404)
    expect((await handleRequest(request('/v1/account/plan'), env)).status).toBe(404)
    expect(seen).toEqual([`GET /v1/account ${signedUserId}`])
  })
})
