import { spawn } from 'node:child_process'
import { createReviewFixture } from '../../../scripts/lib/review-fixture.mjs'
import { preparePiWorker } from '../../../scripts/lib/pi-web-fixture.mjs'
const fixture=await createReviewFixture()
const pi=await preparePiWorker(fixture,{apiPort:8789})
let api
try {
  api=spawn('../api-go/dist/writer-agent-api',[],{stdio:['ignore','ignore','pipe'],env:{...process.env,...pi.apiEnv}})
  api.stderr.on('data',d=>process.stderr.write(d))
  for(let i=0;i<150;i++){try{if((await fetch('http://127.0.0.1:8789/healthz')).ok)break}catch{/* API may still be starting. */}if(i===149)throw Error('Review API startup failed');await new Promise(r=>setTimeout(r,100))}
  await pi.startWorker()
  const child=spawn('pnpm',['exec','playwright','test','--config','playwright.review.config.ts'],{stdio:'inherit',env:{...process.env,WRITER_AGENT_E2E_STATE_DIR:fixture.state,WRITER_AGENT_E2E_HARNESS_ROOT:fixture.harness,WRITER_AGENT_E2E_MODEL_ORIGIN:fixture.origin}})
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>child.kill(signal))
  process.exitCode=await new Promise((resolve)=>{child.once('error',()=>resolve(1));child.once('exit',(code)=>resolve(code??1))})
} finally {
  await pi.stopWorker()
  if(api){api.kill('SIGTERM');await new Promise(r=>{if(api.exitCode!==null||api.signalCode!==null)r();else api.once('exit',r)})}
  await fixture.close()
}
