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
  if(task.environment.scenario.startsWith('procedural-'))return await procedural(fixture,task,result,wait,children);
  if(task.capability==='knowledge')return await knowledge(fixture,task,result,wait,worker,children);
  if(task.environment.scenario==='creative-plan-comparison')return await creativePlanComparison(fixture,task,result,wait,worker);
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
async function knowledge(fixture,task,result,wait,worker,children){
 const {book,base}=await createBook(fixture,task),root=base+'/knowledge';
 await fixture.call(base+'/creative/settings/pause',{method:'POST',body:{}});
 const chapter=`/v1/projects/${book.bookId}/chapters/${book.chapters[0].chapterId}`;
 const before=await fixture.call(chapter);
 const saved=await fixture.call(chapter+'/revisions',{method:'POST',status:201,body:{baseRevisionId:before.headRevision.revisionId,markdown:task.request}});
 const fault=task.environment.scenario==='knowledge-crash'||task.environment.scenario==='knowledge-timeout';
 if(fault)await fetch(fixture.origin+'/control',{method:'POST',body:JSON.stringify({mode:task.environment.scenario==='knowledge-crash'?'knowledge-slow':'knowledge-timeout'})});
 const page=await fixture.call(root);
 await fixture.call(root+'/enable',{method:'POST',body:{baseVersion:page.version,consent:true,model:page.model,dailyTokenBudget:task.stoppingCriteria.maxTokens,dailyJobBudget:1}});
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
 result.metrics={
  singleCompleted:singleJob.status==='completed'&&singleResult.assessment==='diverged',
  multiCompleted:multiJob.status==='completed'&&multiResult.assessment==='diverged',
  sameInput:singleTask.task.inputHash===multiTask.task.inputHash&&singleTask.task.revisionId===multiTask.task.revisionId&&singleTask.task.contentHash===multiTask.task.contentHash,
  equivalentResult:singleResult.assessment===multiResult.assessment&&singleResult.evidence?.quote===multiResult.evidence?.quote&&singleResult.explanation===multiResult.explanation&&singleResult.question===multiResult.question,
  oneSingleCall:singleRequests.length===1,
  fiveMultiCalls:multiRequests.length===5,
  roleCount:Object.values(roles).filter(count=>count===1).length,
  governancePrecedesModel,
  parentLinksValid,
  toolEvents,
  singleModelCalls:singleJob.modelCalls,
  multiModelCalls:multiJob.modelCalls,
  totalModelCalls:singleJob.modelCalls+multiJob.modelCalls,
  singleReservedTokens:singleTask.task.reservedTokens,
  multiReservedTokens:multiTask.task.reservedTokens,
  budgetRatio:multiTask.task.reservedTokens/singleTask.task.reservedTokens,
  planUnchanged:afterPlan.asset.version===plan.version&&afterPlan.asset.summary===planText,
  sourceUnchanged:afterChapter.headRevision.revisionId===saved.revisionId,
  authoritativeDivergences:currentDivergences.items.length,
  toolCalls:0,
  qualityEquivalent:null,
 };
 result.trace.push({action:'single_plan_check_completed'},{action:'multi_plan_check_completed'},{action:'go_plan_versions_verified'});
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
