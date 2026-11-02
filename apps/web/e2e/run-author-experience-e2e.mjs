import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createReviewFixture } from '../../../scripts/lib/review-fixture.mjs'
import { preparePiWorker } from '../../../scripts/lib/pi-web-fixture.mjs'
const fixture=await createReviewFixture()
// An isolated local account explicitly starts on Free; no production state or credentials.
await mkdir(join(fixture.state,'billing/accounts'),{recursive:true})
await writeFile(join(fixture.state,'billing/accounts',Buffer.from('local-author').toString('base64url')+'.json'),JSON.stringify({schema:1,actorId:'local-author',plan:'free',month:'',day:'',monthUsed:0,dayUsed:0,open:{},done:{}}))
const pi=await preparePiWorker(fixture,{apiPort:8796,executionEnv:{WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS:'131072'}})
const env={...process.env,...pi.apiEnv}
let api
try {
 api=spawn('../api-go/dist/writer-agent-api',[],{stdio:['ignore','ignore','pipe'],env})
 api.stderr.on('data',d=>process.stderr.write(d))
 for(let i=0;i<150;i++){try{if((await fetch('http://127.0.0.1:8796/healthz')).ok)break}catch{/* API may still be starting. */}if(i===149)throw Error('Author API startup failed');await new Promise(r=>setTimeout(r,100))}
 await pi.startWorker()
 const child=spawn('pnpm',['exec','playwright','test','--config','playwright.author-experience.config.ts'],{stdio:'inherit',env:{...env,WRITER_AGENT_E2E_STATE_DIR:fixture.state,WRITER_AGENT_E2E_HARNESS_ROOT:fixture.harness,WRITER_AGENT_E2E_MODEL_ORIGIN:fixture.origin}})
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal))
 process.exitCode=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('exit',c=>resolve(c??1))})
} finally {
 await pi.stopWorker()
 if(api){api.kill('SIGTERM');await new Promise(resolve=>{if(api.exitCode!==null||api.signalCode!==null)resolve();else api.once('exit',resolve)})}
 await fixture.close()
}
