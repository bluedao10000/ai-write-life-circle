import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPiWorkerFixture,sleep} from './pi-worker-fixture.mjs';

// Real Go authorization, task claiming, Pi execution and Go completion receipts.
// The only synthetic boundary is the local model provider.
export async function executeBusinessEvaluation(task,signal,result){
 if(!['review','knowledge','creative'].includes(task.capability))throw Error('EVAL_CAPABILITY_MISMATCH');
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
  if(task.capability==='knowledge')return await knowledge(fixture,task,result,wait);
  if(task.capability==='creative')return await creative(fixture,task,result,wait,children);
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

function usage(result,records){
 const known=records.every(record=>record.usage&&!record.usageIncomplete);
 result.inputTokens=known?records.reduce((sum,r)=>sum+r.usage.inputTokens,0):null;
 result.outputTokens=known?records.reduce((sum,r)=>sum+r.usage.outputTokens,0):null;
 result.chargedTokens=known?result.inputTokens+result.outputTokens:null;
}
async function createBook(fixture,task){
 const book=await fixture.call('/v1/studio/books',{method:'POST',status:201,body:{operation:'create',baseVersion:0,title:task.taskId}});
 const base=`/v1/studio/books/${book.bookId}`;
 const knowledge=await fixture.call(base+'/knowledge');
 await fixture.call(base+'/knowledge/pause',{method:'POST',body:{baseVersion:knowledge.version}});
 return {book,base};
}
async function isolated(fixture,path){
 await fixture.call(path,{user:{id:'other-eval-author',email:'other-eval@example.com'},status:404});
 return true;
}
async function knowledge(fixture,task,result,wait){
 const {book,base}=await createBook(fixture,task),root=base+'/knowledge';
 await fixture.call(base+'/creative/settings/pause',{method:'POST',body:{}});
 const chapter=`/v1/projects/${book.bookId}/chapters/${book.chapters[0].chapterId}`;
 const before=await fixture.call(chapter);
 const saved=await fixture.call(chapter+'/revisions',{method:'POST',status:201,body:{baseRevisionId:before.headRevision.revisionId,markdown:task.request}});
 const page=await fixture.call(root);
 await fixture.call(root+'/enable',{method:'POST',body:{baseVersion:page.version,consent:true,model:page.model,dailyTokenBudget:task.stoppingCriteria.maxTokens,dailyJobBudget:1}});
 const job=await wait(async()=>{const {items}=await fixture.call(root+'/jobs');return items.find(j=>j.revisionId===saved.revisionId&&['completed','failed'].includes(j.status))});
 const view=await fixture.call(root),after=await fixture.call(chapter);
 const assertions=view.assertions.filter(a=>a.status==='current'),sources=assertions.flatMap(a=>a.sources);
 usage(result,[job]);
 result.metrics={completed:job.status==='completed',businessCommitted:job.status==='completed',entities:view.entities.length,assertions:assertions.length,provenanceValid:sources.length>0&&sources.every(s=>s.bookId===book.bookId&&s.revisionId===saved.revisionId&&task.request.includes(s.quote)),sourceUnchanged:after.headRevision.revisionId===saved.revisionId,canonAssets:(await fixture.call(base+'/creative/assets')).total,authorIsolated:await isolated(fixture,root),promptVersion:job.strategyVersion,model:job.model.model};
 result.trace.push({action:'go_knowledge_terminal_read',name:job.status});return result;
}
async function creative(fixture,task,result,wait,children){
 const pi=fixture.start('pi');children.push(pi);
 await wait(()=>{if(pi.exitCode!==null)throw Error('EVAL_THINKING_EXIT');return pi.output.includes('agent_started')});
 const {book,base}=await createBook(fixture,task),root=base+'/creative';
 const chapter=`/v1/projects/${book.bookId}/chapters/${book.chapters[0].chapterId}`;
 const before=await fixture.call(chapter),model=await fixture.call(base+'/thinking/capabilities');
 const session=await fixture.call(base+'/thinking/sessions',{method:'POST',status:201,body:{consent:true,model,scopes:['creative']}});
 const path=base+'/thinking/sessions/'+session.sessionId;
 const {messageId}=await fixture.call(path+'/messages',{method:'POST',status:202,body:{text:task.request}});
 const turn=await wait(async()=>{const {items}=await fixture.call(root+'/turns?sessionId='+session.sessionId);return items.find(t=>t.messageId===messageId&&!['awaiting','queued'].includes(t.status))});
 const proposals=await fixture.call(root+'/proposals?status=proposed&sessionId='+session.sessionId);
 const state=JSON.parse(await readFile(join(fixture.state,'creative',Buffer.from(book.bookId).toString('base64url'),'state-v1.json'),'utf8'));
 const jobs=state.jobs.filter(j=>j.sessionId===session.sessionId);
 const thinking=await fixture.call(path);
 usage(result,jobs);
 if(result.chargedTokens!==null&&!thinking.usage.incomplete){result.inputTokens+=thinking.usage.input;result.outputTokens+=thinking.usage.output;result.chargedTokens+=thinking.usage.charged}else{result.inputTokens=null;result.outputTokens=null;result.chargedTokens=null}
 result.metrics={completed:turn.status==='organized',businessCommitted:turn.status==='organized',proposals:proposals.items.length,provenanceValid:proposals.items.length>0&&proposals.items.every(p=>p.source.messageId===messageId&&p.evidence.every(e=>e.role==='user'&&task.request.includes(e.quote))),canonAssets:(await fixture.call(root+'/assets')).total,sourceUnchanged:(await fixture.call(chapter)).headRevision.revisionId===before.headRevision.revisionId,authorIsolated:await isolated(fixture,root),promptVersion:jobs[0]?.strategyVersion??null,model:jobs[0]?.model.model??null};
 result.trace.push({action:'go_creative_terminal_read',name:turn.status});return result;
}
