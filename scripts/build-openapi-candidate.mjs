import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const sourcePath = fileURLToPath(new URL('../harness/contracts/source/api-spec-v0.4.0-figma-copy.yaml', import.meta.url))
const candidatePath = fileURLToPath(new URL('../harness/contracts/api-spec-v0.4.0-proposed.yaml', import.meta.url))
const source = YAML.parse(await readFile(sourcePath, 'utf8'))

if (source.openapi !== '3.1.0' || source.info?.version !== '0.4.0-proposed') {
  throw new Error('The Figma Make source must be OpenAPI 3.1.0 version 0.4.0-proposed.')
}

const implementedOperationIds = new Set([
  'getWorkspace',
  'updateWorkspaceState',
  'listChapters',
  'getChapter',
  'listChapterRevisions',
  'saveChapterRevision',
])
const summaryFallbacks = {
  listReasoningSessions: 'List reasoning sessions',
  createReasoningSession: 'Create a reasoning session',
  listAgentTasks: 'List agent tasks',
  cancelAgentTask: 'Cancel an agent task',
  retryAgentTask: 'Retry an agent task',
  listProposals: 'List proposals',
  listAudit: 'List audit records',
}
const seenOperationIds = new Set()
const httpMethods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])

for (const pathItem of Object.values(source.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!httpMethods.has(method) || !operation || typeof operation !== 'object') continue
    if (!operation.operationId || seenOperationIds.has(operation.operationId)) {
      throw new Error(`Every operation needs a unique operationId (duplicate/missing: ${operation.operationId ?? 'unknown'}).`)
    }
    seenOperationIds.add(operation.operationId)
    operation['x-implementation-status'] = implementedOperationIds.has(operation.operationId) ? 'implemented' : 'proposed'
    if (!operation.summary && summaryFallbacks[operation.operationId]) operation.summary = summaryFallbacks[operation.operationId]
  }
}

for (const operationId of implementedOperationIds) {
  if (!seenOperationIds.has(operationId)) throw new Error(`Expected implemented operation ${operationId} is missing from the source contract.`)
}

const chapterDetail = source.components?.schemas?.ChapterDetail
const headRevisionOverlay = chapterDetail?.properties?.headRevision?.allOf?.find((schema) => schema.properties)
if (!headRevisionOverlay?.properties?.paragraphs) throw new Error('Expected ChapterDetail.headRevision.paragraphs in source contract.')
delete headRevisionOverlay.properties.paragraphs
headRevisionOverlay.properties.markdown = { type: 'string', description: 'Exact Markdown content; keeps formatting and block structure intact.' }

const chapterRevisionCreate = source.components.schemas.ChapterRevisionCreate
if (!chapterRevisionCreate?.properties?.paragraphs) throw new Error('Expected ChapterRevisionCreate.paragraphs in source contract.')
delete chapterRevisionCreate.properties.paragraphs
chapterRevisionCreate.properties.markdown = {
  type: 'string',
  maxLength: 2097152,
  description: 'TipTap Markdown serialization; preserves paragraph, quote, list, hard-break and inline formatting structure.',
}
chapterRevisionCreate.required = chapterRevisionCreate.required.map((name) => name === 'paragraphs' ? 'markdown' : name)

const problemCodes = source.components.schemas.Problem?.properties?.code?.enum
if (Array.isArray(problemCodes) && !problemCodes.includes('AUDIT_WRITE_FAILED')) problemCodes.push('AUDIT_WRITE_FAILED')
for (const code of ['REVIEW_TRIAL_EXHAUSTED', 'PLAN_QUOTA_EXCEEDED', 'FREE_POOL_EXHAUSTED', 'AI_PAUSED', 'BILLING_RESERVATION_EXPIRED', 'PLAN_FEATURE_REQUIRED', 'REVIEW_CONTEXT_TOO_LARGE', 'REVIEW_EMPTY_CHAPTER', 'REVIEW_REVISION_CHANGED', 'REVIEW_SOURCE_UNAVAILABLE', 'REVIEW_UNAVAILABLE', 'REVIEW_BUSY', 'REVIEW_CONSENT_REQUIRED', 'REVIEW_CONTEXT_CHANGED', 'REVIEW_HISTORY_FULL', 'REVIEW_NOT_COMPLETED', 'REVIEW_NOT_RUNNING', 'REVIEW_VERSION_CONFLICT', 'REVIEW_STORAGE_FAILED']) {
  if (Array.isArray(problemCodes) && !problemCodes.includes(code)) problemCodes.push(code)
}

const auditSchema = source.components.schemas.AuditRecord
if (auditSchema?.properties) {
  auditSchema.properties.correlationId = { type: 'string', description: 'Equals requestId for the complete save attempt.' }
  auditSchema.properties.result = { type: 'string' }
  auditSchema.properties.failureType = { type: 'string', enum: ['validation', 'conflict', 'permission', 'storage', 'not_found'] }
}

source['x-source-provenance'] = {
  file: 'Figma Make docs/contracts/api-spec.yaml',
  fileKey: 'kWBOdcae5utBZ6VtBHHXui',
  retrievedAt: '2026-10-14',
  note: 'The Figma MCP resource response was truncated; the complete source copy was supplied in the author reply in this task and preserved under harness/contracts/source/.',
}

