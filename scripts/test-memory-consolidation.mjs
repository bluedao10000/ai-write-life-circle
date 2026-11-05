import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPiWorkerFixture,sleep,until} from './lib/pi-worker-fixture.mjs';
import {proceduralListSchema,agentTaskDiagnosticsSchema} from '../packages/contracts/dist/index.js';

const f=await createPiWorkerFixture({modelBudget:{maxModelCalls:10,maxTokens:240000}});
let worker;
try{
 worker=f.start('pi-worker');
 await until(()=>worker.output.includes('worker_started'),'memory consolidation worker');
 const base='/v1/studio/books/review-fixture',memories=base+'/procedural-memory';
 await f.select(f.cases[0]);
 async function review(type){
  const queued=await f.enqueue([type]);
  return f.complete(queued.runId);
 }
 await review('character_consistency');
 await review('timeline_consistency');
 const evidence=await until(async()=>{
  const value=await f.call(memories+'/evidence');
  return value.items.filter(item=>item.kind==='review.execute').length===2&&value;
 },'two completed Review receipts');
 const evidenceOutcomes=[];
 for(const item of evidence.items.filter(item=>item.kind==='review.execute')){
  evidenceOutcomes.push(await f.call(`${memories}/evidence/${item.taskId}/outcome`));
 }
 assert.equal(evidenceOutcomes.length,2);
 assert(evidenceOutcomes.every(item=>item.items.length===1));
 const overview=await f.call(base+'/creative');
 await f.call(base+'/creative/settings/enable',{method:'POST',body:{
  consent:true,model:overview.settings.currentModel,
  dailyTokenBudget:100000000,dailyJobBudget:200,
  autoOrganize:false,multiAgentPlanCheck:false,autoMemoryConsolidation:true,
 }});
 const callsBefore=f.calls,consolidationsBefore=f.consolidationCalls;
 const items=await until(async()=>{
  const value=proceduralListSchema.parse(await f.call(memories)).items;
  return value.length===1&&value;
 },'background memory candidate',30000);
 assert.equal(items.length,1);
 const candidate=items[0];
 assert.equal(candidate.status,'candidate');
 assert.equal(candidate.available,false);
 assert.equal(candidate.unavailableReason,'not_confirmed');
 assert.equal(candidate.extractions.length,1);
 assert.equal(candidate.extractions[0].promptVersion,'memory-consolidation-v1');
 assert.equal(candidate.extractions[0].runId.length>0,true);
 assert.equal(candidate.extractions[0].sources.length,2);
 assert.equal(f.consolidationCalls,consolidationsBefore+1);
 assert.equal(f.calls,callsBefore+1);
 const request=f.requests.at(-1);
 assert.equal(request.tools,undefined);
 const sourceIDs=candidate.extractions[0].sources.map(source=>source.taskId);
 assert.equal(new Set(sourceIDs).size,2);
 assert.deepEqual(new Set(candidate.provenance.map(item=>item.taskId)),new Set(sourceIDs));
 for(const source of candidate.extractions[0].sources){
  const original=await f.call(`${memories}/evidence/${source.taskId}`);
  const outcome=await f.call(`${memories}/evidence/${source.taskId}/outcome`);
  assert.equal(source.resultVersion,outcome.version);
  assert.equal(original.evidence.taskId,source.taskId);
  assert.equal(outcome.evidence.taskId,source.taskId);
 }

 const completedCalls=f.calls,completedConsolidations=f.consolidationCalls;
 await f.stop(worker);
 await f.stop(f.api());
 await f.startAPI();
 worker=f.start('pi-worker');
 await until(()=>worker.output.includes('worker_started'),'memory worker restart');
 await sleep(1200);
 const replayed=proceduralListSchema.parse(await f.call(memories)).items;
 assert.equal(replayed.length,1);
 assert.equal(replayed[0].id,candidate.id);
 assert.equal(f.calls,completedCalls);
 assert.equal(f.consolidationCalls,completedConsolidations);

 await f.call(base+'/creative/settings/memory',{method:'POST',body:{autoMemoryConsolidation:false}});
 const disabledCalls=f.calls;
 await review('character_consistency');
 await review('timeline_consistency');
 await sleep(1200);
 assert.equal(f.calls,disabledCalls+2,'only the two Reviews may call the provider while consolidation is disabled');
 assert.equal(f.consolidationCalls,completedConsolidations);
 assert.equal(proceduralListSchema.parse(await f.call(memories)).items.length,1);
 // Revoking consent during a sent request must stop publication while
 // retaining unknown costs and allowing a terminal failure receipt.
 const budgetBeforeRevocation=(await f.call(base+'/creative')).settings.budgetTokens;
 await f.select({...f.cases[0],fake:'memory-consolidation-slow'});
 await f.call(base+'/creative/settings/memory',{method:'POST',body:{autoMemoryConsolidation:true}});
 await until(()=>f.consolidationCalls===completedConsolidations+1,'slow consolidation entered provider');
 await f.call(base+'/creative/settings/memory',{method:'POST',body:{autoMemoryConsolidation:false}});
 const failed=await until(async()=>{
  const records=JSON.parse(await readFile(join(f.state,'agent-runtime','tasks-v1.json'),'utf8')).tasks;
  return Object.values(records).find(record=>record.task.kind==='memory.consolidate'&&record.finished&&record.outcome==='failed');
 },'revoked consolidation terminal receipt');
 assert.equal(failed.started,true);
 assert.equal((await f.call(base+'/creative')).settings.budgetTokens,budgetBeforeRevocation+failed.memory.reservedTokens,'unknown usage must retain the full reservation');
 assert.equal(failed.memory.request.input,'');
 assert.equal(proceduralListSchema.parse(await f.call(memories)).items.length,1);
 const finalCalls=f.calls;
 await sleep(2000);
 assert.equal(f.calls,finalCalls,'revocation must not retry the model');
 // Kill the Worker after the provider receives a new source group.
 await f.select(f.cases[0]);
 await review('character_consistency');
 await review('timeline_consistency');
 const crashBudget=(await f.call(base+'/creative')).settings.budgetTokens;
 const beforeCrash=f.consolidationCalls;
 await f.select({...f.cases[0],fake:'memory-consolidation-slow'});
 await f.call(base+'/creative/settings/memory',{method:'POST',body:{autoMemoryConsolidation:true}});
 await until(()=>f.consolidationCalls===beforeCrash+1,'crash target entered provider');
 await f.stop(worker,'SIGKILL');
 const crashCalls=f.calls;
 worker=f.start('pi-worker');
 await until(()=>worker.output.includes('worker_started'),'Worker restarted after SIGKILL');
 const interrupted=await until(async()=>{
  const records=JSON.parse(await readFile(join(f.state,'agent-runtime','tasks-v1.json'),'utf8')).tasks;
  return Object.values(records).find(record=>record.task.kind==='memory.consolidate'&&record.outcome==='interrupted'&&record.finished);
 },'crashed consolidation expired',25000);
 assert.equal(interrupted.started,true);
 const diagnosticResponse=await fetch(f.taskOrigin+'/internal/v1/agent/tasks/'+interrupted.task.taskId+'/diagnostics',{headers:{authorization:'Bearer '+f.keys.task}});
 assert.equal(diagnosticResponse.status,200);
 const diagnostic=agentTaskDiagnosticsSchema.parse(await diagnosticResponse.json());
 assert.equal(diagnostic.outcome,'interrupted');
 assert.deepEqual(diagnostic.audit.map(event=>event.action),['claimed','started','terminal']);
 assert.equal(diagnostic.audit.at(-1).reason,'TASK_DEADLINE_EXPIRED');
 assert.deepEqual(diagnostic.sourceTaskIds,interrupted.memory.sources.map(source=>source.taskId));
 assert.equal(diagnostic.completedAt,interrupted.completedAt);
 assert(!JSON.stringify(diagnostic).includes(interrupted.task.leaseToken));
 assert.equal(interrupted.task.request.input,'');
 assert.equal(interrupted.memory.request.input,'');
 assert.equal((await f.call(base+'/creative')).settings.budgetTokens,crashBudget+interrupted.memory.reservedTokens);
 assert.equal(proceduralListSchema.parse(await f.call(memories)).items.length,1);
 assert.equal(f.calls,crashCalls,'SIGKILL must not replay a paid model call');
 const runtime=await until(async()=>{
  const value=await f.call('/v1/agent-runtime');
  return value.executors.memory.tasks.interrupted===1&&value;
 },'memory interruption health');
 assert.equal(runtime.executors.memory.tasks.running,0);
 console.log('PASS: real Go AgentTask queue + Pi Worker produced one background candidate from two independent completed Reviews, with exact source/result bindings, one tool-free model call, restart idempotency, in-flight revocation, SIGKILL interruption, retained unknown costs and disabled-setting behavior. Synthetic model only.');
}catch(error){
 if(worker)console.error(worker.output);
 try{
  const tasks=JSON.parse(await readFile(join(f.state,'agent-runtime','tasks-v1.json'),'utf8')).tasks;
  console.error(JSON.stringify({tasks:Object.values(tasks).map(record=>({kind:record.task.kind,outcome:record.outcome,finished:record.finished,inputHash:record.task.inputHash,memory:record.memory??null}))}));
  const creative=JSON.parse(await readFile(join(f.state,'creative',Buffer.from('review-fixture').toString('base64url'),'state-v1.json'),'utf8'));
  console.error(JSON.stringify({settings:creative.settings,budgetDay:creative.budgetDay,budgetTokens:creative.budgetTokens}));
 }catch{}
 throw error;
}finally{
 if(worker)await f.stop(worker);
 await f.close();
}
