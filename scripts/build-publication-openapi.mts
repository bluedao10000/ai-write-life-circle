import { readFile, writeFile } from 'node:fs/promises'
import { publicationJsonSchemas } from '../packages/contracts/src/publication.js'

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const param = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
})
function op(
  name: string,
  schema: string,
  params: string[],
  input?: string,
  mutation = false,
  publicRead = false,
) {
  return {
    operationId: name,
    summary: name,
    tags: [publicRead ? 'Public catalog' : 'Author publication'],
    security: publicRead ? [] : [{ authorBearer: [] }],
    parameters: [
      ...params.map(param),
      ...(mutation
        ? [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 128 },
            },
          ]
        : []),
    ],
    ...(input
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref(input) } },
          },
        }
      : {}),
    responses: {
      [mutation ? '201' : '200']: {
        description:
          'Snapshot-only public data or owner-scoped publication result',
        headers: {
          'Cache-Control': { schema: { type: 'string', const: 'no-store' } },
        },
        content: { 'application/json': { schema: ref(schema) } },
      },
      ...Object.fromEntries(
        [401, 403, 404, 405, 409, 413, 415, 422, 429, 500].map((status) => [
          status,
          {
            description: 'Publication request rejected; no partial publication',
            content: {
              'application/problem+json': { schema: ref('PublicationProblem') },
            },
          },
        ]),
      ),
    },
  }
}
const base = '/studio/books/{bookId}/publication'
const paths = {
  [base]: { get: op('getPublication', 'PublicationManagement', ['bookId']) },
  [`${base}/preview`]: {
    post: op(
      'previewPublication',
      'PublicationPreview',
      ['bookId'],
      'PublicationPreviewInput',
    ),
  },
  [`${base}/versions`]: {
    get: op('listPublicationVersions', 'PublicationHistory', ['bookId']),
    post: op(
      'commitPublication',
      'PublicationVersion',
      ['bookId'],
      'PublicationCommitInput',
      true,
    ),
  },
  [`${base}/unlist`]: {
    post: op(
      'unlistPublication',
      'PublicationVersion',
      ['bookId'],
      'PublicationTransitionInput',
      true,
    ),
  },
  [`${base}/relist`]: {
    post: op(
      'relistPublication',
      'PublicationVersion',
      ['bookId'],
      'PublicationTransitionInput',
      true,
    ),
  },
  '/public/home': {
    get: op('getPublicHome', 'PublicHome', [], undefined, false, true),
  },
  '/public/books': {
    get: {
      ...op('listPublicBooks', 'PublicCatalog', [], undefined, false, true),
      parameters: [
        { name: 'q', in: 'query', schema: { type: 'string', maxLength: 500 } },
        {
          name: 'category',
          in: 'query',
          schema: { type: 'string', maxLength: 320 },
        },
        {
          name: 'status',
          in: 'query',
          schema: { type: 'string', enum: ['ongoing', 'completed', 'paused'] },
        },
        {
          name: 'sort',
          in: 'query',
          schema: { type: 'string', enum: ['recent', 'title'] },
        },
        {
          name: 'cursor',
          in: 'query',
          schema: { type: 'string', pattern: '^[0-9]+$' },
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
        },
      ],
    },
  },
  '/public/books/{slug}': {
    get: op('getPublicBook', 'PublicBook', ['slug'], undefined, false, true),
  },
  '/public/books/{slug}/chapters/{chapterSlug}': {
    get: op(
      'getPublicChapter',
      'PublicChapter',
      ['slug', 'chapterSlug'],
      undefined,
      false,
      true,
    ),
  },
  '/public/authors/{slug}': {
    get: op(
      'getPublicAuthor',
      'PublicAuthor',
      ['slug'],
      undefined,
      false,
      true,
    ),
  },
  '/public/categories': {
    get: op(
      'listPublicCategories',
      'PublicCategories',
      [],
      undefined,
      false,
      true,
    ),
  },
}
const doc = {
  openapi: '3.1.0',
  info: {
    title: 'story2u Publication and Public API',
    version: '1.0.0',
    description:
      'Go engineering contract. Private previews freeze saved revisions; commits revalidate under locks. Public reads use explicit snapshot DTOs only. OAuth BFF integration depends on PR #11; no alternate identity.',
  },
  servers: [{ url: 'https://api.story2u.xyz/v1' }],
  paths,
  components: {
    securitySchemes: { authorBearer: { type: 'http', scheme: 'bearer' } },
    schemas: publicationJsonSchemas,
  },
}
const text = `${JSON.stringify(doc, null, 2)}\n`
const output = new URL(
  '../harness/contracts/publication-api-v1.json',
  import.meta.url,
)
if (process.argv.includes('--check')) {
  if ((await readFile(output, 'utf8').catch(() => '')) !== text)
    throw new Error('Publication OpenAPI is stale.')
} else await writeFile(output, text)
