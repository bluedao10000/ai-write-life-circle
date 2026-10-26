import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { workspaceResumeSchema } from '../packages/contracts/src/resume.js'
import { chapterRevisionContentV04Schema } from '../packages/contracts/src/v04.js'
const extension = {
  schemas: { ChapterRevisionContent: z.toJSONSchema(chapterRevisionContentV04Schema, { target: 'draft-2020-12' }), WorkspaceResume: z.toJSONSchema(workspaceResumeSchema, { target: 'draft-2020-12' }) },
  paths: {
    '/projects/{projectId}/chapters/{chapterId}/revisions/{revisionId}': {
      get: { operationId: 'getChapterRevisionContent', summary: 'Read immutable author-owned revision content', tags: ['Revisions'], 'x-required-role': ['author'],
        parameters: ['projectId','chapterId','revisionId'].map((name) => ({ name, in: 'path', required: true, schema: { type: 'string', minLength: 1 } })),
        responses: { '200': { description: 'Verified historical Markdown without private receipts', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChapterRevisionContent' } } } },
          ...Object.fromEntries([401,403,404].map((status) => [status, { description: 'Not authorized or not found' }])) },
      },
    },
  },
}
const output = JSON.stringify(extension, null, 2) + '\n'
const path = 'harness/contracts/author-workspace-extension.json'
if (process.argv.includes('--check')) { if (await readFile(path, 'utf8') !== output) throw Error('Author workspace contract drift') }
else await writeFile(path, output)
