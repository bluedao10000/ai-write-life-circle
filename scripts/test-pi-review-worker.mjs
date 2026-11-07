import Ajv from 'ajv/dist/2020.js';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import assert from 'node:assert/strict';
import {createPiWorkerFixture,until,sleep} from './lib/pi-worker-fixture.mjs';
const f=await createPiWorkerFixture();
let node,thinking;
async function ready(p,event){await until(()=>{if(p.exitCode!==null)throw Error(p.output);return p.output.includes(event)},event)}
try{
 thinking=f.start('pi');await ready(thinking,'agent_started');const isolated=await f.call('/v1/agent-runtime');assert.equal(isolated.executors.review.ready,false);assert.equal(isolated.executors.knowledge.ready,false);assert.equal(isolated.executors.creative.ready,false);node=f.start('pi-worker');await ready(node,'worker_started');
 // Pi is the default and only background executor.
 let before=f.calls,r=await f.enqueue();const reviewed=await f.complete(r.runId);assert.equal(f.calls,before+1);
 const memoryBase='/v1/studio/books/review-fixture/procedural-memory/evidence';
 const taskEvidence=await until(async()=>(await f.call(memoryBase)).items.find(item=>item.kind==='review.execute'),'completed review task receipt');
 const outcomePath=memoryBase+'/'+taskEvidence.taskId+'/outcome';
 const outcome=await f.call(outcomePath);assert.equal(outcome.basis,'task_result');assert.equal(outcome.total,reviewed.findings.length);assert.deepEqual(outcome.items.map(item=>item.id).sort(),reviewed.findings.map(item=>item.findingId).sort());
 assert(outcome.items.length>0);
 const feedbackRun=await f.call('/v1/projects/review-fixture/reviews/'+r.runId+'/findings/'+reviewed.findings[0].findingId+'/feedback',{method:'POST',body:{choice:'false_positive',baseVersion:reviewed.version}});assert(feedbackRun.version>reviewed.version);
 const feedback=await f.call(outcomePath);assert.notEqual(feedback.version,outcome.version);assert.equal(feedback.items.find(item=>item.id===reviewed.findings[0].findingId).feedback,'false_positive');
 assert.equal(f.calls,before+1);

 for(const scenario of f.cases){await f.select(scenario);r=await f.enqueue();const done=await until(async()=>{const x=await f.get(r.runId);return !['queued','running'].includes(x.status)&&x},scenario.id);assert.equal(done.status,scenario.fake==='invalid'?'failed':'completed');assert.equal(done.findings.length,scenario.fake==='valid'?1:0);if(scenario.fake.startsWith('fake-'))assert.equal(done.rejectedCount,1)}
 assert.ok(f.requests.some(r=>r.stream===true),'Pi SDK must perform real streaming model normalization');
 const status=await f.call('/v1/agent-runtime');const spec=YAML.parse(await readFile(new URL('../harness/contracts/api-spec-v0.4.0-proposed.yaml',import.meta.url),'utf8'));const validate=new Ajv({strict:false}).compile({$ref:'#/components/schemas/AgentRuntimeStatus',components:spec.components});assert.ok(validate(status),JSON.stringify(validate.errors));for(const kind of ['review','knowledge','creative'])assert.equal(status.executors[kind].executorOwner,'pi');
 // Go commits, but the first HTTP acknowledgement is lost; retry is receipt-only.
 await f.select(f.cases[0]);before=f.calls;f.dropCompletion();r=await f.enqueue();await f.complete(r.runId);await until(()=>f.dropped===1,'lost completion acknowledgement');await sleep(500);assert.equal(f.calls,before+1);assert.ok(node.output.includes('task_completed'));
 // Thinking remains responsive while the background Review waits on the model.
 await f.select({...f.cases[0],fake:'slow'});before=f.calls;r=await f.enqueue();await until(()=>f.calls>before,'slow Review started');
 const base='/v1/studio/books/review-fixture/thinking';const model=await f.call(base+'/capabilities');const session=await f.call(base+'/sessions',{method:'POST',status:201,body:{consent:true,model,scopes:['chapters']}});await f.call(base+'/sessions/'+session.sessionId+'/messages',{method:'POST',status:202,body:{text:'简短回答，不读取正文。'}});
 await until(async()=>{const s=await f.call(base+'/sessions/'+session.sessionId);return s.messages.some(m=>m.role==='assistant'&&m.text.includes('合成思考回复'))},'Thinking independent of Review');await f.complete(r.runId);
 // Cancel after started; a late provider response must remain inert.
 before=f.calls;r=await f.enqueue();await until(()=>f.calls>before,'cancel target entered provider');await f.call('/v1/projects/review-fixture/reviews/'+r.runId+'/cancel',{method:'POST',body:{}});await sleep(2100);assert.equal((await f.get(r.runId)).status,'cancelled');
 // API loss aborts the active Provider request. Recovery retries only after the old lease expires.
 await f.select({...f.cases[0],fake:'api-down-slow'});before=f.calls;const disconnected=f.disconnectedRequests;r=await f.enqueue();await until(()=>f.calls>before,'API outage target entered provider');await f.stop(f.api());await until(()=>f.disconnectedRequests>disconnected,'Provider observed cancellation after API loss');await f.expire(r.runId);f.switchOwner('review','disabled');await f.startAPI();const interrupted=await f.get(r.runId);assert.equal(interrupted.status,'queued');assert.equal(interrupted.failureCode,'REVIEW_INTERRUPTED');assert.equal(interrupted.findings.length,0);await sleep(300);assert.equal(f.calls,before+1);f.setMode('valid');f.switchOwner('review','pi');const recovered=await f.complete(r.runId);assert.equal(recovered.findings.length,1);await sleep(2200);assert.equal((await f.get(r.runId)).findings.length,1);assert.equal(f.calls,before+2);
 // Two Node workers race, but one lease is valid.
 await f.select(f.cases[0]);const other=f.start('pi-worker');await ready(other,'worker_started');before=f.calls;r=await f.enqueue();await f.complete(r.runId);assert.equal(f.calls,before+1);await f.stop(other);
 // Node dies after the model started. Only a new lease may eventually commit.
 await f.select({...f.cases[0],fake:'slow'});before=f.calls;r=await f.enqueue();await until(()=>f.calls>before,'crash target entered provider');await f.stop(node,'SIGKILL');await f.expire(r.runId);await f.select(f.cases[0]);node=f.start('pi-worker');await ready(node,'worker_started');await f.complete(r.runId);
 // Go API restart keeps durable receipts and the worker reconnects.
 await f.stop(f.api());await f.startAPI();await until(async()=>{const s=await f.call('/v1/agent-runtime');return s.executors.review.ready},'worker reconnected after API restart');
 // disabled is a maintenance switch, not a second executor; queued work resumes on pi.
 f.switchOwner('review','disabled');assert.equal((await f.call('/v1/agent-runtime')).executors.review.executorOwner,'disabled');before=f.calls;r=await f.enqueue();await sleep(300);assert.equal(f.calls,before);f.switchOwner('review','pi');await f.complete(r.runId);assert.equal((await f.call('/v1/agent-runtime')).executors.review.executorOwner,'pi');
 console.log('PASS: actual Go API + Pi Thinking + Pi Worker; Review cases, evidence rejection, cancellation, API-loss abort and fenced retry, duplicate workers, SIGKILL, API restart, disabled/resume and Thinking isolation. Fixture model only.');
}finally{await f.close()}
