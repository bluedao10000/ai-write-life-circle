import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import YAML from 'yaml'
import { createReviewFixture, cases } from './lib/review-fixture.mjs'
import { spawn as spawnWorker } from 'node:child_process'
const live = process.argv.includes('--live')
if (live && !process.argv.includes('--confirm-fixtures')) throw Error('Live evaluation requires --confirm-fixtures to authorize sending only synthetic fixture text.')
// The Go service owns defaults and validation, including key-only DeepSeek setup.
if (live && ![process.env.WRITER_AGENT_LLM_API_KEY, process.env.WRITER_AGENT_LLM_BASE_URL].some(value => value?.trim())) throw Error('Configure WRITER_AGENT_LLM_API_KEY (DeepSeek defaults), or an explicit model endpoint, before live evaluation.')
const fixture = await createReviewFixture()
const worker = spawnWorker(new URL('../apps/api-go/dist/writer-agent-worker', import.meta.url).pathname, [], {
  env: { ...process.env, WRITER_AGENT_ENV: 'test', WRITER_AGENT_PROJECT_ID: 'review-fixture', WRITER_AGENT_AUTHOR_ID: 'writer',
    WRITER_AGENT_HARNESS_ROOT: fixture.harness, WRITER_AGENT_STATE_DIR: fixture.state,
    WRITER_AGENT_LLM_PROVIDER: 'openai-compatible', WRITER_AGENT_LLM_BASE_URL: `${fixture.origin}/v1`,
    WRITER_AGENT_LLM_MODEL: 'deterministic-test-only', WRITER_AGENT_LLM_API_KEY: '', WRITER_AGENT_LLM_RESPONSE_FORMAT: 'none',
    WRITER_AGENT_LLM_TOKEN_PARAMETER: 'max_completion_tokens', WRITER_AGENT_LLM_TIMEOUT_SECONDS: '1' }, stdio: ['ignore','ignore','pipe'],
})
let workerStderr = ''; worker.stderr.on('data', (data) => { workerStderr += data })
if (process.env.REVIEW_DEBUG) worker.stderr.on('data', (data) => process.stderr.write('[worker] '+data))
const schema = YAML.parse(await readFile(new URL('../harness/contracts/api-spec-v0.4.0-proposed.yaml', import.meta.url), 'utf8'))
const ajv = new Ajv({ strict: false }); addFormats(ajv)
const validate = (name, body) => { const check = ajv.compile({ components: schema.components, $ref: `#/components/schemas/${name}` }); assert.ok(check(body), JSON.stringify(check.errors)) }
const child = spawn(new URL('../apps/api-go/dist/writer-agent-api', import.meta.url).pathname, [], {
  env: { ...process.env, WRITER_AGENT_ENV: 'test', WRITER_AGENT_PROJECT_ID: 'review-fixture', WRITER_AGENT_API_PORT: '8790', WRITER_AGENT_HARNESS_ROOT: fixture.harness, WRITER_AGENT_STATE_DIR: fixture.state,
    WRITER_AGENT_LLM_PROVIDER: 'openai-compatible', WRITER_AGENT_LLM_BASE_URL: `${fixture.origin}/v1`, WRITER_AGENT_LLM_MODEL: 'deterministic-test-only', WRITER_AGENT_LLM_API_KEY: '', WRITER_AGENT_LLM_RESPONSE_FORMAT: 'none', WRITER_AGENT_LLM_TOKEN_PARAMETER: 'max_completion_tokens', WRITER_AGENT_LLM_TIMEOUT_SECONDS:'1' }, stdio: ['ignore','ignore','pipe'],
})
let stderr = ''; child.stderr.on('data', (data) => { stderr += data })
const base = 'http://127.0.0.1:8790/v1/projects/review-fixture'
let checks = 0
async function request(path, method = 'GET', body, expected = 200, name, key = crypto.randomUUID()) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type':'application/json', 'Idempotency-Key':key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); if (name) validate(name, value); checks++; return value
}
async function terminal(id) { for (let i=0;i<400;i++) { const run = await request(`/reviews/${id}`, 'GET', undefined, 200, 'ReviewRun'); if (run.status !== 'running' && run.status !== 'queued') return run; await new Promise((r)=>setTimeout(r, live ? 500 : 15)) }; throw Error('Review did not complete') }
async function waitForWorker() { for (let i=0;i<100;i++) { if (worker.exitCode === null) return; await new Promise((r)=>setTimeout(r,50)) }; throw Error('Worker exited: '+workerStderr) }
try {
  await waitForWorker()
  for(let i=0;i<150;i++) { try { if ((await fetch('http://127.0.0.1:8790/healthz')).ok) break } catch {} await new Promise((r)=>setTimeout(r,100)); if(i===149) throw Error('API startup failed: '+stderr) }
  const results = []
  for (const item of cases) {
    await fixture.select(item)
    const before = await fixture.sourceBytes()
    const chapter = await request('/chapters/CH-008')
    const input = { revisionId: chapter.headRevision.revisionId, contentHash: chapter.headRevision.contentHash, reviewTypes: [item.type] }
    const count = fixture.calls
    const plan = await request('/chapters/CH-008/review-preview','POST',input,200,'ReviewPlan')
    assert.equal(fixture.calls,count,'preview must not invoke model')
    await request('/chapters/CH-008/reviews','POST',{...input,consent:{confirmed:false,planHash:plan.planHash}},422,'Problem')
    assert.equal(fixture.calls,count,'missing consent invoked model')
    const key=crypto.randomUUID(), create={...input,consent:{confirmed:true,planHash:plan.planHash}}
    const start=await request('/chapters/CH-008/reviews','POST',create,202,'ReviewRun',key)
    const run=await terminal(start.runId)
    assert.equal((await request('/chapters/CH-008/reviews','POST',create,202,'ReviewRun',key)).runId,run.runId)
    if(!live) {
      assert.equal(run.status,item.fake==='invalid'?'failed':'completed')
      assert.equal(run.findings.length,item.fake==='valid'?1:0)
      if(item.fake.startsWith('fake-')) assert.equal(run.rejectedCount,1)
    }
    for(const finding of run.findings) {
      assert.ok(finding.alternativeExplanation)
      for(const evidence of finding.evidence) assert.ok(run.sources.find((s)=>s.sourceId===evidence.sourceId)?.excerpt.includes(evidence.quote))
    }
    if(!live && item.id==='A-fact-conflict') {
      assert.equal(run.findings[0].anchor.startUTF16,2)
      const path=`/reviews/${run.runId}/findings/${run.findings[0].findingId}/feedback`
      const feedback=await request(path,'POST',{choice:'intentional',baseVersion:run.version},200,'ReviewRun')
      assert.equal((await request(`/reviews/${run.runId}`)).findings[0].feedback.choice,'intentional')
      await request(path,'POST',{choice:'useful',baseVersion:run.version},409,'Problem')
      assert.ok(feedback.version>run.version)
      await fixture.select({...item,history:item.history+'来源已变。'})
      assert.equal((await request(`/reviews/${run.runId}`)).stale,true)
      await fixture.select(item)
    }
    await request('/chapters/CH-008/reviews','GET',undefined,200,'ReviewList')
    assert.deepEqual(await fixture.sourceBytes(),before,'Agent changed source files')
    results.push({ case:item.id, status:run.status, findings:run.findings.length, rejected:run.rejectedCount, ...(live?{candidateReview:'manual scoring required',model:run.model.model,candidateFindings:run.findings,sourceSnapshots:run.sources}:{}) })
  }
  if(!live) {
    await fetch(`${fixture.origin}/control`,{method:'POST',body:JSON.stringify({mode:'slow'})})
    const chapter=await request('/chapters/CH-008'),input={revisionId:chapter.headRevision.revisionId,contentHash:chapter.headRevision.contentHash,reviewTypes:['timeline_consistency']}
    const plan=await request('/chapters/CH-008/review-preview','POST',input)
    const run=await request('/chapters/CH-008/reviews','POST',{...input,consent:{confirmed:true,planHash:plan.planHash}},202)
    await request(`/reviews/${run.runId}/cancel`,'POST',{},200,'ReviewRun')
    assert.equal((await terminal(run.runId)).status,'cancelled')
  }
  console.log(JSON.stringify({ mode:live?'real-model-offline-eval':'deterministic-http-engineering',checks,results,qualityClaim:false },null,2))
} finally {
  child.kill('SIGTERM'); worker.kill('SIGTERM')
  await Promise.race([
    Promise.all([new Promise((r)=>{ if(child.exitCode!==null)r();else child.once('exit',r) }), new Promise((r)=>{ if(worker.exitCode!==null)r();else worker.once('exit',r) })]),
    new Promise((r)=>setTimeout(r,2000)).then(()=>{ child.kill('SIGKILL'); worker.kill('SIGKILL') }),
  ])
  await new Promise((r)=>{ if(child.exitCode!==null)r();else child.once('exit',r) })
  await new Promise((r)=>{ if(worker.exitCode!==null)r();else worker.once('exit',r) })
  await fixture.close()
}
