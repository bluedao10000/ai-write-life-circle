import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPiWorkerFixture,until,sleep} from './pi-worker-fixture.mjs';

export async function executeConsolidationEvaluation(task,signal,result){
 const f=await createPiWorkerFixture({modelBudget:{maxModelCalls:task.stoppingCriteria.maxModelCalls,maxTokens:task.stoppingCriteria.maxTokens}});
 let worker;
 const cancel=()=>worker?.kill('SIGTERM');
 signal.addEventListener('abort',cancel,{once:true});
 try{
  signal.throwIfAborted();
  worker=f.start('pi-worker');
  await until(()=>worker.output.includes('worker_started'),'consolidation eval Worker');
  const original=await f.sourceBytes(),base='/v1/studio/books/review-fixture',memory=base+'/procedural-memory';
  await f.select(f.cases[0]);
  const reviews=[];
  for(const type of ['character_consistency','timeline_consistency']){
   signal.throwIfAborted();
   const queued=await f.enqueue([type]);reviews.push(await f.complete(queued.runId));
  }
  const overview=await f.call(base+'/creative');
  const before=f.calls,revoked=task.environment.scenario==='consolidation-revoked',crashed=task.environment.scenario==='consolidation-crash';
  if(revoked||crashed)await f.select({...f.cases[0],fake:'memory-consolidation-slow'});
  await f.call(base+'/creative/settings/enable',{method:'POST',body:{consent:true,model:overview.settings.currentModel,dailyTokenBudget:1000000,dailyJobBudget:10,autoOrganize:false,multiAgentPlanCheck:false,autoMemoryConsolidation:true}});
  await until(()=>f.consolidationCalls===1,'consolidation model request');
  if(revoked)await f.call(base+'/creative/settings/memory',{method:'POST',body:{autoMemoryConsolidation:false}});
  if(crashed){
   await f.stop(worker,'SIGKILL');
   worker=f.start('pi-worker');
   await until(()=>worker.output.includes('worker_started'),'consolidation Worker restart');
  }
  const record=await until(async()=>{
   signal.throwIfAborted();
   const records=JSON.parse(await readFile(join(f.state,'agent-runtime','tasks-v1.json'),'utf8')).tasks;
   return Object.values(records).find(item=>item.task.kind==='memory.consolidate'&&item.finished);
  },'consolidation terminal receipt',25000);
  const stored=(await f.call(memory)).items,request=f.requests.at(-1),payload=JSON.stringify(request);
  const bindings=record.memory.sources;
  let bound=bindings.length===2;
  for(const source of bindings){
   const outcome=await f.call(`${memory}/evidence/${source.taskId}/outcome`);
   bound=bound&&outcome.version===source.resultVersion&&payload.includes(source.taskId);
  }
  const budget=(await f.call(base+'/creative')).settings.budgetTokens;
  const afterCalls=f.calls;
  await sleep(2100);signal.throwIfAborted();
  const after=await f.sourceBytes();
  result.metrics={sourceTasksCompleted:reviews.every(item=>item.status==='completed'),boundSources:bound,zeroTools:!request.tools?.length,oneConsolidationCall:f.consolidationCalls===1&&afterCalls-before===1,noAutomaticRetry:f.calls===afterCalls,contextScrubbed:record.memory.request.input===''&&record.task.request.input==='',sourceUnchanged:original.every((value,index)=>value===after[index]),candidateOnly:stored.length===1&&stored[0].status==='candidate'&&!stored[0].available,provenanceValid:stored.length===1&&stored[0].extractions[0].runId===record.task.taskId&&stored[0].extractions[0].sources.length===2,terminalFailed:record.outcome==='failed',terminalInterrupted:record.outcome==='interrupted',noCandidatePublished:stored.length===0,unknownUsageRetained:record.started&&budget===record.memory.reservedTokens,promptVersion:'memory-consolidation-v1',model:record.task.model.model};
  result.trace.push({action:'go_completed_source_tasks'},{action:'go_claimed_consolidation'},{action:'governed_worker_model_request'},{action:crashed?'worker_killed_and_restarted':revoked?'author_revoked_consolidation':'go_published_candidate'},{action:'go_terminal_receipt'});
  result.inputTokens=null;result.outputTokens=null;result.chargedTokens=null;
  result.budgetExposure={tokens:budget+reviews.reduce((sum,item)=>sum+(item.usage?.inputTokens??0)+(item.usage?.outputTokens??0),0),authority:'go'};
  return result;
 }finally{
  signal.removeEventListener('abort',cancel);
  result.modelCalls=f.calls;
  result.toolCalls=f.requests.reduce((sum,request)=>sum+request.messages.filter(item=>item.role==='tool').length,0);
  await f.close();
 }
}