const authorExtension = JSON.parse(await readFile(new URL('../harness/contracts/author-workspace-extension.json', import.meta.url), 'utf8'))
Object.assign(source.paths, authorExtension.paths)
Object.assign(source.components.schemas, authorExtension.schemas)
source.components.schemas.UserWorkspaceState.properties.resume = { $ref: '#/components/schemas/WorkspaceResume' }

const notesExtension = JSON.parse(await readFile(new URL('../harness/contracts/notes-engineering-extension.json', import.meta.url), 'utf8'))
Object.assign(source.paths, notesExtension.paths)
Object.assign(source.components.schemas, notesExtension.schemas)
source.components.schemas.Workspace.properties.capabilities = { $ref: '#/components/schemas/WorkspaceCapabilities' }
source.components.securitySchemes.bearerAuth.description = 'Production: one configured author authenticated by a 256-bit opaque Bearer token over HTTPS; token never comes from query strings or actor headers. Local development identity is development/test only.'
source.tags ??= []
source.tags.push({ name: 'Revisions', description: 'Immutable author-owned Markdown history; recovery uses existing revision CAS.' }, { name: 'Account', description: 'Author point balances and UTC monthly review allowance.' })
source.tags.push({ name: 'Author Notes', description: 'Informal author application state, isolated from Harness facts.' })
for (const code of ['NOTE_VERSION_CONFLICT', 'NEXT_WRITING_EXISTS', 'METHOD_NOT_ALLOWED']) {
  if (Array.isArray(problemCodes) && !problemCodes.includes(code)) problemCodes.push(code)
}
source['x-notes-extension-provenance'] = notesExtension.provenance

const reviewExtension = JSON.parse(await readFile(new URL('../harness/contracts/review-engineering-extension.json', import.meta.url), 'utf8'))
Object.assign(source.paths, reviewExtension.paths)
Object.assign(source.components.schemas, reviewExtension.schemas)
source.tags.push({ name: 'Evidence Review', description: 'Author-triggered, fixed-revision continuity review. Verified quotes are evidence, not verified AI judgments.' })
source['x-review-extension-provenance'] = reviewExtension.provenance

// Read-only authenticated operations for the independent local Agent Worker.
source.tags.push({ name: 'Agent Runtime', description: 'Secret-free local worker status for the authenticated author.' })
source.paths['/agent-runtime'] = { get: {
  operationId: 'getAgentRuntime', 'x-runtime': 'go', summary: 'Read Worker health and task counters', tags: ['Agent Runtime'],
  'x-implementation-status': 'implemented',
  responses: {
    '200': { description: 'Worker heartbeat; online is false after five seconds without a heartbeat.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentRuntimeStatus' } } } },
    '401': { description: 'Authentication required' }, '403': { description: 'Author role required' }, '503': { description: 'Worker status unavailable' },
  },
} }
source.components.schemas.AgentRuntimeStatus = {
  type: 'object', required: ['protocol', 'version', 'instance', 'at', 'online', 'compatible', 'model', 'configFingerprint', 'active', 'tasks'],
  properties: {
    protocol: { type: 'string' }, version: { type: 'string' }, instance: { type: 'string' }, at: { type: 'string' },
    online: { type: 'boolean' }, compatible: { type: 'boolean' }, model: { type: 'object', additionalProperties: { type: 'string' } },
    configFingerprint: { type: 'string', description: 'Public configuration only; excludes the provider credential.' }, active: { type: 'integer', minimum: 0 }, lastSuccessAt: { type: 'string' },
    tasks: { type: 'object', additionalProperties: false, required: ['pending','running','completed','failed','cancelled','retried','interrupted'], properties: Object.fromEntries(['pending','running','completed','failed','cancelled','retried','interrupted'].map(name => [name,{type:'integer',minimum:0}])) },
  }, additionalProperties: false,
}

const runtimeStatus=source.components.schemas.AgentRuntimeStatus;
source.components.schemas.AgentRuntimeCounts=runtimeStatus.properties.tasks;
runtimeStatus.properties.successByKind={type:'object',additionalProperties:{type:'string'}};
runtimeStatus.properties.byKind={type:'object',additionalProperties:{$ref:'#/components/schemas/AgentRuntimeCounts'}};
source.components.schemas.AgentExecutorStatus={...runtimeStatus,required:[...runtimeStatus.required,'executorKind','executorOwner','executorEpoch','ready','draining'],properties:{...runtimeStatus.properties,executorKind:{type:'string',enum:['review','knowledge']},executorOwner:{type:'string',enum:['go','pi','disabled','']},executorEpoch:{type:'integer',minimum:0},ready:{type:'boolean'},draining:{type:'boolean'}}};
runtimeStatus.properties.executors={type:'object',additionalProperties:false,required:['review','knowledge'],properties:{review:{$ref:'#/components/schemas/AgentExecutorStatus'},knowledge:{$ref:'#/components/schemas/AgentExecutorStatus'}}};
runtimeStatus.required.push('executors');

const generated = YAML.stringify(source, { indent: 2, lineWidth: 110 })
if (process.argv.includes('--check')) {
  const existing = await readFile(candidatePath, 'utf8').catch(() => '')
  if (existing !== generated) {
    process.stderr.write('OpenAPI candidate is stale. Run `pnpm openapi:generate` to regenerate it from the versioned source.\n')
    process.exitCode = 1
  }
} else {
  await writeFile(candidatePath, generated, 'utf8')
}
