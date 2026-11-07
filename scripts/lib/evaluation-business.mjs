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
  const fake=task.environment.scenario==='review-evidence'?'fake-source':['creative-plan-failure','creative-plan-tool-attempt'].includes(task.environment.scenario)?task.environment.scenario:'valid';
  await fixture.select({...fixture.cases[0],id:task.taskId,target:task.request,fake});
  const sources=await fixture.sourceBytes();
  const worker=fixture.start('pi-worker');children.push(worker);
  await wait(()=>{if(worker.exitCode!==null)throw Error('EVAL_WORKER_EXIT');return worker.output.includes('worker_started')});
  if(task.environment.scenario.startsWith('procedural-'))return await procedural(fixture,task,result,wait,children);
  if(task.capability==='knowledge')return await knowledge(fixture,task,result,wait,worker,children);
  if(task.environment.scenario==='creative-plan-comparison')return await creativePlanComparison(fixture,task,result,wait,worker);
  if(task.environment.scenario==='creative-plan-failure'||task.environment.scenario==='creative-plan-tool-attempt'||task.environment.scenario==='creative-plan-child-budget-tamper')return await creativePlanFailure(fixture,task,result,wait,worker);
  if(task.capability==='creative')return await creative(fixture,task,result,wait,children);
  if(task.environment.scenario==='review-receipt')fixture.dropCompletion();
  if(task.environment.scenario==='review-api-outage')return await reviewApiOutage(fixture,task,result,wait,sources);
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

