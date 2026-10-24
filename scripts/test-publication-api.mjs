import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import * as contracts from '../packages/contracts/dist/publication.js'

const root = await mkdtemp(join(tmpdir(), 'writer-publication-test-'))
const harness = join(root, 'harness'),
  state = join(root, 'state')
await mkdir(join(harness, 'manuscript'), { recursive: true })
for (let i = 1; i <= 3; i++)
  await writeFile(
    join(harness, 'manuscript', `CH-00${i}.md`),
    `# 第${i}章\nID: CH-00${i}\nvolumeId: ${i === 3 ? 'V2' : 'V1'}\norder: ${i === 3 ? 1 : i}\n\n合成公开正文 ${i}。\n`,
  )
await mkdir(join(harness, 'notes'), { recursive: true })
await writeFile(
  join(harness, 'notes', 'secret.md'),
  '# Private note\nID: NOTE-001\n\nNEVER_PUBLIC_NOTE_SECRET',
)
const schemas = JSON.parse(
  await readFile(
    new URL('../harness/contracts/publication-api-v1.json', import.meta.url),
    'utf8',
  ),
)
const ajv = new Ajv({ strict: false })
addFormats(ajv)
const validate = (name, body) => {
  const check = ajv.compile({
    components: schemas.components,
    $ref: `#/components/schemas/${name}`,
  })
  assert.ok(check(body), `${name}: ${JSON.stringify(check.errors)}`)
  const key = name[0].toLowerCase() + name.slice(1) + 'Schema'
  assert.ok(contracts[key], key)
  contracts[key].parse(body)
}
const child = spawn(
  new URL('../apps/api-go/dist/writer-agent-api', import.meta.url).pathname,
  [],
  {
    env: {
      ...process.env,
      WRITER_AGENT_ENV: 'test',
      NODE_ENV: 'test',
      WRITER_AGENT_AUTH_MODE: 'local',
      WRITER_AGENT_AUTHOR_ID: '',
      WRITER_AGENT_PROJECT_ID: 'publication-fixture',
      WRITER_AGENT_API_PORT: '0',
      WRITER_AGENT_API_HOST: '127.0.0.1',
      WRITER_AGENT_HARNESS_ROOT: harness,
      WRITER_AGENT_STATE_DIR: state,
      WRITER_AGENT_LLM_API_KEY: '',
      WRITER_AGENT_LLM_BASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let output = '',
  stderr = ''
child.stdout.on('data', (data) => {
  output += data
})
child.stderr.on('data', (data) => {
  stderr += data
})
let origin,
  checks = 0
try {
  for (let i = 0; i < 200; i++) {
    const m = output.match(/listening on (http:\/\/[^\s]+)/)
    if (m) {
      origin = m[1]
      break
    }
    if (child.exitCode !== null) throw Error(stderr)
    await delay(20)
  }
  assert.ok(origin, 'API started')
  const call = async (
    path,
    { method = 'GET', body, key, status = 200, schema } = {},
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const value = await response.json()
    assert.equal(response.status, status, JSON.stringify(value))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    if (schema) validate(schema, value)
    checks++
    return value
  }
  const base = '/v1/studio/books/publication-fixture/publication'
  const home = () => call('/v1/public/home', { schema: 'PublicHome' })
  assert.equal((await home()).total, 0)
  const drafts = []
  for (let i = 1; i <= 3; i++) {
    const detail = await call(
      `/v1/projects/publication-fixture/chapters/CH-00${i}`,
    )
    drafts.push({
      chapterId: detail.chapterId,
      revisionId: detail.headRevision.revisionId,
      contentHash: detail.headRevision.contentHash,
      volumeId: i === 3 ? 'V2' : 'V1',
      chapterOrder: i === 3 ? 1 : i,
    })
  }
  const metadata = {
    slug: 'synthetic-story',
    title: '合成故事',
    penName: '合成笔名',
    authorBio: '公开简介',
    tagline: '一句话',
    description: '公开作品说明',
    category: '科幻',
    serialStatus: 'ongoing',
    coverUrl: '',
  }
  const preview = await call(base + '/preview', {
    method: 'POST',
    body: { baseVersionId: null, metadata, chapters: [drafts[0]] },
    schema: 'PublicationPreview',
  })
  const commit = { baseVersionId: null, previewId: preview.previewId,note:'PRIVATE_PUBLICATION_NOTE' }
  const first = await call(base + '/versions', {
    method: 'POST',
    body: commit,
    key: 'first',
    status: 201,
    schema: 'PublicationVersion',
  })
  assert.deepEqual(
    await call(base + '/versions', {
      method: 'POST',
      body: commit,
      key: 'first',
      status: 201,
      schema: 'PublicationVersion',
    }),
    first,
  )
  const catalog = await call('/v1/public/books?limit=1', {
    schema: 'PublicCatalog',
  })
  assert.equal(catalog.total, 1)
  const book = await call('/v1/public/books/synthetic-story', {
    schema: 'PublicBook',
  })
  assert.equal(book.chapterCount, 1)
  const slug = book.chapters[0].slug
  const chapter = await call(
    `/v1/public/books/synthetic-story/chapters/${slug}`,
    { schema: 'PublicChapter' },
  )
  assert.equal(chapter.markdown, '合成公开正文 1。\n')
  const author = await call('/v1/public/authors/' + book.authorSlug, {
    schema: 'PublicAuthor',
  })
  assert.equal(author.books.length, 1)
  await call('/v1/public/categories', { schema: 'PublicCategories' })
  const publicJson = JSON.stringify([
    await home(),
    catalog,
    book,
    chapter,
    author,
  ])
  for (const secret of [
    'NEVER_PUBLIC_NOTE_SECRET','PRIVATE_PUBLICATION_NOTE',
    'revisionId',
    'contentHash',
    'ownerUserId',
    'sourceChapterId',
    'local-author',
    '合成公开正文 2',
    '合成公开正文 3',
  ])
    assert.ok(!publicJson.includes(secret), secret)
  for (const guessed of ['CH-002', 'CH-003', '2', '3'])
    await call(`/v1/public/books/synthetic-story/chapters/${guessed}`, {
      status: 404,
      schema: 'PublicationProblem',
    })
  const saved = await call(
    '/v1/projects/publication-fixture/chapters/CH-001/revisions',
    {
      method: 'POST',
      body: { baseRevisionId: drafts[0].revisionId, markdown: '私有新草稿' },
      key: 'save',
      status: 201,
    },
  )
  assert.equal(
    (
      await call(`/v1/public/books/synthetic-story/chapters/${slug}`, {
        schema: 'PublicChapter',
      })
    ).markdown,
    chapter.markdown,
  )
  const management = await call(base, { schema: 'PublicationManagement' })
  assert.deepEqual(management.changedChapterIds, ['CH-001'])
  drafts[0] = {
    ...drafts[0],
    revisionId: saved.revisionId,
    contentHash: saved.contentHash,
  }
  const updatePreview = await call(base + '/preview', {
    method: 'POST',
    body: {
      baseVersionId: first.versionId,
      metadata,
      chapters: [drafts[2], drafts[0], drafts[1]],
    },
    schema: 'PublicationPreview',
  })
  const updated = await call(base + '/versions', {
    method: 'POST',
    body: {
      baseVersionId: first.versionId,
      previewId: updatePreview.previewId,
    },
    key: 'update',
    status: 201,
    schema: 'PublicationVersion',
  })
  assert.equal(updated.versionNumber, 2)
  assert.deepEqual(
    updated.chapters.map((c) => c.chapterId),
    ['CH-001', 'CH-002', 'CH-003'],
  )
  const stale = await call(base + '/preview', {
    method: 'POST',
    body: { baseVersionId: updated.versionId, metadata, chapters: [drafts[0]] },
    schema: 'PublicationPreview',
  })
  await call('/v1/projects/publication-fixture/chapters/CH-001/revisions', {
    method: 'POST',
    body: { baseRevisionId: drafts[0].revisionId, markdown: '更晚的私有草稿' },
    key: 'later-save',
    status: 201,
  })
  await call(base + '/versions', {
    method: 'POST',
    body: { baseVersionId: updated.versionId, previewId: stale.previewId },
    key: 'conflict',
    status: 409,
    schema: 'PublicationProblem',
  })
  const withdraw = await call(base + '/preview', {
    method: 'POST',
    body: { baseVersionId: updated.versionId, metadata, chapters: [drafts[1]] },
    schema: 'PublicationPreview',
  })
  const withdrawn = await call(base + '/versions', {
    method: 'POST',
    body: { baseVersionId: updated.versionId, previewId: withdraw.previewId },
    key: 'withdraw',
    status: 201,
    schema: 'PublicationVersion',
  })
  await call(`/v1/public/books/synthetic-story/chapters/${slug}`, {
    status: 404,
    schema: 'PublicationProblem',
  })
  const unlisted = await call(base + '/unlist', {
    method: 'POST',
    body: { baseVersionId: withdrawn.versionId },
    key: 'unlist',
    status: 201,
    schema: 'PublicationVersion',
  })
  assert.equal((await home()).total, 0)
  await call('/v1/public/books/synthetic-story', {
    status: 404,
    schema: 'PublicationProblem',
  })
  await call(base + '/relist', {
    method: 'POST',
    body: { baseVersionId: unlisted.versionId },
    key: 'relist',
    status: 201,
    schema: 'PublicationVersion',
  })
  const history = await call(base + '/versions', {
    schema: 'PublicationHistory',
  })
  assert.equal(history.items.length, 5)
  assert.equal(history.items[0].chapters[0].markdown, chapter.markdown)
  console.log(
    `Publication HTTP: ${checks} checks passed; Zod/OpenAPI responses, publish/update/conflict/withdraw/unlist/relist, multivolume and privacy.`,
  )
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
  await rm(root, { recursive: true, force: true })
}
