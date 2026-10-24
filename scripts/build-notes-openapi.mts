import { readFile, writeFile } from 'node:fs/promises'
import { notesJsonSchemas } from '../packages/contracts/src/notes.js'

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const response = (name: string) => ({
  description: 'Successful author note operation',
  content: { 'application/json': { schema: ref(name) } },
})
const parameter = (name: string, location: string) => ({
  name,
  in: location,
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    ...(name === 'Idempotency-Key' ? { maxLength: 128, pattern: '^[A-Za-z0-9._:-]{1,128}$' } : {}),
  },
})
function operation(
  operationId: string,
  schema: string,
  mutation?: 'create' | 'update',
  detail = false,
) {
  return {
    operationId,
    summary: operationId,
    tags: ['Author Notes'],
    'x-implementation-status': 'implemented',
    'x-design-status': 'engineering-extension',
    'x-required-role': ['author'],
    description:
      'Author-only, project-scoped application notes. No Harness or canon writes. Server-authenticated author: production bearer token or local development identity.',
    parameters: [
      parameter('projectId', 'path'),
      ...(detail ? [parameter('noteId', 'path')] : []),
      ...(mutation ? [parameter('Idempotency-Key', 'header')] : []),
    ],
    ...(mutation
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: ref(mutation === 'create' ? 'NoteCreate' : 'NoteUpdate'),
              },
            },
          },
        }
      : {}),
    responses: {
      [mutation === 'create' ? '201' : '200']: response(schema),
      ...Object.fromEntries(
        [401, 403, 404, 405, 409, 422, 500].map((code) => [
          String(code),
          {
            description: 'Request rejected or application storage failed; preserve local input.',
            content: { 'application/problem+json': { schema: ref('Problem') } },
          },
        ]),
      ),
    },
  }
}
const schemas = Object.fromEntries(
  Object.entries(notesJsonSchemas).map(([name, schema]) => {
    const { $schema: dialect, ...rest } = schema
    void dialect
    return [name, rest]
  }),
)
const extension = {
  provenance:
    '2026-10-14 author task: minimum persistent notes. VNext local export supplied by author; Figma API YAML is semantically unchanged. Engineering extension, not a Figma API source copy.',
  paths: {
    '/projects/{projectId}/notes': {
      get: operation('listAuthorNotes', 'NoteList'),
      post: operation('createAuthorNote', 'AuthorNote', 'create'),
    },
    '/projects/{projectId}/notes/{noteId}': {
      get: operation('getAuthorNote', 'AuthorNote', undefined, true),
      patch: operation('updateAuthorNote', 'AuthorNote', 'update', true),
    },
  },
  schemas,
}
const path = new URL('../harness/contracts/notes-engineering-extension.json', import.meta.url)
const text = `${JSON.stringify(extension, null, 2)}\n`
if (process.argv.includes('--check')) {
  if ((await readFile(path, 'utf8').catch(() => '')) !== text)
    throw new Error('Notes contract is stale: pnpm openapi:generate')
} else await writeFile(path, text)
