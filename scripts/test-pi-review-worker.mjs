import Ajv from 'ajv/dist/2020.js';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import assert from 'node:assert/strict';
import {createPiWorkerFixture,until,sleep} from './lib/pi-worker-fixture.mjs';
const f=await createPiWorkerFixture();
let node,go,thinking;
async function ready(p,event){await until(()=>{if(p.exitCode!==null)throw Error(p.output);return p.output.includes(event)},event)}
try{
 thinking=f.start('pi');await ready(thinking,'agent_started');const isolated=await f.call('/v1/agent-runtime');assert.equal(isolated.executors.review.ready,false);assert.equal(isolated.executors.knowledge.ready,false);go=f.start('worker');node=f.start('pi-worker');await ready(node,'worker_started');
 // All four processes are alive, but default Go alone executes.
 let before=f.calls,r=await f.enqueue();await f.complete(r.runId);assert.equal(f.calls,before+1);
 const legacy=[];
 for(const scenario of f.cases){await f.select(scenario);const run=await f.enqueue();const done=await until(async()=>{const x=await f.get(run.runId);return !['queued','running'].includes(x.status)&&x},'Go '+scenario.id);legacy.push(done)}
 f.switchOwner('review','pi');
 const runs=[];
 for(const scenario of f.cases){await f.select(scenario);r=await f.enqueue();const done=await until(async()=>{const x=await f.get(r.runId);return !['queued','running'].includes(x.status)&&x},scenario.id);assert.equal(done.status,scenario.fake==='invalid'?'failed':'completed');assert.equal(done.findings.length,scenario.fake==='valid'?1:0);if(scenario.fake.startsWith('fake-'))assert.equal(done.rejectedCount,1);runs.push(done)}
 for(let i=0;i<runs.length;i++){for(const field of ['status','failureCode','usage','rejectedCount'])assert.deepEqual(runs[i][field],legacy[i][field],'Go/Pi contract mismatch: '+field+' '+f.cases[i].id);assert.equal(runs[i].findings.length,legacy[i].findings.length)}
 assert.ok(f.requests.some(r=>r.stream===true),'Pi SDK must perform real streaming model normalization');
 const status=await f.call('/v1/agent-runtime');const spec=YAML.parse(await readFile(new URL('../harness/contracts/api-spec-v0.4.0-proposed.yaml',import.meta.url),'utf8'));const validate=new Ajv({strict:false}).compile({$ref:'#/components/schemas/AgentRuntimeStatus',components:spec.components});assert.ok(validate(status),JSON.stringify(validate.errors));assert.equal(status.executors.review.executorOwner,'pi');assert.equal(status.executors.knowledge.executorOwner,'go');
 // Go commits, but the first HTTP acknowledgement is lost; retry is receipt-only.
 await f.select(f.cases[0]);before=f.calls;f.dropCompletion();r=await f.enqueue();await f.complete(r.runId);await until(()=>f.dropped===1,'lost completion acknowledgement');await sleep(500);assert.equal(f.calls,before+1);assert.ok(node.output.includes('task_completed'));
 // Thinking remains responsive while the background Review waits on the model.
 await f.select({...f.cases[0],fake:'slow'});before=f.calls;r=await f.enqueue();await until(()=>f.calls>before,'slow Review started');
 const base='/v1/studio/books/review-fixture/thinking';const model=await f.call(base+'/capabilities');const session=await f.call(base+'/sessions',{method:'POST',status:201,body:{consent:true,model,scopes:['chapters']}});await f.call(base+'/sessions/'+session.sessionId+'/messages',{method:'POST',status:202,body:{text:'简短回答，不读取正文。'}});
 await until(async()=>{const s=await f.call(base+'/sessions/'+session.sessionId);return s.messages.some(m=>m.role==='assistant'&&m.text.includes('合成思考回复'))},'Thinking independent of Review');await f.complete(r.runId);
 // Cancel after started; a late provider response must remain inert.
 before=f.calls;r=await f.enqueue();await until(()=>f.calls>before,'cancel target entered provider');await f.call('/v1/projects/review-fixture/reviews/'+r.runId+'/cancel',{method:'POST',body:{}});await sleep(2100);assert.equal((await f.get(r.runId)).status,'cancelled');
 // Two Node workers race, but one lease is valid.
 await f.select(f.cases[0]);const other=f.start('pi-worker');await ready(other,'worker_started');before=f.calls;r=await f.enqueue();await f.complete(r.runId);assert.equal(f.calls,before+1);await f.stop(other);
 // Node dies after the model started. Only a new lease may eventually commit.
 await f.select({...f.cases[0],fake:'slow'});before=f.calls;r=await f.enqueue();await until(()=>f.calls>before,'crash target entered provider');await f.stop(node,'SIGKILL');await f.stop(go);await f.expire(r.runId);await f.select(f.cases[0]);node=f.start('pi-worker');await ready(node,'worker_started');await f.complete(r.runId);
 // Go API restart keeps durable receipts and the worker reconnects.
 await f.stop(f.api());await f.startAPI();await until(async()=>{const s=await f.call('/v1/agent-runtime');return s.executors.review.ready},'worker reconnected after API restart');
 f.switchOwner('review','go');go=f.start('worker');r=await f.enqueue();await f.complete(r.runId);const final=await f.call('/v1/agent-runtime');assert.equal(final.executors.review.executorOwner,'go');
 console.log('PASS: actual Go API + Go Worker + Pi Thinking + Pi Worker; Review cases, evidence rejection, distinct ownership, cancellation, duplicate workers, SIGKILL, API restart, rollback and Thinking isolation. Fixture model only.');
}finally{await f.close()}
