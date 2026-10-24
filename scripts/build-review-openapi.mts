import { readFile, writeFile } from 'node:fs/promises'
import { reviewJsonSchemas } from '../packages/contracts/src/reviews.js'
const param = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string', minLength: 1 } })
const response = (schema: string) => ({ description: 'Author-scoped evidence review result', content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } } })
function operation(id: string, result: string, params: string[], input?: string, mutation = false) {
  return { operationId: id, summary: id, tags: ['Evidence Review'], 'x-implementation-status': 'implemented', 'x-runtime': 'go',
    'x-required-role': ['author'], parameters: [...params.map(param), ...(mutation ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 128 } }] : [])],
    ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${input}` } } } } } : {}),
    responses: { [id === 'createEvidenceReview' ? '202' : '200']: response(result),
      ...Object.fromEntries([401,403,404,409,422,500,503].map((status) => [status, { description: 'Request refused, unavailable model or application storage failure', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } }])) },
  }
}
const chapter = '/projects/{projectId}/chapters/{chapterId}'
const run = '/projects/{projectId}/reviews/{runId}'
const extension = { provenance: 'Sprint 3 author request: fixed revisions, explicit model consent, verified evidence, author feedback; independent engineering extension, not a Figma source rewrite.',
  paths: {
    [`${chapter}/review-preview`]: { post: operation('previewEvidenceReview', 'ReviewPlan', ['projectId','chapterId'], 'ReviewPreviewInput') },
    [`${chapter}/reviews`]: { get: operation('listEvidenceReviews','ReviewList',['projectId','chapterId']), post: operation('createEvidenceReview','ReviewRun',['projectId','chapterId'],'ReviewCreate',true) },
    [run]: { get: operation('getEvidenceReview','ReviewRun',['projectId','runId']) },
    [`${run}/cancel`]: { post: operation('cancelEvidenceReview','ReviewRun',['projectId','runId'],undefined,true) },
    [`${run}/findings/{findingId}/feedback`]: { post: operation('feedbackEvidenceReview','ReviewRun',['projectId','runId','findingId'],'ReviewFeedbackInput',true) },
  }, schemas: reviewJsonSchemas }
const generated = `${JSON.stringify(extension,null,2)}\n`
const path = new URL('../harness/contracts/review-engineering-extension.json', import.meta.url)
if (process.argv.includes('--check')) {
  if (await readFile(path,'utf8').catch(()=>'') !== generated) throw new Error('Review contract extension is stale. Run pnpm openapi:generate.')
 } else await writeFile(path,generated)
const candidateSchema = { ...reviewJsonSchemas.ReviewCandidate } as Record<string, unknown>
delete candidateSchema.$schema
const schemaText = `${JSON.stringify(candidateSchema, null, 2)}\n`
const schemaPath = new URL('../apps/api-go/internal/review/candidate.schema.json', import.meta.url)
if (process.argv.includes('--check')) {
  if (await readFile(schemaPath, 'utf8').catch(() => '') !== schemaText) throw new Error('Embedded review schema is stale.')
} else await writeFile(schemaPath, schemaText)

