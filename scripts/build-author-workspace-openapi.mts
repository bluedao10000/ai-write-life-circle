import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { workspaceResumeSchema } from '../packages/contracts/src/resume.js'
import { chapterRevisionContentV04Schema } from '../packages/contracts/src/v04.js'
import { reviewAllowanceSchema } from '../packages/contracts/src/billing-review.js'
const extension = {
  schemas: { ReviewAllowance: z.toJSONSchema(reviewAllowanceSchema, { target: 'draft-2020-12' }), ChapterRevisionContent: z.toJSONSchema(chapterRevisionContentV04Schema, { target: 'draft-2020-12' }), WorkspaceResume: z.toJSONSchema(workspaceResumeSchema, { target: 'draft-2020-12' }) },
  paths: {
    '/account': { get: { operationId: 'getAuthorAccount', summary: 'Read current author point balances and account-level review quota', tags: ['Account'],
      responses: { '200': { description: 'Current author account; review allowance resets on UTC calendar months', content: { 'application/json': { schema: { type: 'object', required: ['plan','review'], properties: { plan: { type: 'string', enum: ['free','plus','pro'] }, review: { $ref: '#/components/schemas/ReviewAllowance' } } } } } }, '401': { description: 'Author login required' } },
    } },
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