async function reviewApiOutage(fixture,task,result,wait,sources){
 const before=fixture.calls,disconnected=fixture.disconnectedRequests;
 fixture.setMode('api-down-slow');
 const run=await fixture.enqueue();result.trace.push({action:'go_accepted'});
 await wait(()=>fixture.calls>before);
 await fixture.stop(fixture.api());result.trace.push({action:'go_api_stopped'});
 await wait(()=>fixture.disconnectedRequests>disconnected);
 result.trace.push({action:'provider_request_cancelled'});
 await fixture.expire(run.runId);
 result.trace.push({action:'old_lease_expired'});
 fixture.switchOwner('review','disabled');
 result.trace.push({action:'executor_disabled'});
 await fixture.startAPI();
 result.trace.push({action:'go_api_restarted'});
 const interrupted=await fixture.get(run.runId);
 result.trace.push({action:'interrupted_run_read',name:interrupted.status});
 await sleep(300);
 const taskState=JSON.parse(await readFile(join(fixture.state,'agent-runtime','tasks-v1.json'),'utf8'));
 const firstTask=Object.values(taskState.tasks).find(record=>record.task?.kind==='review.execute'&&record.review?.Run?.runId===run.runId&&record.task.attempt===1);
 const accountPath=join(fixture.state,'billing','accounts',Buffer.from('fixture-author').toString('base64url')+'.json');
 const account=JSON.parse(await readFile(accountPath,'utf8'));
 result.trace.push({action:'unknown_reservation_read'});
 const firstOperation='review:'+run.runId+':1',retryOperation='review:'+run.runId+':2';
 const unknownReservation=account.open?.[firstOperation];
 const noRetryWhileDisabled=fixture.calls===before+1;
 fixture.setMode('valid');
 fixture.switchOwner('review','pi');
 result.trace.push({action:'executor_reenabled'});
 const recovered=await fixture.complete(run.runId);
 result.trace.push({action:'retry_result_read'});
 await sleep(2200);
 const after=await fixture.get(run.runId),afterSources=await fixture.sourceBytes();
 const finalAccount=JSON.parse(await readFile(accountPath,'utf8'));
 const firstAttemptReserve=firstTask?.task?.reservedTokens??0;
 const retryUsage=recovered.usage?recovered.usage.inputTokens+recovered.usage.outputTokens:null;
 result.inputTokens=null;result.outputTokens=null;result.chargedTokens=null;
 if(firstAttemptReserve>0&&retryUsage!==null)result.budgetExposure={tokens:firstAttemptReserve+retryUsage,authority:'go'};
 result.metrics={
  providerRequestCancelled:fixture.disconnectedRequests===disconnected+1,
  oldAttemptInterrupted:interrupted.status==='queued'&&interrupted.failureCode==='REVIEW_INTERRUPTED'&&interrupted.findings.length===0,
  unknownReservationRetained:!!unknownReservation&&unknownReservation.points>0&&!!firstTask?.finished,
  noRetryWhileExecutorDisabled:noRetryWhileDisabled,
  retryCompleted:recovered.status==='completed'&&after.status==='completed',
  retryReservationSettled:!!finalAccount.done?.[retryOperation]&&!finalAccount.open?.[retryOperation],
  originalReservationStillOpen:!!finalAccount.open?.[firstOperation],
  onePolicyRetry:fixture.calls===before+2,
  lateResponseInert:after.findings.length===1&&after.findings[0]?.findingId===recovered.findings[0]?.findingId,
  sourceUnchanged:sources.every((value,index)=>value===afterSources[index]),
  modelCalls:fixture.calls-before,
  toolCalls:0,
 };
 result.trace.push({action:'go_recovered'},{action:'retry_completed'},{action:'old_result_fenced'});
 return result;
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
async function knowledge(fixture,task,result,wait,worker,children){
 const {book,base}=await createBook(fixture,task),root=base+'/knowledge';
 await fixture.call(base+'/creative/settings/pause',{method:'POST',body:{}});
 const chapter=`/v1/projects/${book.bookId}/chapters/${book.chapters[0].chapterId}`;
 const before=await fixture.call(chapter);
 const saved=await fixture.call(chapter+'/revisions',{method:'POST',status:201,body:{baseRevisionId:before.headRevision.revisionId,markdown:task.request}});
 const scenario=task.environment.scenario;
 const fault=scenario==='knowledge-crash'||scenario==='knowledge-timeout'||scenario==='knowledge-api-outage';
 if(fault)await fetch(fixture.origin+'/control',{method:'POST',body:JSON.stringify({mode:scenario==='knowledge-timeout'?'knowledge-timeout':'knowledge-slow'})});
 const page=await fixture.call(root);
 await fixture.call(root+'/enable',{method:'POST',body:{baseVersion:page.version,consent:true,model:page.model,dailyTokenBudget:task.stoppingCriteria.maxTokens,dailyJobBudget:scenario==='knowledge-api-outage'?2:1}});
 if(scenario==='knowledge-api-outage')return knowledgeApiOutage(fixture,task,result,wait,worker,children,root,saved,chapter,book.bookId);
 if(fault)return knowledgeFault(fixture,task,result,wait,worker,children,root,saved,chapter);
 const job=await wait(async()=>{const {items}=await fixture.call(root+'/jobs');return items.find(j=>j.revisionId===saved.revisionId&&['completed','failed'].includes(j.status))});
 const view=await fixture.call(root),after=await fixture.call(chapter);
 const assertions=view.assertions.filter(a=>a.status==='current'),sources=assertions.flatMap(a=>a.sources);
 usage(result,[job]);
 result.metrics={completed:job.status==='completed',businessCommitted:job.status==='completed',entities:view.entities.length,assertions:assertions.length,provenanceValid:sources.length>0&&sources.every(s=>s.bookId===book.bookId&&s.revisionId===saved.revisionId&&task.request.includes(s.quote)),sourceUnchanged:after.headRevision.revisionId===saved.revisionId,canonAssets:(await fixture.call(base+'/creative/assets')).total,authorIsolated:await isolated(fixture,root),promptVersion:job.strategyVersion,model:job.model.model};
 result.trace.push({action:'go_knowledge_terminal_read',name:job.status});
 if(task.environment.scenario==='knowledge-memory')await memoryProbe(fixture,task,result,wait,children,base);
 return result;
}
async function knowledgeApiOutage(fixture,task,result,wait,worker,children,root,saved,chapter,bookId){
 const baselineCalls=fixture.calls,disconnected=fixture.disconnectedRequests;
 await wait(()=>fixture.calls>baselineCalls);
 const firstJob=await wait(async()=>{
  const {items}=await fixture.call(root+'/jobs');
  return items.find(job=>job.revisionId===saved.revisionId&&job.status==='running'&&job.attempts===1);
 });
 await fixture.stop(fixture.api());result.trace.push({action:'go_api_stopped'});
 await wait(()=>fixture.disconnectedRequests>disconnected);
 result.trace.push({action:'knowledge_request_cancelled'});
 await fixture.stop(worker);
 await fixture.expireKnowledge(bookId);
 await fixture.startAPI();result.trace.push({action:'go_api_restarted'});
 const firstAccountPath=join(fixture.state,'billing','accounts',Buffer.from('fixture-author').toString('base64url')+'.json');
 const firstAccount=JSON.parse(await readFile(firstAccountPath,'utf8'));
 const firstOperation='knowledge:'+firstJob.jobId+':1';
 const beforeRetry=await fixture.call(root);
 const knowledgeState=JSON.parse(await readFile(join(fixture.state,'knowledge',Buffer.from(bookId).toString('base64url'),'index-v1.json'),'utf8'));
 const firstStoredJob=knowledgeState.jobs.find(job=>job.jobId===firstJob.jobId);
 const noRetryWhileWorkerStopped=fixture.calls===baselineCalls+1;
 await fetch(fixture.origin+'/control',{method:'POST',body:JSON.stringify({mode:'valid'})});
 const replacement=fixture.start('pi-worker');children.push(replacement);
 await wait(()=>{if(replacement.exitCode!==null)throw Error('EVAL_WORKER_EXIT');return replacement.output.includes('worker_started')});
 const recovered=await wait(async()=>{
  const {items}=await fixture.call(root+'/jobs');
  return items.find(job=>job.jobId===firstJob.jobId&&['completed','failed'].includes(job.status));
 });
 const after=await fixture.call(chapter),finalView=await fixture.call(root);
 const {items}=await fixture.call(root+'/jobs');
 const completed=items.find(job=>job.jobId===firstJob.jobId);
 const taskRegistry=JSON.parse(await readFile(join(fixture.state,'agent-runtime','tasks-v1.json'),'utf8'));
 const expiredTask=Object.values(taskRegistry.tasks).find(record=>record.task?.kind==='knowledge.extract'&&record.task?.revisionId===saved.revisionId&&record.task?.attempt===1);
 const retryOperation='knowledge:'+firstJob.jobId+':2';
 const finalAccount=await wait(async()=>{
  const account=JSON.parse(await readFile(firstAccountPath,'utf8'));
  return account.done?.[retryOperation]&&!account.open?.[retryOperation]&&account;
 });
 const retryReservationOpen=!!finalAccount.open?.[retryOperation];
 const retryReservationDone=!!finalAccount.done?.[retryOperation];
 const assertions=finalView.assertions.filter(assertion=>assertion.sources.some(source=>source.revisionId===saved.revisionId));
 const modelCalls=fixture.calls-baselineCalls;
 result.inputTokens=null;result.outputTokens=null;result.chargedTokens=null;
 result.budgetExposure={tokens:finalView.budgetTokens,authority:'go'};
 result.metrics={
  providerRequestCancelled:fixture.disconnectedRequests===disconnected+1,
  oldTaskExpired:!!expiredTask&&expiredTask.started&&expiredTask.finished&&expiredTask.resultHash==='expired',
  unknownReservationRetained:!!firstAccount.open?.[firstOperation]?.points&&!!finalAccount.open?.[firstOperation],
  unknownTokenReservationRetained:Number.isSafeInteger(firstStoredJob?.attemptReserve)&&firstStoredJob.attemptReserve>0&&beforeRetry.budgetTokens>=firstStoredJob.attemptReserve&&finalView.budgetTokens>=firstStoredJob.attemptReserve,
  usageIncomplete:completed?.usageIncomplete===true,
  noRetryWhileWorkerStopped,
  retryCompleted:recovered.status==='completed'&&recovered.attempts===2,
  retryReservationSettled:retryReservationDone&&!retryReservationOpen,
  retryReservationOpen,
  retryReservationDone,
  oneBusinessCommit:completed.status==='completed'&&items.filter(job=>job.revisionId===saved.revisionId&&job.status==='completed').length===1&&assertions.length>0&&recovered.attempts===2,
  sourceUnchanged:after.headRevision.revisionId===saved.revisionId,
  modelCalls,
  toolCalls:0,
 };
 result.trace.push({action:'unknown_usage_and_reservation_read'},{action:'new_task_claimed'},{action:'knowledge_retry_completed'});
 return result;
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
 result.trace.push({action:'go_creative_terminal_read',name:turn.status});
 if(task.environment.scenario==='creative-expiry'){
  result.metrics.initialProposals=result.metrics.proposals;delete result.metrics.proposals;
  result.metrics.initialProvenanceValid=result.metrics.provenanceValid;delete result.metrics.provenanceValid;
  await fixture.call(path,{method:'DELETE',status:204});
  const after=await fixture.call(root+'/proposals?sessionId='+session.sessionId);
  result.metrics.expiredProposals=after.items.filter(p=>p.status==='expired').length;
  result.metrics.pendingProposals=after.items.filter(p=>p.status==='proposed').length;
  result.metrics.sourceEvidencePurged=after.items.length>0&&after.items.every(p=>p.source.sessionDeleted===true&&p.evidence.every(e=>e.quote===''));
  result.trace.push({action:'source_session_deleted'});
  await memoryProbe(fixture,task,result,wait,children,base,false);
 }
 return result;
}

async function creativePlanComparison(fixture,task,result,wait,worker){
 const {pairCreativePlanRuns}=await import('../../apps/agent/src/evaluation/creative-plan-benchmark.ts');
 const lines=task.request.split('\n').map(line=>line.trim()).filter(Boolean);
 const planText=lines.find(line=>line.startsWith('计划：'))?.slice(3);
 const chapterIndex=lines.findIndex(line=>line.startsWith('正文：'));
 const chapterText=chapterIndex>=0?lines[chapterIndex].slice(3).trim():'';
 if(!planText||!chapterText.includes('最终选择留下'))throw Error('EVAL_PLAN_SCENARIO_INPUT');
 const {book,base}=await createBook(fixture,task),creative=base+'/creative';
 const chapter=`/v1/projects/${book.bookId}/chapters/${book.chapters[0].chapterId}`;
 const head=await fixture.call(chapter);
 const saved=await fixture.call(chapter+'/revisions',{method:'POST',status:201,body:{baseRevisionId:head.headRevision.revisionId,markdown:chapterText}});
 const plan=await fixture.call(creative+'/assets',{method:'POST',status:201,body:{kind:'event',status:'accepted',content:{name:planText,aliases:[],summary:planText,fields:[],plan:{chapterId:book.chapters[0].chapterId}}}});
 const taskPath=join(fixture.state,'agent-runtime','tasks-v1.json');
 const creativePath=join(fixture.state,'creative',Buffer.from(book.bookId).toString('base64url'),'state-v1.json');
 const json=async path=>{try{return JSON.parse(await readFile(path,'utf8'))}catch{return null}};
 const creativeJob=async strategy=>{
  const state=await json(creativePath);
  return state?.jobs?.find(job=>job.strategyVersion===strategy&&job.chapterId===book.chapters[0].chapterId&&job.revisionId===saved.revisionId)??null;
 };
 const taskRecord=async jobId=>{
  const state=await json(taskPath);
  return Object.values(state?.tasks??{}).find(record=>record.task?.kind==='creative.plan_check'&&record.task?.bookId===book.bookId&&record.creative?.Claim?.Job?.jobId===jobId)??null;
 };
 const divergence=async jobId=>{
  const page=await fixture.call(creative+'/divergences?chapterId='+book.chapters[0].chapterId);
  return page.items.find(item=>item.jobId===jobId)??null;
 };
 const start=fixture.requests.length;
 await fixture.call(creative+'/plan-checks',{method:'POST',status:202,body:{chapterId:book.chapters[0].chapterId}});
 const singleQueued=await wait(()=>creativeJob('creative-plan-check-v1'),'single plan-check job');
 const singleTask=await wait(()=>taskRecord(singleQueued.jobId),'single plan-check task');
 const singleResult=await wait(()=>divergence(singleQueued.jobId),'single plan-check result');
 const singleRequests=fixture.requests.slice(start);
 await fixture.call(creative+'/settings/orchestration',{method:'POST',body:{multiAgentPlanCheck:true}});
 const multiStart=fixture.requests.length;
 await fixture.call(creative+'/plan-checks',{method:'POST',status:202,body:{chapterId:book.chapters[0].chapterId}});
 const multiQueued=await wait(()=>creativeJob('creative-plan-check-readonly-v1'),'multi-agent plan-check job');
 const multiTask=await wait(()=>taskRecord(multiQueued.jobId),'multi-agent plan-check task');
 const multiResult=await wait(()=>divergence(multiQueued.jobId),'multi-agent plan-check result');
 const multiRequests=fixture.requests.slice(multiStart);
 const state=await wait(async()=>{
  const value=await json(creativePath);
  return value?.jobs?.filter(job=>[singleQueued.jobId,multiQueued.jobId].includes(job.jobId)).every(job=>job.status==='completed')?value:null;
 },'creative plan-check receipts');
 const multiFinalTask=await taskRecord(multiQueued.jobId);
 const singleFinalTask=await taskRecord(singleQueued.jobId);
 const singleJob=state.jobs.find(job=>job.jobId===singleQueued.jobId),multiJob=state.jobs.find(job=>job.jobId===multiQueued.jobId);
 usage(result,[singleJob,multiJob]);
 const systems=multiRequests.map(request=>request.messages.find(message=>message.role==='system')?.content??'');
 const roles={
  planner:systems.filter(system=>system.startsWith('You are the planner in a read-only story-plan review')).length,
  researcher:systems.filter(system=>system.startsWith('You are the evidence researcher in a read-only story-plan review')).length,
  analyst:systems.filter(system=>system.startsWith('You are the continuity analyst in a read-only story-plan review')).length,
  critic:systems.filter(system=>system.startsWith('You are the independent critic in a read-only story-plan review')).length,
  coordinator:systems.filter(system=>system.startsWith('You compare an author\'s accepted plans for one chapter')).length,
 };
 const governance=(worker.output??'').split('\n').flatMap(line=>{try{const event=JSON.parse(line);return event.event==='agent_governance'&&event.taskId===multiTask.task.taskId?[event]:[]}catch{return []}});
 const roleActions=Object.keys(roles).map(role=>governance.filter(event=>event.role==='creative.plan.'+role).map(event=>event.action));
 const governancePrecedesModel=roleActions.every(actions=>JSON.stringify(actions)===JSON.stringify(['authorized','reserved','model_started','model_finished']));
 const parentLinksValid=governance.length===20&&governance.every(event=>event.parentTaskId===multiTask.task.taskId);
 const toolEvents=governance.filter(event=>event.toolName).length;
 const currentDivergences=await fixture.call(creative+'/divergences?chapterId='+book.chapters[0].chapterId);
 const afterPlan=await fixture.call(creative+'/assets/'+plan.assetId),afterChapter=await fixture.call(chapter);
 const admissions=multiFinalTask?.modelSteps??[],startObservation=fixture.modelStepStartObservation;
 const claimStarted=record=>record?.creative?.Claim?.Started??record?.creative?.Claim?.started;
 const deadlinePolicyMs=record=>{
  const started=Date.parse(claimStarted(record)??''),deadline=Date.parse(record?.task?.deadline??'');
  const duration=deadline-started;
  if(!Number.isSafeInteger(duration)||duration<=0)throw Error('EVAL_PLAN_DEADLINE_EVIDENCE');
  return duration;
 };
 const stepResults=multiFinalTask?.stepResults??[];
 const roleDurations=admissions.map(admission=>({role:admission.role,durationMs:stepResults.find(step=>step.callIndex===admission.callIndex)?.durationMs??null}));
 const durationMs=(job,record)=>{
  const start=Date.parse(claimStarted(record)??''),end=Date.parse(job?.completedAt??'');
  return Number.isFinite(start)&&Number.isFinite(end)&&end>=start?end-start:null;
 };
 const usageTokens=job=>job?.usage&&!job.usageIncomplete?job.usage.inputTokens+job.usage.outputTokens:null;
 const candidate=out=>out?JSON.stringify({assessment:out.assessment,quote:out.evidence?.quote??'',explanation:out.explanation,question:out.question}):null;
 const businessWrites=planUnchanged=>planUnchanged?0:1;
 const pair=pairCreativePlanRuns({
  datasetVersion:task.environment.datasetVersion??'creative-plan-check-inline-v1',
  split:task.taskId.startsWith('held-out-')?'held-out':'dev',
  caseId:task.environment.caseId??task.taskId,
  single:{taskId:singleFinalTask.task.taskId,jobId:singleQueued.jobId,status:singleJob.status,revisionId:singleFinalTask.task.revisionId,contentHash:singleFinalTask.task.contentHash,inputHash:singleFinalTask.task.inputHash,provider:singleFinalTask.task.model.provider,model:singleFinalTask.task.model.model,deadlinePolicyMs:deadlinePolicyMs(singleFinalTask),reservedTokens:singleFinalTask.task.reservedTokens,modelCalls:singleJob.modelCalls??0,roleBudgets:[{role:'creative.plan.single',maxTokens:singleFinalTask.task.reservedTokens}],usageTokens:usageTokens(singleJob),unknownUsage:!!singleJob.usageIncomplete||!singleJob.usage,toolCalls:0,businessWrites:businessWrites(afterPlan.asset.version===plan.version&&afterChapter.headRevision.revisionId===saved.revisionId),durationMs:durationMs(singleJob,singleFinalTask),roleDurationsMs:[],output:candidate(singleResult)},
  multi:{taskId:multiFinalTask.task.taskId,jobId:multiQueued.jobId,status:multiJob.status,revisionId:multiFinalTask.task.revisionId,contentHash:multiFinalTask.task.contentHash,inputHash:multiFinalTask.task.inputHash,provider:multiFinalTask.task.model.provider,model:multiFinalTask.task.model.model,deadlinePolicyMs:deadlinePolicyMs(multiFinalTask),reservedTokens:multiFinalTask.task.reservedTokens,modelCalls:multiJob.modelCalls??0,roleBudgets:admissions.map(item=>({role:item.role,maxTokens:item.maxTokens})),usageTokens:usageTokens(multiJob),unknownUsage:!!multiJob.usageIncomplete||!multiJob.usage,toolCalls:toolEvents,businessWrites:businessWrites(afterPlan.asset.version===plan.version&&afterChapter.headRevision.revisionId===saved.revisionId),durationMs:durationMs(multiJob,multiFinalTask),roleDurationsMs:roleDurations,output:candidate(multiResult)},
 });
 result.metrics={
  singleCompleted:pair.checks.singleCompleted,
  multiCompleted:pair.checks.multiCompleted,
  sameInput:pair.checks.sameInput&&pair.checks.sameSavedRevision,
  equivalentResult:singleResult.assessment===multiResult.assessment&&singleResult.evidence?.quote===multiResult.evidence?.quote&&singleResult.explanation===multiResult.explanation&&singleResult.question===multiResult.question,
  oneSingleCall:singleRequests.length===1,
  fiveMultiCalls:multiRequests.length===5,
  roleCount:Object.values(roles).filter(count=>count===1).length,
  governancePrecedesModel,
  parentLinksValid,
  parallelChildAdmissionsMax:startObservation.maxConcurrent,
  modelStepAdmissionCount:admissions.length,
  childBudgetSumMatchesParent:pair.checks.expectedCalls,
  toolEvents,
  singleModelCalls:singleJob.modelCalls,
  multiModelCalls:multiJob.modelCalls,
  totalModelCalls:singleJob.modelCalls+multiJob.modelCalls,
  singleReservedTokens:singleFinalTask.task.reservedTokens,
  multiReservedTokens:multiFinalTask.task.reservedTokens,
  budgetRatio:multiFinalTask.task.reservedTokens/singleFinalTask.task.reservedTokens,
  sameParentReservation:pair.checks.equalParentReservation,
  sameProviderModel:pair.checks.sameModel,
  sameDeadlinePolicy:pair.checks.sameDeadlinePolicy,
  pairedCaseId:pair.caseId,
  datasetVersion:pair.datasetVersion,
  pairEligible:pair.eligible,
  deterministicPassed:pair.deterministicPassed,
  zeroTools:pair.checks.zeroTools,
  zeroBusinessWrites:pair.checks.zeroBusinessWrites,
  singleUsageTokens:pair.single.usageTokens,
  multiUsageTokens:pair.multi.usageTokens,
  singleUnknownUsageReservation:pair.single.unknownUsage?pair.single.reservedTokens:0,
  multiUnknownUsageReservation:pair.multi.unknownUsage?pair.multi.reservedTokens:0,
  singleDurationMs:pair.single.durationMs,
  multiDurationMs:pair.multi.durationMs,
  roleDurationsMs:JSON.stringify(pair.multi.roleDurationsMs),
  pairRecord:JSON.stringify(pair),
  planUnchanged:afterPlan.asset.version===plan.version&&afterPlan.asset.summary===planText,
  sourceUnchanged:afterChapter.headRevision.revisionId===saved.revisionId,
  authoritativeDivergences:currentDivergences.items.length,
  toolCalls:pair.single.toolCalls+pair.multi.toolCalls,
  qualityEquivalent:null,
 };
 result.budgetExposure={tokens:pair.single.reservedTokens+pair.multi.reservedTokens,authority:'go'};
 result.trace.push({action:'single_plan_check_completed'},{action:'multi_plan_check_completed'},{action:'go_plan_versions_verified'});
 return result;
}

async function creativePlanFailure(fixture,task,result,wait,worker){
 const toolAttempt=task.environment.scenario==='creative-plan-tool-attempt';
 const childBudgetTamper=task.environment.scenario==='creative-plan-child-budget-tamper';
 const expectedFailure=toolAttempt?'LLM_TOOL_OUTPUT_FORBIDDEN':childBudgetTamper?'AGENT_CONFIG_CHANGED':'LLM_HTTP_ERROR';
 const lines=task.request.split('\n').map(line=>line.trim()).filter(Boolean);
 const planText=lines.find(line=>line.startsWith('计划：'))?.slice(3);
 const chapterIndex=lines.findIndex(line=>line.startsWith('正文：'));
 const chapterText=chapterIndex>=0?lines[chapterIndex].slice(3).trim():'';
 if(!planText||!chapterText.includes('最终选择留下'))throw Error('EVAL_PLAN_SCENARIO_INPUT');
 const {book,base}=await createBook(fixture,task),creative=base+'/creative';
 const chapter=`/v1/projects/${book.bookId}/chapters/${book.chapters[0].chapterId}`;
 const head=await fixture.call(chapter);
 const saved=await fixture.call(chapter+'/revisions',{method:'POST',status:201,body:{baseRevisionId:head.headRevision.revisionId,markdown:chapterText}});
 const plan=await fixture.call(creative+'/assets',{method:'POST',status:201,body:{kind:'event',status:'accepted',content:{name:planText,aliases:[],summary:planText,fields:[],plan:{chapterId:book.chapters[0].chapterId}}}});
 await fixture.call(creative+'/settings/orchestration',{method:'POST',body:{multiAgentPlanCheck:true}});
 const taskPath=join(fixture.state,'agent-runtime','tasks-v1.json');
 const creativePath=join(fixture.state,'creative',Buffer.from(book.bookId).toString('base64url'),'state-v1.json');
 const json=async path=>{try{return JSON.parse(await readFile(path,'utf8'))}catch{return null}};
 const currentJob=async jobId=>{
  const state=await json(creativePath);
  return state?.jobs?.find(job=>job.jobId===jobId)??null;
 };
 const queued=async()=>{
  const state=await json(creativePath);
  return state?.jobs?.find(job=>job.strategyVersion==='creative-plan-check-readonly-v1'&&job.chapterId===book.chapters[0].chapterId&&job.revisionId===saved.revisionId)??null;
 };
 const taskRecord=async jobId=>{
  const state=await json(taskPath);
  return Object.values(state?.tasks??{}).find(record=>record.task?.kind==='creative.plan_check'&&record.task?.bookId===book.bookId&&record.creative?.Claim?.Job?.jobId===jobId)??null;
 };
 if(childBudgetTamper)fixture.tamperNextModelStep(5);
 const start=fixture.requests.length;
 await fixture.call(creative+'/plan-checks',{method:'POST',status:202,body:{chapterId:book.chapters[0].chapterId}});
 const queuedJob=await wait(queued,'failed plan-check job');
 const record=await wait(()=>taskRecord(queuedJob.jobId),'failed plan-check task');
 const failed=await wait(async()=>{
  const job=await currentJob(queuedJob.jobId);
  if(job?.status==='failed')return job;
  if(worker.exitCode!==null){
   result.metrics={workerExitCode:worker.exitCode??null,taskActionErrors:JSON.stringify(fixture.taskActionErrors),workerOutput:(worker.output??'').split('\n').filter(line=>line.includes('task_')||line.includes('executor_')||line.includes('worker_')).slice(-12).join('\n')};
   throw Error('EVAL_WORKER_EXIT');
  }
  return null;
 },'failed plan-check receipt');
 const finalRecord=await wait(async()=>{const value=await taskRecord(queuedJob.jobId);return value?.finished&&value},'model result receipts');
 const callsAtFailure=fixture.requests.length;
 await sleep(2200);
 const afterFailure=await currentJob(queuedJob.jobId);
 const requests=fixture.requests.slice(start);
 const systems=requests.map(request=>request.messages.find(message=>message.role==='system')?.content??'');
 const governance=(worker.output??'').split('\n').flatMap(line=>{try{const event=JSON.parse(line);return event.event==='agent_governance'&&event.taskId===record.task.taskId?[event]:[]}catch{return []}});
 const plannerActions=governance.filter(event=>event.role==='creative.plan.planner').map(event=>event.action);
 const researcherActions=governance.filter(event=>event.role==='creative.plan.researcher').map(event=>event.action);
 const coordinatorActions=governance.filter(event=>event.role==='creative.plan.coordinator').map(event=>event.action);
 const failedSteps=finalRecord.stepResults?.filter(step=>step.status==='failed')??[];
 const divergencePage=await fixture.call(creative+'/divergences?chapterId='+book.chapters[0].chapterId);
 const afterPlan=await fixture.call(creative+'/assets/'+plan.assetId),afterChapter=await fixture.call(chapter),assets=await fixture.call(creative+'/assets');
 usage(result,[failed]);
 result.budgetExposure={tokens:record.task.reservedTokens,authority:'go'};
 const metrics={
  failedWithProviderError:!toolAttempt&&failed.status==='failed'&&failed.failureCode===expectedFailure,
  roleResultsPersisted:finalRecord.stepResults?.some(step=>step.callIndex===1&&step.status==='completed'&&step.usage!=null)===true&&failedSteps.length>0&&finalRecord.stepResults.every(step=>step.durationMs>=0&&finalRecord.modelSteps.some(admission=>admission.callIndex===step.callIndex)),
  unknownUsageRetained:failed.usage==null&&failed.usageIncomplete===true,
  parentReservationRetained:failed.reservedTokens===record.task.reservedTokens&&failed.reservedTokens>0,
  noAutomaticRetry:afterFailure?.status==='failed'&&afterFailure.attempts===1&&fixture.requests.length===callsAtFailure,
  noCoordinator:systems.every(system=>!system.startsWith('You compare an author\'s accepted plans for one chapter'))&&governance.every(event=>event.role!=='creative.plan.coordinator'),
  callsBounded:failed.modelCalls>0&&failed.modelCalls<5,
  plannerGoverned:JSON.stringify(plannerActions)===JSON.stringify(['authorized','reserved','model_started','model_finished']),
  researcherGoverned:JSON.stringify(researcherActions)===JSON.stringify(['authorized','reserved','model_started','failed']),
  parentLinksValid:governance.length>0&&governance.every(event=>event.parentTaskId===record.task.taskId),
  toolEvents:governance.filter(event=>event.toolName).length,
  authoritativeDivergences:divergencePage.items.length,
  planUnchanged:afterPlan.asset.version===plan.version&&afterPlan.asset.summary===planText,
  sourceUnchanged:afterChapter.headRevision.revisionId===saved.revisionId,
  toolCalls:0,
  qualityEquivalent:null,
 };
 if(toolAttempt)Object.assign(metrics,{
  toolOutputAttempted:fixture.planToolAttempts===1,
  attemptedTool:fixture.planToolAttemptName,
  failureCode:failed.failureCode,
  noToolExecution:fixture.planToolAttempts===1&&governance.every(event=>!event.toolName),
  toolsNotAdvertised:requests.every(request=>!Array.isArray(request.tools)||request.tools.length===0),
  assets:assets.total,
  researcherFailureAudited:JSON.stringify(researcherActions)===JSON.stringify(['authorized','reserved','model_started','failed']),
 });
 if(childBudgetTamper){
  const evidence=fixture.stepTamperEvidence,results=finalRecord.stepResults??[],admissions=finalRecord.modelSteps??[];
  const completedRoles={
   planner:systems.filter(system=>system.startsWith('You are the planner in a read-only story-plan review')).length,
   researcher:systems.filter(system=>system.startsWith('You are the evidence researcher in a read-only story-plan review')).length,
   analyst:systems.filter(system=>system.startsWith('You are the continuity analyst in a read-only story-plan review')).length,
   critic:systems.filter(system=>system.startsWith('You are the independent critic in a read-only story-plan review')).length,
  };
  Object.assign(metrics,{
   roleResultsPersisted:results.length===4&&results.every(step=>step.status==='completed'&&step.usage!=null&&admissions.some(admission=>admission.callIndex===step.callIndex)),
   failedStepAbsent:failedSteps.length===0,
   knownUsageSettled:failed.usage!=null&&failed.usageIncomplete!==true,
   noCoordinator:systems.every(system=>!system.startsWith('You compare an author\'s accepted plans for one chapter'))&&coordinatorActions.every(action=>action!=='reserved'&&action!=='model_started'),
   admissionTampered:evidence?.callIndex===5&&evidence?.role==='creative.plan.coordinator'&&evidence.maxTokens===evidence.originalMaxTokens+evidence.maxTokensDelta,
   goAdmissionRejected:evidence?.status===409&&evidence?.code==='AGENT_CONFIG_CHANGED',
   coordinatorAdmissionDenied:JSON.stringify(coordinatorActions)===JSON.stringify(['authorized','failed']),
   coordinatorProviderAbsent:systems.every(system=>!system.startsWith('You compare an author\'s accepted plans for one chapter')),
   completedChildRoles:Object.values(completedRoles).every(count=>count===1),
   modelStepAdmissions:admissions.length===4&&admissions.map(admission=>admission.callIndex).sort((a,b)=>a-b).every((callIndex,index)=>callIndex===index+1),
   admissionReceipt:JSON.stringify(evidence),
   taskActionErrors:JSON.stringify(fixture.taskActionErrors),
   failedModelCalls:failed.modelCalls??null,
   failedUsageIncomplete:failed.usageIncomplete===true,
   completedStepResults:results.filter(step=>step.status==='completed').length,
   modelStepAdmissionCount:admissions.length,
   taskOutcome:finalRecord.outcome??null,
   failureCode:failed.failureCode,
   assets:assets.total,
  });
 }
 result.metrics=metrics;
 result.trace.push(
  {action:toolAttempt?'model_tool_output_rejected':childBudgetTamper?'model_step_admission_rejected':'provider_failure_reported'},
  {action:childBudgetTamper?'known_usage_settled':metrics.unknownUsageRetained?'unknown_usage_reservation_retained':'known_usage_settled'},
  {action:'automatic_retry_absent'},
 );
 return result;
}

async function knowledgeFault(fixture,task,result,wait,worker,children,root,saved,chapter){
 await wait(()=>fixture.calls===1);
 const before=await fixture.call(root);
 if(task.environment.scenario==='knowledge-crash'){
  await fixture.stop(worker,'SIGKILL');
  result.trace.push({action:'worker_sigkill'});
  await fixture.call(root+'/pause',{method:'POST',body:{baseVersion:(await fixture.call(root)).version}});
  const replacement=fixture.start('pi-worker');children.push(replacement);
  await wait(()=>{if(replacement.exitCode!==null)throw Error('EVAL_WORKER_EXIT');return replacement.output.includes('worker_started')});
  result.trace.push({action:'worker_restarted_with_domain_paused'});
  await wait(()=>fixture.knowledgeResponses===1);
 }else{
  await wait(async()=>{const {items}=await fixture.call(root+'/jobs');return items.some(j=>j.revisionId===saved.revisionId&&j.failureCode==='LLM_TIMEOUT')});
  result.trace.push({action:'provider_timeout_reported'});
 }
 const view=await fixture.call(root),jobs=(await fixture.call(root+'/jobs')).items;
 result.inputTokens=null;result.outputTokens=null;result.chargedTokens=null;
 result.budgetExposure={tokens:view.budgetTokens,authority:'go'};
 result.metrics={actualSigkill:worker.signalCode==='SIGKILL',timeoutRecorded:jobs.some(j=>j.failureCode==='LLM_TIMEOUT'),unknownUsageRetained:view.budgetTokens>=before.budgetTokens&&view.budgetTokens>0,completedJobs:jobs.filter(j=>j.status==='completed').length,assertions:view.assertions.length,sourceUnchanged:(await fixture.call(chapter)).headRevision.revisionId===saved.revisionId,modelCalls:fixture.calls,model:jobs[0]?.model.model??null,promptVersion:jobs[0]?.strategyVersion??null};
 result.trace.push({action:'go_budget_and_jobs_read'});return result;
}

async function memoryProbe(fixture,task,result,wait,children,base,start=true){
 if(start){const pi=fixture.start('pi');children.push(pi);
 await wait(()=>{if(pi.exitCode!==null)throw Error('EVAL_THINKING_EXIT');return pi.output.includes('agent_started')});}
 const firstRequest=fixture.requests.length;
 await fetch(fixture.origin+'/control',{method:'POST',body:JSON.stringify({mode:'memory-read'})});
 const model=await fixture.call(base+'/thinking/capabilities');
 const session=await fixture.call(base+'/thinking/sessions',{method:'POST',status:201,body:{consent:true,model,scopes:['creative','knowledge']}});
 const path=base+'/thinking/sessions/'+session.sessionId;
 await fixture.call(path+'/messages',{method:'POST',status:202,body:{text:'检索记忆并区分原文观察与作者确认。'}});
 const completed=await wait(async()=>{const state=await fixture.call(path);return state.status==='idle'&&state});
 const probeRequests=fixture.requests.slice(firstRequest);
 const memories=probeRequests.flatMap(request=>request.messages.filter(m=>m.role==='tool').flatMap(message=>{try{const value=JSON.parse(message.content);return Array.isArray(value.records)?[value]:[]}catch{return []}}));
 const memory=memories.at(-1);
 result.metrics.memoryToolCompleted=completed.messages.at(-1)?.status==='completed';
 result.metrics.retrievedRecords=memory?.records.length??null;
 result.metrics.retrievedObservations=memory?.records.filter(record=>record.resource==='knowledge.assertion'&&record.status==='observed').length??null;
 result.metrics.retrievedConfirmed=memory?.records.filter(record=>record.status==='confirmed').length??null;
 result.metrics.memoryProvenance=!!memory&&memory.records.length>0&&memory.records.every(record=>record.provenance&&record.versionResource);
 result.toolCalls+=new Set(probeRequests.flatMap(request=>request.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id))).size;
 if(result.chargedTokens!==null&&!completed.usage.incomplete){result.inputTokens+=completed.usage.input;result.outputTokens+=completed.usage.output;result.chargedTokens+=completed.usage.charged}else{result.inputTokens=null;result.outputTokens=null;result.chargedTokens=null}
 const observations=children.flatMap(child=>(child.output??'').split('\n').flatMap(line=>{try{const record=JSON.parse(line);return record.event==='agent_governance'&&record.sessionId===session.sessionId&&record.toolName==='retrieve_memory'&&record.action==='tool_finished'&&Number.isFinite(record.durationMs)&&record.durationMs>=0?[record.durationMs]:[]}catch{return []}}));
 (result.timings??={memoryRetrievalMs:[]}).memoryRetrievalMs.push(...observations);
 result.metrics.memoryLatencyObserved=observations.length===1;
 result.trace.push({action:'go_memory_tool_result_observed'});
 return memory;
}


