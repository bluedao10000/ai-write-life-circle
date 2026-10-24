// Real OS-process fault injection. Only temporary synthetic sources and loopback HTTP.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createReviewFixture, cases } from './lib/review-fixture.mjs'
const fixture=await createReviewFixture()
const processes=new Set()
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const env={...process.env,NODE_ENV:'test',WRITER_AGENT_ENV:'test',WRITER_AGENT_AUTH_MODE:'local',WRITER_AGENT_AUTHOR_ID:'local-author',WRITER_AGENT_PROJECT_ID:'review-fixture',WRITER_AGENT_API_HOST:'127.0.0.1',WRITER_AGENT_API_PORT:'0',WRITER_AGENT_HARNESS_ROOT:fixture.harness,WRITER_AGENT_STATE_DIR:fixture.state,WRITER_AGENT_LLM_PROVIDER:'openai-compatible',WRITER_AGENT_LLM_BASE_URL:fixture.origin+'/v1',WRITER_AGENT_LLM_MODEL:'deterministic-test-only',WRITER_AGENT_LLM_API_KEY:'',WRITER_AGENT_LLM_RESPONSE_FORMAT:'none',WRITER_AGENT_LLM_TOKEN_PARAMETER:'max_completion_tokens',WRITER_AGENT_LLM_TIMEOUT_SECONDS:'2'}
function start(kind,overrides={}){
 const p=spawn(new URL(`../apps/api-go/dist/writer-agent-${kind}`,import.meta.url).pathname,[],{env:{...env,...overrides},stdio:['ignore','pipe','pipe']});processes.add(p);p.output='';p.stdout.on('data',d=>{p.output+=d});p.stderr.on('data',d=>{p.output+=d});return p
}
async function stop(p,signal='SIGTERM'){
 if(p.exitCode!==null||p.signalCode!==null)return
 const done=new Promise(r=>p.once('exit',r));p.kill(signal);const timer=setTimeout(()=>p.kill('SIGKILL'),6000);try{await done}finally{clearTimeout(timer);processes.delete(p)}
}
async function until(fn,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await pause(40)}throw Error('Timeout: '+label)}
let api,origin
async function startAPI(){api=start('api');origin=await until(()=>api.output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1],'API startup')}
async function req(path,method='GET',body){const res=await fetch(origin+path,{method,headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await res.json();assert.ok(res.ok,JSON.stringify(value));return value}
const base='/v1/projects/review-fixture'
const detail=()=>req(base+'/chapters/CH-008')
const get=id=>req(base+'/reviews/'+id)
async function enqueue(){const c=await detail();const input={revisionId:c.headRevision.revisionId,contentHash:c.headRevision.contentHash,reviewTypes:['character_consistency']};const plan=await req(base+'/chapters/CH-008/review-preview','POST',input);return req(base+'/chapters/CH-008/reviews','POST',{...input,consent:{confirmed:true,planHash:plan.planHash}})}
async function completed(id){return until(async()=>{const r=await get(id);if(r.status==='failed')throw Error(JSON.stringify(r.failureCode));return r.status==='completed'&&r},'completed')}
const store=join(fixture.state,'review-runs',Buffer.from('review-fixture').toString('base64url')+'.json')
async function expire(id){const st=JSON.parse(await readFile(store,'utf8'));st.runs[id].deadlineAt=new Date(Date.now()-1000).toISOString();await writeFile(store+'.test',JSON.stringify(st));await rename(store+'.test',store)}
const sourceBytes=await fixture.sourceBytes()
try{
 await startAPI()
 let r=await enqueue();assert.equal(r.status,'queued');assert.equal(fixture.calls,0)
 await expire(r.runId) // Old creation deadline must not expire a never-claimed task.
 assert.equal((await get(r.runId)).status,'queued')
 const c=await detail();await req(base+'/chapters/CH-008/revisions','POST',{baseRevisionId:c.headRevision.revisionId,markdown:c.headRevision.markdown})
 await stop(api);await startAPI();assert.equal((await get(r.runId)).status,'queued')
 let w=start('worker');await completed(r.runId);assert.equal(fixture.calls,1);await stop(w)
 // A new model cannot reuse the author's previous disclosure.
 r=await enqueue();const before=fixture.calls;w=start('worker',{WRITER_AGENT_LLM_MODEL:'unapproved-model'})
 await until(async()=>(await get(r.runId)).status==='failed','config failure');assert.equal(fixture.calls,before);await stop(w)
 // Two OS workers race to claim: one model call and one result version.
 r=await enqueue();const n=fixture.calls;w=start('worker');let w2=start('worker');await completed(r.runId);assert.equal(fixture.calls,n+1);await stop(w);await stop(w2)
 // Kill after durable claim and during model I/O; reclaim only after lease expiry.
 await fetch(fixture.origin+'/control',{method:'POST',body:JSON.stringify({mode:'slow'})})
 r=await enqueue();const count=fixture.calls;w=start('worker');await until(()=>fixture.calls>count,'model entered');await stop(w,'SIGKILL');await expire(r.runId)
 await fixture.select(cases[0]);w=start('worker');const recovered=await completed(r.runId);assert.equal(recovered.status,'completed');await stop(w)
 let st=JSON.parse(await readFile(store,'utf8'));assert.equal(st.runs[r.runId].attempts,2)
 // Old process is paused in model I/O; its eventual response cannot overwrite the new lease.
 await fetch(fixture.origin+'/control',{method:'POST',body:JSON.stringify({mode:'slow'})})
 r=await enqueue();const prior=fixture.calls;w=start('worker');await until(()=>fixture.calls>prior,'old worker entered');w.kill('SIGSTOP');await expire(r.runId)
 await fixture.select(cases[0]);w2=start('worker');const winner=await completed(r.runId);w.kill('SIGCONT');await pause(2200);assert.equal((await get(r.runId)).version,winner.version);await stop(w);await stop(w2)
 // Cancel after the real HTTP model request began, rather than while queued.
 await fetch(fixture.origin+'/control',{method:'POST',body:JSON.stringify({mode:'slow'})})
 r=await enqueue();const calls=fixture.calls;w=start('worker');await until(()=>fixture.calls>calls,'cancel model entered');await req(base+'/reviews/'+r.runId+'/cancel','POST',{});await pause(2200);assert.equal((await get(r.runId)).status,'cancelled');await stop(w)
 const status=await req('/v1/agent-runtime');assert.equal(status.online,false);assert.ok(!JSON.stringify(status).includes(c.headRevision.markdown))
 assert.deepEqual(await fixture.sourceBytes(),sourceBytes)
 console.log('Agent Runtime: offline queue, save, API restart, config refusal, duplicate workers, SIGKILL recovery, old lease fencing, cross-process cancellation and heartbeat passed.')
}finally{for(const p of processes){p.kill('SIGCONT');await stop(p)}await fixture.close()}
