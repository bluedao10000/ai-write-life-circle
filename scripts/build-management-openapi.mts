import { readFile, writeFile } from 'node:fs/promises'
import { managementJsonSchemas as schemas } from '../packages/contracts/src/management.js'
const parameter = {
  name: 'bookId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
}
function operation(
  id: string,
  output: string | null = null,
  mutation = false,
  book = false,
  requestSchema = 'StructureInput',
) {
  const responses = output
    ? {
        [id === 'createManagedBook' ? '201' : '200']: {
          description: 'Author-owned book structure; no prose or owner credentials',
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${output}` },
            },
          },
        },
      }
    : {}
  return {
    operationId: id,
    summary: id,
    security: [{ authorBearer: [] }],
    tags: ['Author workspace'],
    parameters: [
      ...(book ? [parameter] : []),
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
    ...(mutation
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${requestSchema}` },
              },
            },
          },
        }
      : {}),
    responses: {
      ...responses,
      ...Object.fromEntries(
        [401, 403, 404, 405, 409, 413, 422, 500].map((code) => [
          code,
          {
            description:
              'Authentication, ownership, structure CAS, validation or storage failure; no partial structure commit',
          },
        ]),
      ),
    },
  }
}
const doc = {
  openapi: '3.1.0',
  info: {
    title: 'Writer Agent Author Workspace Management',
    version: '1.0.0',
    description:
      'Go-only managed structures. Ordered arrays, baseVersion CAS, atomic ownership/audit/idempotency. Existing Markdown revisions, Notes, Review and Publication routes remain unchanged.',
    license: { name: 'Private', url: 'https://github.com/story2u/ai-write-life-circle' },
  },
  servers: [
    {
      url: 'http://127.0.0.1:8787/v1',
      description: 'Isolated local development',
    },
  ],
  tags: [
    {
      name: 'Author workspace',
      description: 'Online book, volume and chapter organization',
    },
  ],
  paths: {
    '/studio/books': {
      get: operation('listManagedBooks', 'ManagedBooks'),
      post: operation('createManagedBook', 'ManagedBook', true),
    },
    '/studio/books/{bookId}': {
      get: operation('getManagedBook', 'ManagedBook', false, true),
      delete: {
        ...operation('deleteManagedBook', null, true, true, 'DeleteBookInput'),
        responses: {
          204: { description: 'Book removed and its private state purged' },
          401: {
            description:
              'Authentication, ownership, structure CAS, validation or storage failure; no partial structure commit',
          },
          403: {
            description:
              'Authentication, ownership, structure CAS, validation or storage failure; no partial structure commit',
          },
          404: {
            description:
              'Authentication, ownership, structure CAS, validation or storage failure; no partial structure commit',
          },
          405: {
            description:
              'Authentication, ownership, structure CAS, validation or storage failure; no partial structure commit',
          },
          409: {
            description:
              'Book changed, or a listed publication must be unlisted before deletion',
          },
          413: {
            description:
              'Authentication, ownership, structure CAS, validation or storage failure; no partial structure commit',
          },
          422: {
            description:
              'Authentication, ownership, structure CAS, validation or storage failure; no partial structure commit',
          },
          500: {
            description:
              'Authentication, ownership, structure CAS, validation or storage failure; no partial structure commit',
          },
        },
      },
    },
    '/studio/books/{bookId}/structure': {
      put: operation('updateManagedStructure', 'ManagedBook', true, true),
    },
    '/studio/imports': {
      post: {
        operationId: 'previewEPUBImport',
        summary: 'Parse and privately stage a text-first EPUB without invoking a model',
        security: [{ authorBearer: [] }],
        tags: ['Author workspace'],
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 128 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Idempotent preview replay',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ImportPreview' },
              },
            },
          },
          201: {
            description: 'Privately staged EPUB preview; not visible in the shelf',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ImportPreview' },
              },
            },
          },
          401: { description: 'Authentication required' },
          403: { description: 'Author role or ownership required' },
          413: { description: 'EPUB or multipart body exceeds the safety limit' },
          415: { description: 'multipart/form-data is required' },
          422: { description: 'Invalid, encrypted, fixed-layout or unsupported EPUB' },
        },
      },
    },
    '/studio/imports/{importId}': {
      parameters: [
        {
          name: 'importId',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^imp-[0-9a-f]{24}$' },
        },
      ],
      get: {
        operationId: 'getEPUBImport',
        summary: 'Read an owner-scoped EPUB preview with bounded excerpts',
        security: [{ authorBearer: [] }],
        tags: ['Author workspace'],
        responses: {
          200: {
            description: 'Owner-scoped import preview',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ImportPreview' },
              },
            },
          },
          401: { description: 'Authentication required' },
          403: { description: 'Author role required' },
          404: { description: 'Import not found for this author' },
        },
      },
      delete: {
        operationId: 'discardEPUBImport',
        summary: 'Discard an uncommitted private EPUB staging area',
        security: [{ authorBearer: [] }],
        tags: ['Author workspace'],
        responses: {
          204: { description: 'Staging area discarded' },
          401: { description: 'Authentication required' },
          403: { description: 'Author role required' },
          404: { description: 'Import not found' },
          409: { description: 'Import already committed' },
        },
      },
      post: {
        operationId: 'commitEPUBImport',
        summary: 'Atomically create a complete author-owned book and initial revisions',
        security: [{ authorBearer: [] }],
        tags: ['Author workspace'],
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 128 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ImportCommitInput' },
            },
          },
        },
        responses: {
          200: {
            description: 'Idempotent import commit replay',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ManagedBook' },
              },
            },
          },
          201: {
            description: 'Imported book is now visible with every initial revision',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ManagedBook' },
              },
            },
          },
          401: { description: 'Authentication required' },
          403: { description: 'Author role required' },
          404: { description: 'Import not found' },
          409: { description: 'Import changed, was committed, or fingerprint is stale' },
          422: { description: 'Invalid confirmed structure or idempotency key' },
        },
      },
    },
    '/studio/imports/{importId}/status': {
      parameters: [
        {
          name: 'importId',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^imp-[0-9a-f]{24}$' },
        },
      ],
      get: {
        operationId: 'getEPUBImportStatus',
        summary: 'Read import and deferred knowledge status',
        security: [{ authorBearer: [] }],
        tags: ['Author workspace'],
        responses: {
          200: {
            description: 'Import status; knowledge remains awaiting explicit consent',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ImportPreview' },
              },
            },
          },
          401: { description: 'Authentication required' },
          404: { description: 'Import not found' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      authorBearer: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Existing Go author identity; browser uses signed Better Auth session through Worker',
      },
    },
    schemas,
  },
}
const path = new URL('../harness/contracts/management-api-v1.json', import.meta.url),
  text = JSON.stringify(doc, null, 2) + '\n'
if (process.argv.includes('--check')) {
  if ((await readFile(path, 'utf8').catch(() => '')) !== text)
    throw Error('Managed workspace OpenAPI is stale.')
} else await writeFile(path, text)
