import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createReviewFixture } from '../../../scripts/lib/review-fixture.mjs'
const fixture=await createReviewFixture()
// An isolated local account explicitly starts on Free; no production state or credentials.
await mkdir(join(fixture.state,'billing/accounts'),{recursive:true})
await writeFile(join(fixture.state,'billing/accounts',Buffer.from('local-author').toString('base64url')+'.json'),JSON.stringify({schema:1,actorId:'local-author',plan:'free',month:'',day:'',monthUsed:0,dayUsed:0,open:{},done:{}}))
const env={...process.env,WRITER_AGENT_ENV:'test',WRITER_AGENT_PROJECT_ID:'review-fixture',WRITER_AGENT_HARNESS_ROOT:fixture.harness,WRITER_AGENT_STATE_DIR:fixture.state,WRITER_AGENT_LLM_PROVIDER:'openai-compatible',WRITER_AGENT_LLM_BASE_URL:fixture.origin+'/v1',WRITER_AGENT_LLM_MODEL:'deterministic-test-only',WRITER_AGENT_LLM_API_KEY:'',WRITER_AGENT_LLM_RESPONSE_FORMAT:'none',WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS:'131072'}
const worker=spawn('../api-go/dist/writer-agent-worker',[],{stdio:['ignore','ignore','pipe'],env})
worker.stderr.on('data',d=>process.stderr.write(d))
try {
 const child=spawn('pnpm',['exec','playwright','test','--config','playwright.author-experience.config.ts'],{stdio:'inherit',env:{...env,WRITER_AGENT_E2E_STATE_DIR:fixture.state,WRITER_AGENT_E2E_HARNESS_ROOT:fixture.harness,WRITER_AGENT_E2E_MODEL_ORIGIN:fixture.origin}})
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal))
 process.exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('exit',c=>resolve(c??1))})
} finally {
 worker.kill('SIGTERM');await new Promise(resolve=>{if(worker.exitCode!==null||worker.signalCode!==null)resolve();else worker.once('exit',resolve)});await fixture.close()
}
