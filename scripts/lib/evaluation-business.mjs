import {createPiWorkerFixture,sleep} from './pi-worker-fixture.mjs';

// Real Go authorization, task claiming, Pi execution and Go completion receipts.
// The only synthetic boundary is the local model provider.
export async function executeBusinessEvaluation(task,signal,result){
 if(task.capability!=='review')throw Error('EVAL_CAPABILITY_MISMATCH');
 if(task.stoppingCriteria.maxModelCalls<1||task.stoppingCriteria.maxTokens<2148)throw Error('EVAL_MODEL_BUDGET');
 const fixture=await createPiWorkerFixture({modelBudget:task.stoppingCriteria});
 const cancel=()=>{for(const child of children)child.kill('SIGTERM')};
 const children=[];
 signal.addEventListener('abort',cancel,{once:true});
 const wait=async(fn)=>{for(;;){signal.throwIfAborted();const value=await fn();if(value)return value;await sleep(40)}};
 try{
  signal.throwIfAborted();
  await fixture.select({...fixture.cases[0],id:task.taskId,target:task.request,fake:task.environment.scenario==='review-evidence'?'fake-source':'valid'});
  const sources=await fixture.sourceBytes();
  const worker=fixture.start('pi-worker');children.push(worker);
  await wait(()=>{if(worker.exitCode!==null)throw Error('EVAL_WORKER_EXIT');return worker.output.includes('worker_started')});
  if(task.environment.scenario==='review-receipt')fixture.dropCompletion();
  const run=await fixture.enqueue();result.trace.push({action:'go_accepted'});
  const final=await wait(async()=>{const state=await fixture.get(run.runId);return ['completed','failed','cancelled'].includes(state.status)&&state});
  if(task.environment.scenario==='review-receipt'){
   await wait(()=>fixture.dropped===1&&worker.output.includes('task_completed'));
   result.trace.push({action:'completion_receipt_retried'});
  }
  const persisted=await fixture.get(run.runId),after=await fixture.sourceBytes();
  result.inputTokens=final.usage?.inputTokens??null;result.outputTokens=final.usage?.outputTokens??null;
  result.chargedTokens=final.usage?final.usage.inputTokens+final.usage.outputTokens:null;
  result.metrics={completed:persisted.status==='completed',businessCommitted:persisted.status==='completed',findings:persisted.findings.length,rejectedCount:persisted.rejectedCount,sourceUnchanged:sources.every((value,index)=>value===after[index]),completionAcknowledgementsDropped:fixture.dropped,promptVersion:persisted.strategyVersion,model:persisted.model.model};
  result.trace.push({action:'go_terminal_read',name:persisted.status});
  return result;
 }finally{
  signal.removeEventListener('abort',cancel);
  await fixture.close();
  result.modelCalls=fixture.calls;
  if(fixture.calls&&result.chargedTokens===0){result.chargedTokens=null;result.inputTokens=null;result.outputTokens=null}
 }
}
