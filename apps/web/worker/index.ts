import { handlePublicSite } from './public'
import { publicationRoute } from './publication-route'
import { authConfigured, createAuth, verifiedGoogleUser, type Env } from './auth'
import { IDENTITY_HEADER, perUserAPI, signIdentity, storageScope } from './identity'

function problem(status: number, code: string, detail: string) {
  return Response.json({ type: 'about:blank', title: detail, status, code, detail }, {
    status, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex,nofollow', 'content-type': 'application/problem+json' },
  })
}

function allowedRoute(path: string, method: string, project: string) {
  if(publicationRoute(path,method,project))return true
  const thinking = `/v1/studio/books/${encodeURIComponent(project)}/thinking`
  if(path===thinking+'/capabilities'||path===thinking+'/models')return method==='GET'
  if(path===thinking+'/preferences')return ['GET','POST'].includes(method)
  if(path===thinking+'/sessions')return ['GET','POST'].includes(method)
  const thinkMatch=new RegExp(`^${thinking}/sessions/th-[a-f0-9-]{36}(/messages|/events|/cancel|/resume)?$`).exec(path)
  if(thinkMatch){return thinkMatch[1]==='/events'?method==='GET':thinkMatch[1]?method==='POST':['GET','DELETE'].includes(method)}
  // Creative assets: author-owned settings and AI proposals. Only explicit routes are forwarded.
  const creative = `/v1/studio/books/${encodeURIComponent(project)}/creative`
  if (path === creative) return method === 'GET'
  if (path.startsWith(creative + '/')) {
    const suffix = path.slice(creative.length + 1)
    if (method === 'GET') return /^(?:assets|proposals|turns|turns\/excerpt|context|divergences|assets\/ca-[a-f0-9-]{36})$/.test(suffix)
    if (method === 'PATCH') return /^assets\/ca-[a-f0-9-]{36}$/.test(suffix)
    if (method === 'POST') return /^(?:assets|links|links\/cl-[a-f0-9-]{36}\/remove|proposals\/decide|organize|plan-checks|divergences\/cd-[a-f0-9-]{36}\/decide|settings\/(?:enable|pause|resume|auto))$/.test(suffix)
    return false
  }
  const memory = `/v1/studio/books/${encodeURIComponent(project)}/knowledge`
  if (path === memory) return method === 'GET'
  if (path.startsWith(memory+'/')) {
    const suffix=path.slice(memory.length+1)
    if (method==='GET') return /^(?:summary|related|jobs|history|corrections|entities\/[A-Za-z0-9_-]+)$/.test(suffix)
    return method==='POST' && ['enable','pause','resume','rebuild','correct','undo'].includes(suffix)
  }
  const base = `/v1/projects/${encodeURIComponent(project)}`
  if (!path.startsWith(base + '/')) return false
  const suffix = path.slice(base.length)
  const id = '[^/%\\\\]+'
  const routes: [string, string[]][] = [
    ['/workspace', ['GET', 'PATCH']], ['/chapters', ['GET']], ['/notes', ['GET', 'POST']],
    [`/notes/${id}`, ['PATCH']], [`/chapters/${id}`, ['GET']],
    [`/chapters/${id}/revisions`, ['GET', 'POST']],
    [`/chapters/${id}/revisions/${id}`, ['GET']],
    [`/chapters/${id}/review-preview`, ['POST']], [`/chapters/${id}/reviews`, ['GET', 'POST']],
    [`/reviews/${id}`, ['GET']], [`/reviews/${id}/cancel`, ['POST']],
    [`/reviews/${id}/findings/${id}/feedback`, ['POST']],
  ]
  // Decode once, rejecting encoded separators and dot segments rather than forwarding ambiguous paths.
  let decoded: string
  try { decoded = decodeURIComponent(suffix) } catch { return false }
  if (decoded.includes('\\') || decoded.includes('%') || decoded.split('/').some(part => part === '.' || part === '..')) return false
  if (suffix.split('/').length !== decoded.split('/').length) return false
  return routes.some(([pattern, methods]) => methods.includes(method) && new RegExp(`^${pattern}$`).test(decoded))
}

