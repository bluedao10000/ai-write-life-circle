import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPiWorkerFixture,until} from './lib/pi-worker-fixture.mjs';
import {thinkingSessionSchema,proceduralRecordSchema} from '../packages/contracts/dist/index.js';
const f=await createPiWorkerFixture({modelBudget:{maxModelCalls:8,maxTokens:200000}});
try{
 const worker=f.start('pi-worker');await until(()=>worker.output.includes('worker_started'),'worker');
 let pi=f.start('pi');await until(()=>pi.output.includes('agent_started'),'thinking');
 const review=await f.enqueue(),reviewed=await f.complete(review.runId);
 const base='/v1/studio/books/review-fixture',root=base+'/thinking',memories=base+'/procedural-memory';
 const evidence=await until(async()=>(await f.call(memories+'/evidence')).items.find(item=>item.kind==='review.execute'),'task receipt');
 const mode=value=>fetch(f.origin+'/control',{method:'POST',body:JSON.stringify({mode:value})});
 const body={consent:true,memoryExtraction:{taskIds:[evidence.taskId]}};
 await f.call(root+'/preferences',{method:'POST',body:{scopes:['creative','knowledge']}});
 await f.call(root+'/sessions',{method:'POST',status:422,body:{...body,consent:false}});
 await f.call(root+'/sessions',{method:'POST',status:422,body:{...body,scopes:['creative']}});
 await f.call(root+'/sessions',{method:'POST',status:404,body,user:{id:'other-author',email:'other@example.com'}});
 async function create(){const s=thinkingSessionSchema.parse(await f.call(root+'/sessions',{method:'POST',status:201,body}));assert.deepEqual(s.scopes,[]);assert.equal(s.memoryExtraction.version,1);return root+'/sessions/'+s.sessionId}
 async function send(path,key=crypto.randomUUID()){return f.call(path+'/messages',{method:'POST',status:202,key,body:{text:'请从选中任务提取可复用的操作经验。'}})}
 async function done(path){return until(async()=>{const s=thinkingSessionSchema.parse(await f.call(path));return s.status==='idle'&&s.run&&s},'extraction completion')}
 const path=await create();
 await f.call(root+'/preferences',{method:'POST',body:{scopes:['chapters']}});
 assert.deepEqual((await f.call(path)).scopes,[]);
 await f.call(path+'/messages',{method:'POST',status:422,body:{text:'提取',modelId:'default'}});
 await mode('memory-extract');const start=f.calls;
 await send(path,'extract-once');const state=await done(path);assert.equal(state.run.status,'completed');
 assert.equal(f.calls,start+1);assert.equal(f.requests.at(-1).tools,undefined);
 const prompt=f.requests.at(-1).messages.find(m=>m.role==='system').content;
 assert(prompt.includes(evidence.taskId));assert(prompt.includes(reviewed.findings[0].findingId));assert(prompt.includes('"type":"chapter"'));
 assert.equal((await f.call(memories)).items.length,0,'model completion alone must not publish memory');
 const candidate=proceduralRecordSchema.parse(await f.call(path+'/memory-candidate',{method:'POST',status:201,body:{runId:state.run.runId}}));
 assert.equal(candidate.status,'candidate');assert.equal(candidate.extractions[0].runId,state.run.runId);assert.equal(candidate.provenance[0].taskId,evidence.taskId);
 assert.equal((await f.call(memories)).items[0].available,false);
 await send(path,'extract-once');assert.equal(f.calls,start+1);
 await f.stop(pi);pi=f.start('pi');await until(()=>pi.output.includes('agent_started'),'thinking restart');
 await f.stop(f.api());await f.startAPI();
 assert.deepEqual(await f.call(path+'/memory-candidate',{method:'POST',status:201,body:{runId:state.run.runId}}),candidate);
 assert.equal(f.calls,start+1,'restart and import replay must not invoke a model');
 for(const value of ['memory-extract-invalid','memory-extract-foreign']){
  await mode(value);const p=await create();await send(p);const s=await done(p);
  await f.call(p+'/memory-candidate',{method:'POST',status:422,body:{runId:s.run.runId}});
 }
 await mode('memory-extract-slow');const cancelled=await create(),before=f.calls;await send(cancelled);await until(()=>f.calls===before+1,'provider entered');
 await f.call(cancelled+'/cancel',{method:'POST',body:{}});const stopped=await done(cancelled);assert.equal(stopped.run.status,'cancelled');
 await f.call(cancelled+'/memory-candidate',{method:'POST',status:403,body:{runId:stopped.run.runId}});
 await until(async()=>Object.values(JSON.parse(await readFile(join(f.state,'thinking','sessions-v1.json'),'utf8')).sessions).every(s=>!s.billOp),'settled completed and cancelled reservations');
 const crashed=await create(),callsBeforeCrash=f.calls;await send(crashed);await until(()=>f.calls===callsBeforeCrash+1,'crash provider entered');
 await f.stop(pi,'SIGKILL');pi=f.start('pi');await until(()=>pi.output.includes('agent_started'),'crash restart');
 const interrupted=await done(crashed);assert.equal(interrupted.run.status,'interrupted');assert(interrupted.usage.incomplete);assert(interrupted.usage.charged>0);assert.equal(f.calls,callsBeforeCrash+1);
 await f.call(crashed+'/memory-candidate',{method:'POST',status:409,body:{runId:interrupted.run.runId}});
 await mode('memory-extract');await f.call(crashed+'/resume',{method:'POST',status:202,body:{runId:interrupted.run.runId,confirmAdditionalCost:true}});
 const recovered=await done(crashed);assert.equal(recovered.run.status,'completed');assert.equal(f.calls,callsBeforeCrash+2);
 const stale=await create();
 await f.call('/v1/projects/review-fixture/reviews/'+review.runId+'/findings/'+reviewed.findings[0].findingId+'/feedback',{method:'POST',body:{choice:'false_positive',baseVersion:reviewed.version}});
 const count=f.calls;await f.call(stale+'/messages',{method:'POST',status:409,body:{text:'提取经验'}});assert.equal(f.calls,count);
 await f.call(path+'/memory-candidate',{method:'POST',status:409,body:{runId:state.run.runId}});
 const changed=(await f.call(memories)).items;assert.equal(changed.length,1);assert.equal(changed[0].unavailableReason,'source_unavailable');
 await f.call(memories+'/'+candidate.id,{method:'POST',status:409,body:{baseVersion:1,action:'confirm'}});
 const rollbackPi=process.argv.find(arg=>arg.startsWith('--rollback-pi='))?.slice('--rollback-pi='.length);
 const rollbackBinary=process.argv.find(arg=>arg.startsWith('--rollback-api='))?.slice('--rollback-api='.length);
 if(rollbackBinary){
  await f.call(memories+'/'+candidate.id,{method:'POST',body:{baseVersion:1,action:'reject'}});
  await until(async()=>Object.values(JSON.parse(await readFile(join(f.state,'thinking','sessions-v1.json'),'utf8')).sessions).every(s=>!s.billOp),'settled reservations before rollback');
  for(const session of (await f.call(root+'/sessions')).items.filter(s=>s.memoryExtraction))await f.call(root+'/sessions/'+session.sessionId,{method:'DELETE',status:204});
  const ledgerBefore=JSON.parse(await readFile(join(f.state,'thinking','sessions-v1.json'),'utf8')).sessions;
  const callCount=f.calls;
  await f.stop(worker);await f.stop(f.api());
  if(rollbackPi){await f.stop(pi);pi=f.start('pi',{},rollbackPi);await until(()=>{if(pi.exitCode!==null)throw Error(pi.output);return pi.output.includes('agent_started')},'prior Pi opens retired storage')}
  await f.startAPI(rollbackBinary);
  assert.equal((await f.call(root+'/sessions')).items.length,0);
  const retired=(await f.call(memories)).items;assert.equal(retired.length,1);assert.equal(retired[0].status,'rejected');assert.equal(retired[0].available,false);
  assert.equal((await f.get(review.runId)).status,'completed');
  const ledgerAfter=JSON.parse(await readFile(join(f.state,'thinking','sessions-v1.json'),'utf8')).sessions;
  for(const [id,record]of Object.entries(ledgerBefore)){assert.equal(ledgerAfter[id].billedPoints,record.billedPoints);assert.equal(ledgerAfter[id].deleted,true)}
  assert.equal(f.calls,callCount);console.log('PASS: prior Go'+(rollbackPi?' and Pi':'')+' binaries read retired extraction state; task receipts and charged points preserved; no model calls.');
 }
 console.log('PASS: governed extraction from real task evidence, zero tools, source/version binding, consent, candidate-only import, provenance, restart/idempotency, invalid output, source expansion and cancellation. Synthetic model only.');
}finally{await f.close()}