async function procedural(fixture,task,result,wait,children){
 const {book,base}=await createBook(fixture,task),root=base+'/procedural-memory',knowledge=base+'/knowledge';
 await fixture.call(base+'/creative/settings/pause',{method:'POST',body:{}});
 const chapter=`/v1/projects/${book.bookId}/chapters/${book.chapters[0].chapterId}`;
 const jobs=[];
 for(const [index,text] of [task.request,task.request+' 林舟补充了一封旧信的出处。'].entries()){
  const head=await fixture.call(chapter);
  const saved=await fixture.call(chapter+'/revisions',{method:'POST',status:201,body:{baseRevisionId:head.headRevision.revisionId,markdown:text}});
  if(index===0){const page=await fixture.call(knowledge);await fixture.call(knowledge+'/enable',{method:'POST',body:{baseVersion:page.version,consent:true,model:page.model,dailyTokenBudget:task.stoppingCriteria.maxTokens,dailyJobBudget:2}})}
  jobs.push(await wait(async()=>{const {items}=await fixture.call(knowledge+'/jobs');return items.find(job=>job.revisionId===saved.revisionId&&['completed','failed'].includes(job.status))}));
 }
 usage(result,jobs);
 const evidence=await wait(async()=>{const {items}=await fixture.call(root+'/evidence');return items.length===2&&items});
 const ids=evidence.map(item=>item.taskId);
 const pi=fixture.start('pi');children.push(pi);
 await wait(()=>{if(pi.exitCode!==null)throw Error('EVAL_THINKING_EXIT');return pi.output.includes('agent_started')});
 const expiring=task.environment.scenario==='procedural-expiry';
 const input={content:task.request,taskIds:ids,...(expiring?{expiresAt:new Date(Date.now()+10000).toISOString()}:{})};
 const candidate=await fixture.call(root,{method:'POST',key:'procedural-eval-create',status:201,body:input});
 const unconfirmed=await fixture.call(root,{method:'POST',status:201,body:{content:'尚未审核的独立对照经验。',taskIds:ids}});
 const confirmed=await fixture.call(root+'/'+candidate.id,{method:'POST',body:{baseVersion:candidate.version,action:'confirm'}});
 const first=await memoryProbe(fixture,task,result,wait,children,base,false);
 const records=first?.records.filter(record=>record.layer==='procedural');
 const rule=records?.find(record=>record.id===candidate.id);
 result.metrics={...result.metrics,
  independentEvidence:evidence.length===2&&evidence[0].inputHash!==evidence[1].inputHash&&evidence.every(e=>e.kind===evidence[0].kind&&e.strategyVersion===evidence[0].strategyVersion),
  firstProbeCompleted:result.metrics.memoryToolCompleted,firstLatencyObserved:result.metrics.memoryLatencyObserved,
  confirmedRetrieved:records?.length===1&&!!rule,
  exactRuleRetrieved:rule?.content?.text===input.content,
  provenanceValid:rule?.provenance?.length===2&&new Set(rule.provenance.map(source=>source.taskId)).size===2&&rule.provenance.every(source=>evidence.some(original=>original.taskId===source.taskId&&original.kind===source.kind&&original.strategyVersion===source.strategyVersion&&original.inputHash===source.inputHash))&&rule.version===confirmed.version&&rule.versionResource==='procedural.rule',
  candidateExcluded:!!first&&first.records.every(record=>record.id!==unconfirmed.id),
  authorIsolated:await isolated(fixture,root),
  memorySchemaVersion:first?.schemaVersion??null,firstRetrievalComplete:!!first&&!first.truncated&&first.omitted===0,model:jobs[0].model.model,promptVersion:jobs[0].strategyVersion,
 };
 if(expiring){await wait(()=>Date.now()>=Date.parse(confirmed.expiresAt));result.trace.push({action:'procedural_expiry_elapsed'})}
 else{await fixture.call(root+'/'+candidate.id,{method:'POST',body:{baseVersion:confirmed.version,action:task.environment.scenario==='procedural-revoke'?'reject':'delete'}});result.trace.push({action:task.environment.scenario==='procedural-revoke'?'procedural_withdrawn':'procedural_deleted'})}
 await fixture.stop(fixture.api());await fixture.startAPI();result.trace.push({action:'go_api_restarted'});
 const listed=(await fixture.call(root)).items,stored=listed.find(item=>item.id===candidate.id);
 result.metrics.authoritativeUnavailable=expiring?stored?.unavailableReason==='expired'&&!stored.available:task.environment.scenario==='procedural-revoke'?stored?.status==='rejected'&&!stored.available:!stored;
 const second=await memoryProbe(fixture,task,result,wait,children,base,false);
 result.metrics.secondProbeCompleted=result.metrics.memoryToolCompleted;
 result.metrics.secondLatencyObserved=result.metrics.memoryLatencyObserved;
 result.metrics.secondRetrievalComplete=!!second&&!second.truncated&&second.omitted===0;
 result.metrics.invalidRulesRetrieved=second?second.records.filter(record=>record.layer==='procedural').length:null;
 result.metrics.canonAssets=(await fixture.call(base+'/creative/assets')).total;
 result.metrics.sourceUnchanged=(await fixture.call(chapter)).headRevision.revisionId===jobs.at(-1).revisionId;
 if(task.environment.scenario==='procedural-delete'){
  await fixture.call(root,{method:'POST',key:'procedural-eval-create',status:410,body:input});
  result.metrics.deletedReplayRejected=true;
  const persisted=JSON.parse(await readFile(join(fixture.state,'creative',Buffer.from(book.bookId).toString('base64url'),'procedural-memory-v1.json'),'utf8'));
  result.metrics.deletedContentPurged=!JSON.stringify(persisted).includes(input.content);
 }
 return result;
}
