import { spawn } from 'node:child_process'
import { createReviewFixture } from '../../../scripts/lib/review-fixture.mjs'
const fixture=await createReviewFixture()
const worker=spawn('../api-go/dist/writer-agent-worker',[],{stdio:['ignore','ignore','pipe'],env:{...process.env,WRITER_AGENT_ENV:'test',WRITER_AGENT_PROJECT_ID:'review-fixture',WRITER_AGENT_HARNESS_ROOT:fixture.harness,WRITER_AGENT_STATE_DIR:fixture.state,WRITER_AGENT_LLM_PROVIDER:'openai-compatible',WRITER_AGENT_LLM_BASE_URL:`${fixture.origin}/v1`,WRITER_AGENT_LLM_MODEL:'deterministic-test-only',WRITER_AGENT_LLM_API_KEY:'',WRITER_AGENT_LLM_RESPONSE_FORMAT:'none'}})
worker.stderr.on('data',d=>process.stderr.write(d))
try {
  const child=spawn('pnpm',['exec','playwright','test','--config','playwright.review.config.ts'],{stdio:'inherit',env:{...process.env,WRITER_AGENT_E2E_STATE_DIR:fixture.state,WRITER_AGENT_E2E_HARNESS_ROOT:fixture.harness,WRITER_AGENT_E2E_MODEL_ORIGIN:fixture.origin}})
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>child.kill(signal))
  process.exitCode=await new Promise((resolve)=>{child.once('error',()=>resolve(1));child.once('exit',(code)=>resolve(code??1))})
} finally { worker.kill('SIGTERM'); await new Promise(r=>{if(worker.exitCode!==null||worker.signalCode!==null)r();else worker.once('exit',r)});await fixture.close() }