function importRoute(path: string, method: string) {
  if (path === '/v1/studio/imports') return method === 'POST'
  return /^\/v1\/studio\/imports\/imp-[0-9a-f]{24}(?:\/status)?$/.test(path) &&
    (method === 'GET' || (method === 'DELETE' && !path.endsWith('/status')) ||
      (method === 'POST' && !path.endsWith('/status')))
}

async function handleRequestInternal(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (env.BETTER_AUTH_URL && url.origin !== new URL(env.BETTER_AUTH_URL).origin) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return problem(403, 'ORIGIN_FORBIDDEN', '请使用正式作品入口。')
    const canonical = new URL(env.BETTER_AUTH_URL)
    canonical.pathname = url.pathname
    canonical.search = url.search
    return Response.redirect(canonical.href, 308)
  }
  const publicResponse=await handlePublicSite(request,{...env,ASSETS:{fetch:(assetRequest:Request)=>env.ASSETS.fetch(assetRequest as never) as unknown as Promise<Response>},WRITER_AGENT_API_ORIGIN:env.WRITER_AGENT_API_ORIGIN||'https://api.story2u.xyz'})
  if(publicResponse)return publicResponse
  const privateRoute = url.pathname === '/api/session' || url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/v1/')
  if (!privateRoute) {
    const response=await (env.ASSETS.fetch(request as never) as unknown as Promise<Response>)
    if(!url.pathname.startsWith('/studio') && response.headers.get('content-type')?.includes('text/html')) return new Response(request.method==='HEAD'?null:'Not found',{status:404,headers:{'cache-control':'no-store','x-robots-tag':'noindex'}})
    if(url.pathname.startsWith('/studio')){const headers=new Headers(response.headers);headers.set('x-robots-tag','noindex,nofollow');headers.set('cache-control','no-store');return new Response(response.body,{status:response.status,headers})}
    return response
  }
  if (!authConfigured(env)) return problem(503, 'AUTH_NOT_CONFIGURED', '登录服务尚未配置完成。')
  if (url.origin !== new URL(env.BETTER_AUTH_URL).origin) return problem(403, 'ORIGIN_FORBIDDEN', '请使用正式作品入口。')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') {
      return problem(403, 'ORIGIN_FORBIDDEN', '此请求不是来自作品入口。')
    }
    const isImportUpload = url.pathname === '/v1/studio/imports' && request.method === 'POST'
    const isImportDelete = request.method === 'DELETE' && importRoute(url.pathname, request.method)
    const isBookDelete = request.method === 'DELETE' && /^\/v1\/studio\/books\/[A-Za-z0-9_-]+$/.test(url.pathname)
    if (isImportUpload) {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
        return problem(415, 'MULTIPART_REQUIRED', 'EPUB 上传须使用 multipart/form-data。')
      }
    } else if (!isImportDelete && !isBookDelete && !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      return problem(415, 'JSON_REQUIRED', '请求须使用 JSON。')
    }
  }
  const auth = createAuth(env)
  if (url.pathname.startsWith('/api/auth/')) {
    const routes: Record<string, string> = {
      '/api/auth/sign-in/social': 'POST', '/api/auth/callback/google': 'GET',
      '/api/auth/google/callback': 'GET',
      '/api/auth/get-session': 'GET', '/api/auth/sign-out': 'POST', '/api/auth/error': 'GET',
    }
    if (routes[url.pathname] !== request.method) return problem(404, 'NOT_FOUND', '接口不存在。')
    if (url.pathname === '/api/auth/sign-in/social') {
      const reader = request.body?.getReader()
      if (!reader) return problem(400, 'INVALID_LOGIN', '登录请求无效。')
      const chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 16_384) { void reader.cancel(); return problem(413, 'LOGIN_TOO_LARGE', '登录请求过大。') }
        chunks.push(value)
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      let body: Record<string, unknown>
      try { body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> }
      catch { return problem(400, 'INVALID_LOGIN', '登录请求无效。') }
      if (!body || body.provider !== 'google' || body.idToken) return problem(400, 'INVALID_LOGIN', '请使用 Google 授权登录。')
      for (const key of ['callbackURL', 'errorCallbackURL', 'newUserCallbackURL']) {
        if (body[key] !== undefined && (typeof body[key] !== 'string' || new URL(body[key], url.origin).origin !== url.origin)) {
          return problem(403, 'RETURN_URL_FORBIDDEN', '登录后仅能返回作品入口。')
        }
      }
      // Only the redirect flow is exposed; client input cannot override scopes or Google parameters.
      const requested=typeof body.callbackURL==='string'?new URL(body.callbackURL,url.origin).pathname:'/'
      const callbackURL=['/','/studio','/studio/publish'].includes(requested)?requested:'/'
      const safeBody = { provider: 'google', callbackURL, errorCallbackURL: callbackURL+'?login=failed' }
      request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(safeBody) })
    }
    if (url.pathname === '/api/auth/google/callback') {
      // Preserve query/state cookies; Google code exchange uses the configured public redirectURI.
      const internal = new URL('/api/auth/callback/google' + url.search, url.origin)
      request = new Request(internal, { method: 'GET', headers: request.headers })
    }
    const response = await auth.handler(request)
    const headers = new Headers(response.headers)
    headers.set('cache-control', 'no-store')
    return new Response(response.body, { status: response.status, headers })
  }
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!session) return problem(401, 'SESSION_REQUIRED', '请先使用 Google 登录。')
  // Any verified Google account may sign in; Go scopes every work to its own author.
  if (!verifiedGoogleUser(session.user)) return problem(403, 'AUTHOR_FORBIDDEN', '请使用已验证邮箱的 Google 账号登录。')
  const user = { id: session.user.id, email: session.user.email, emailVerified: session.user.emailVerified }
  if (url.pathname === '/api/session') {
    if (request.method !== 'GET') return problem(405, 'METHOD_NOT_ALLOWED', '请求方法不支持。')
    // `scope` partitions browser-stored drafts per account; it is not a credential.
    return Response.json({ user: { name: session.user.name, email: session.user.email, scope: await storageScope(session.user.id) }, projectId: env.WRITER_AGENT_PROJECT_ID || 'local' }, { headers: { 'cache-control': 'no-store' } })
  }
  const configured = env.WRITER_AGENT_PROJECT_ID || 'local'
  const booksRoot = (url.pathname === '/v1/studio/books' && ['GET', 'POST'].includes(request.method)) || (url.pathname === '/v1/account' && request.method === 'GET') || (url.pathname === '/v1/account/redeem' && request.method === 'POST')
  const importAllowed = importRoute(url.pathname, request.method)
  const structure = /^\/v1\/studio\/books\/([A-Za-z0-9_-]+)(?:\/(structure))?$/.exec(url.pathname)
  const managedID = (id: string) => /^book-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  const structureAllowed = !!structure && (structure[1] === configured || managedID(structure[1])) && (structure[2] ? request.method === 'PUT' : ['GET', 'DELETE'].includes(request.method))
  const dynamic = /^\/v1\/(?:projects|studio\/books)\/([A-Za-z0-9_-]+)\//.exec(url.pathname)?.[1]
  const dynamicAllowed = !!dynamic && (dynamic === configured || managedID(dynamic)) && allowedRoute(url.pathname, request.method, dynamic)
  if (!booksRoot && !structureAllowed && !dynamicAllowed && !importAllowed && !allowedRoute(url.pathname, request.method, configured)) return problem(404, 'NOT_FOUND', '接口不存在。')
  if (!env.WRITER_AGENT_API_TOKEN) return problem(503, 'API_NOT_CONFIGURED', '作品服务尚未连接。')
  const target = new URL(env.WRITER_AGENT_API_ORIGIN || 'https://api.story2u.xyz')
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    return problem(503, 'API_NOT_CONFIGURED', '作品服务地址无效。')
  }
  // Dynamic IDs are admitted only after the Go registry confirms ownership for
  // this server-authenticated author. Never turn request IDs into origin roots.
  const selected = structure?.[1] ?? dynamic
  if(selected && selected !== configured) {
    const check = new URL(`/v1/studio/books/${encodeURIComponent(selected)}`, target)
    try {
      const assertion = await signIdentity(env.WRITER_AGENT_IDENTITY_PRIVATE_KEY, user, 'GET', check.pathname)
      const response = await fetch(check, { headers: { authorization: `Bearer ${env.WRITER_AGENT_API_TOKEN}`, [IDENTITY_HEADER]: assertion, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      await response.body?.cancel()
      if (!perUserAPI(response)) return problem(502, 'API_IDENTITY_UNSUPPORTED', '作品服务版本不兼容，请稍后重试。')
      // A committed delete disappears from GET immediately. Let Go validate
      // the owner-scoped tombstone when an authenticated author retries DELETE.
      const ok = response.status === 200 || (response.status === 404 && request.method === 'DELETE' && !!structure && !structure[2])
      if(!ok) return problem(response.status >= 500 ? 502 : 404, 'BOOK_UNAVAILABLE', '作品不存在或没有访问权限。')
    } catch { return problem(502, 'API_CONNECTION_FAILED', '作品服务暂时无法连接。') }
  }
  target.pathname = url.pathname
  target.search = url.search
  // The assertion is minted here from the verified session, never copied from the browser.
  const headers = new Headers({ accept: 'application/json, application/problem+json', authorization: `Bearer ${env.WRITER_AGENT_API_TOKEN}`, [IDENTITY_HEADER]: await signIdentity(env.WRITER_AGENT_IDENTITY_PRIVATE_KEY, user, request.method, target.pathname) })
  for (const name of ['content-type', 'idempotency-key', 'x-writer-agent-thinking']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  try {
    const timeout = importAllowed ? 120_000 : 30_000
    const upstream = await fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual', signal: AbortSignal.timeout(timeout) })
    if (!perUserAPI(upstream)) {
      // An API without per-user identity would merge every account onto one author.
      await upstream.body?.cancel()
      return problem(502, 'API_IDENTITY_UNSUPPORTED', '作品服务版本不兼容，请稍后重试。')
    }
    const thinkingAuthorization = target.pathname.includes('/thinking/') && upstream.status === 403 &&
      ['AUTHORIZATION_REQUIRED', 'SCOPE_FORBIDDEN'].includes(((await upstream.clone().json().catch(() => null)) as {code?:string} | null)?.code ?? '')
    if ((upstream.status >= 300 && upstream.status < 400) || upstream.status === 401 || (upstream.status === 403 && !thinkingAuthorization)) {
      await upstream.body?.cancel()
      return problem(502, 'API_CONNECTION_FAILED', '作品服务连接失败，请稍后重试。')
    }
    if (upstream.status === 204) {
      await upstream.body?.cancel()
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    }
    const outgoing = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    for (const name of ['content-type', 'x-request-id']) {
      const value = upstream.headers.get(name)
      if (value) outgoing.set(name, value)
    }
    return new Response(upstream.body, { status: upstream.status, headers: outgoing })
  } catch {
    return problem(502, 'API_CONNECTION_FAILED', '作品服务暂时无法连接，请保留草稿后重试。')
  }
}

export default {
  async fetch(request: Request, env: Env) {
    try { return await handleRequest(request, env) }
    catch { return problem(503, 'AUTH_UNAVAILABLE', '登录服务暂时不可用，请稍后重试。') }
  },
}

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const response = await handleRequestInternal(request, env)
  const path = new URL(request.url).pathname
  if (/^\/(?:api|v1)(?:\/|$)/.test(path) && !path.startsWith('/v1/public/')) {
    const headers = new Headers(response.headers)
    headers.set('x-robots-tag', 'noindex,nofollow')
    headers.set('cache-control', 'no-store')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  return response
}
