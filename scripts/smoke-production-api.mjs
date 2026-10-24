import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'writer-production-smoke-'))
const tokenFile = join(root, 'token')
const state = join(root, 'state')
const binary = resolve('apps/api-go/dist/writer-agent-api')
const project = 'production-smoke'
let token = randomBytes(32).toString('hex')
let running

async function start() {
  const child = spawn(binary, [], { env: {
    ...process.env, NODE_ENV: 'production', WRITER_AGENT_ENV: 'production',
    WRITER_AGENT_AUTH_MODE: 'bearer', WRITER_AGENT_AUTH_TOKEN_FILE: tokenFile,
    WRITER_AGENT_AUTHOR_ID: 'bruce', WRITER_AGENT_API_HOST: '127.0.0.1', WRITER_AGENT_API_PORT: '0',
    WRITER_AGENT_HARNESS_ROOT: root, WRITER_AGENT_STATE_DIR: state, WRITER_AGENT_PROJECT_ID: project,
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let output = ''
  try {
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error(`Production startup timed out: ${output}`)), 10_000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Startup failed: ${output}`)) })
      child.stdout.on('data', (chunk) => {
        output += chunk
        const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (match) { clearTimeout(timer); resolvePort(match[1]) }
      })
      child.stderr.on('data', (chunk) => { output += chunk })
    })
    return { url: `http://127.0.0.1:${port}`, async stop() {
      child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { assert.deepEqual(await exited, [0, null]) } finally { clearTimeout(timeout) }
    } }
  } catch (error) { child.kill('SIGKILL'); await exited; throw error }
}

async function request(path, credential, init = {}) {
  return fetch(`${running.url}${path}`, { ...init, headers: {
    ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...init.headers,
  } })
}

try {
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 })
  running = await start()
  assert.equal((await request('/healthz')).status, 200)
  const notes = `/v1/projects/${project}/notes`
  for (const credential of [undefined, randomBytes(32).toString('hex')]) {
    const rejected = await request(notes, credential, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Actor-ID': 'attacker' }, body: '{"content":"must not persist"}' })
    assert.equal(rejected.status, 401)
    assert.match(rejected.headers.get('www-authenticate'), /^Bearer/)
  }
  assert.deepEqual(await (await request(notes, token)).json(), { items: [] })
  assert.equal((await request(`/internal/projects/${project}/harness-projection`, token)).status, 404)
  const key = randomUUID()
  const mutation = { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key, 'X-Actor-ID': 'attacker', 'X-Actor-Role': 'agent' }, body: '{"content":"deployment authentication check"}' }
  const created = await request(notes, token, mutation)
  assert.equal(created.status, 201)
  const note = await created.json()
  assert.equal(note.createdBy, 'bruce')
  await running.stop(); running = undefined
  running = await start()
  assert.deepEqual(await (await request(notes, token, mutation)).json(), note)
  const items = (await (await request(notes, token)).json()).items
  assert.equal(items.length, 1)
  const stored = JSON.parse(await readFile(join(state, 'notes', `${Buffer.from(project).toString('base64url')}.json`), 'utf8'))
  assert.ok(stored.audit.every((entry) => entry.actorId === 'bruce'))
  // Managed writing uses the real production bearer resolver and isolated state.
  for(const credential of [undefined, randomBytes(32).toString('hex')]) {
    assert.equal((await request('/v1/studio/books', credential, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'anonymous' }, body: '{"operation":"create","baseVersion":0}' })).status, 401)
  }
  const createWork = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'managed-bootstrap', 'x-actor-id': 'attacker' }, body: '{"operation":"create","baseVersion":0}' }
  const workResponse = await request('/v1/studio/books', token, createWork)
  assert.equal(workResponse.status, 201)
  const work = await workResponse.json()
  assert.deepEqual(await (await request('/v1/studio/books', token, createWork)).json(), work)
  const chapterURL = `/v1/projects/${work.bookId}/chapters/${work.chapters[0].chapterId}`
  const detail = await (await request(chapterURL, token)).json()
  assert.equal(detail.headRevision.markdown, '')
  const prose = 'Synthetic production-mode writing survives backup and restart.'
  const saved = await request(chapterURL + '/revisions', token, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'managed-prose' }, body: JSON.stringify({ baseRevisionId: detail.headRevision.revisionId, markdown: prose }) })
  assert.equal(saved.status, 201)
  const registry = JSON.parse(await readFile(join(state, 'works/catalog-v1.json'), 'utf8'))
  assert.equal(registry.books[0].ownerId, 'bruce')
  assert.ok(registry.audit.every(entry => entry.actor.id === 'bruce'))
  await running.stop(); running = undefined
  // Restore only into an isolated side directory, never over newer live writes.
  const backup = join(root, 'backup-state')
  await cp(state, backup, { recursive: true })
  await rm(state, { recursive: true }) // disposable synthetic state only
  await cp(backup, state, { recursive: true })
  running = await start()
  assert.equal((await (await request(chapterURL, token)).json()).headRevision.markdown, prose)
  assert.equal((await (await request('/v1/studio/books', token)).json()).items.length, 1)
  assert.equal((await request('/v1/projects/book-unregistered/workspace', token)).status, 404)
  await running.stop(); running = undefined
  const oldToken = token
  token = randomBytes(32).toString('hex')
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 })
  running = await start()
  assert.equal((await request(notes, oldToken)).status, 401)
  assert.equal((await request(notes, token)).status, 200)
  process.stdout.write('Production bearer authentication, managed writing, ownership, isolated backup restore, persistence, replay and token rotation passed.\n')
} finally {
  if (running) await running.stop()
  await rm(root, { recursive: true, force: true })
}
