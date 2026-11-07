import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEvaluationSplit,selectEvaluationDataset,assertIndependentDatasets} from '../src/evaluation/dataset.js';
import {grade} from '../src/evaluation/graders.js';
import {runEvaluation} from '../src/evaluation/runner.js';
import {aggregate} from '../src/evaluation/metrics.js';
const fixtures=fileURLToPath(new URL('../src/evaluation/fixtures/datasets/',import.meta.url));
const development=loadEvaluationSplit(fixtures,'dev'),heldOut=loadEvaluationSplit(fixtures,'held-out');
const data=development;
const observation={metrics:{completed:true},trace:[],inputTokens:100,outputTokens:20,chargedTokens:120,modelCalls:1,toolCalls:0};
test('extraction graders require source binding, candidate isolation and actual invalidation evidence',()=>{
 for(const scenario of ['extraction-candidate','extraction-source-change','extraction-revoked']){
  const task=data.tasks.find(task=>task.environment.scenario===scenario)!;
  const metrics={completed:true,sourceTaskCompleted:true,boundSource:true,evidenceInPayload:true,zeroTools:true,reservedBeforeModel:true,noAutomaticPublication:true,candidateOnly:true,provenanceValid:true,duplicateCandidates:0,sameReceipt:true,replayModelCalls:0,sourceUnchanged:true,invalidated:true,reimportRejected:true,confirmRejected:true,invalidationModelCalls:0};
  assert.equal(grade(task,{...observation,metrics}).passed,true);
  for(const rule of task.scorer.deterministic){
   assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:null}}).passed,false,rule.metric+' missing');
   assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:typeof rule.value==='boolean'?!rule.value:1}}).passed,false,rule.metric+' violated');
  }
 }
});
test('memory poisoning requires delivered attack evidence and rejects the unbound relation',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='extraction-poison')!;
 const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 for(const rule of task.scorer.deterministic){
  assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:null}}).passed,false,rule.metric+' missing');
  assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:typeof rule.value==='boolean'?!rule.value:1}}).passed,false,rule.metric+' violated');
 }
});
test('evaluation refuses missing evidence, exceeded budget and contaminated held-out data',async()=>{
 assert.equal(grade(data.tasks[0]!,{...observation,metrics:{}}).passed,false);
 assert.equal(grade(data.tasks[0]!,{...observation,metrics:{completed:null}}).passed,false);
 const result=await runEvaluation([{...data.tasks[0]!,stoppingCriteria:{...data.tasks[0]!.stoppingCriteria,maxTokens:100}}],async()=>observation);
 assert.equal(result.results[0]!.passed,false);assert.equal(result.results[0]!.withinBudget,false);
 assertIndependentDatasets(data,heldOut);
 assert.throws(()=>assertIndependentDatasets(data,{...heldOut,tasks:[data.tasks[0]!]}),/CONTAMINATION/);
 assert.throws(()=>assertIndependentDatasets(data,{...heldOut,tasks:heldOut.tasks.filter(task=>task.category!=='memory')}),/COVERAGE/);
 assert.throws(()=>assertIndependentDatasets(data,{...heldOut,tasks:heldOut.tasks.filter(task=>task.capability!=='review')}),/COVERAGE/);
 assert.equal(aggregate([]).engineeringPassRate,null);assert.equal(aggregate([]).qualitySuccessRate,null);
});

test('each evaluation category has its own versioned development and held-out data',()=>{
 assert.equal(development.tasks.length,44);assert.equal(heldOut.tasks.length,19);
 for(const category of ['task-success','reliability','memory','safety','performance'] as const){
  const dev=selectEvaluationDataset(development,category),held=selectEvaluationDataset(heldOut,category);
  assert(dev.tasks.length>0);assert(held.tasks.length>0);
  assert(dev.tasks.every(task=>task.category===category));assert(held.tasks.every(task=>task.category===category));
  assert.notEqual(dev.version,held.version);
 }
 const heldMemory=selectEvaluationDataset(heldOut,'memory');
 assert.deepEqual(new Set(heldMemory.tasks.map(task=>task.environment.scenario)),new Set(['discussion-memory','procedural-delete','extraction-candidate','consolidation-candidate']));
 const heldSafety=selectEvaluationDataset(heldOut,'safety');
 assert(heldSafety.tasks.some(task=>task.environment.scenario==='extraction-poison'));
 assert.throws(()=>assertIndependentDatasets(development,{...heldOut,datasetVersions:{...heldOut.datasetVersions,memory:development.datasetVersions.memory}}),/VERSION/);
});

test('category dataset loading rejects a wrong category, wrong split, duplicate version and shared task ID',()=>{
 const directory=mkdtempSync(join(tmpdir(),'agent-evaluation-datasets-'));
 const file=(category:string)=>join(directory,`${category}-dev.json`);
 const reset=()=>{
  for(const category of ['task-success','reliability','memory','safety','performance']){
   const source=join(fixtures,`${category}-dev.json`);
   copyFileSync(source,file(category));
  }
 };
 const update=(category:string,change:(data:Record<string,unknown>)=>void)=>{
  const path=file(category),data=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;
  change(data);writeFileSync(path,JSON.stringify(data));
 };
 try{
  reset();
  update('memory',data=>{data.tasks=(data.tasks as Array<Record<string,unknown>>).map((task,index)=>index?task:{...task,category:'safety'})});
  assert.throws(()=>loadEvaluationSplit(directory,'dev'),/INVALID_CATEGORY_DATASET/);

  reset();update('memory',data=>{data.split='held-out'});
  assert.throws(()=>loadEvaluationSplit(directory,'dev'),/INVALID_CATEGORY_DATASET/);

  reset();update('memory',data=>{data.version='agent-eval-v23-task-success'});
  assert.throws(()=>loadEvaluationSplit(directory,'dev'),/DUPLICATE_CATEGORY_DATASET_VERSION/);

  reset();
  const first=JSON.parse(readFileSync(file('task-success'),'utf8')) as {tasks:Array<{taskId:string}>};
  update('memory',data=>{(data.tasks as Array<Record<string,unknown>>)[0]!.taskId=first.tasks[0]!.taskId});
  assert.throws(()=>loadEvaluationSplit(directory,'dev'),/DUPLICATE_TASK_ID/);
 }finally{rmSync(directory,{recursive:true,force:true})}
});
test('evaluation deadlines abort real work and retain failure status',async()=>{
 const result=await runEvaluation([{...data.tasks[0]!,stoppingCriteria:{...data.tasks[0]!.stoppingCriteria,timeoutMs:5}}],async(_task,signal)=>{
  await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return observation;
 });
 assert.equal(result.results[0]!.passed,false);assert.equal(result.results[0]!.error,'EVAL_CANCELLED_OR_TIMEOUT');
});

test('failed execution retains observed calls and never reports unknown usage as free',async()=>{
 const {EvaluationFailure}=await import('../src/evaluation/runner.js');
 const result=await runEvaluation([data.tasks[0]!],async()=>{throw new EvaluationFailure({...observation,chargedTokens:null,inputTokens:null,outputTokens:null})});
 assert.equal(result.results[0]!.passed,false);assert.equal(result.metrics.modelCalls,1);
 assert.equal(result.metrics.tokenMeasuredTasks,0);assert.equal(result.metrics.failedTaskTokens,null);
 assert.equal(aggregate([{passed:false,durationMs:1}]).modelCalls,null);
});

test('business evaluation requires Go evidence, rejects duplicate candidates and manuscript writes',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='review-receipt')!;
 const metrics={completed:true,businessCommitted:true,findings:1,rejectedCount:0,sourceUnchanged:true,completionAcknowledgementsDropped:1};
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 for(const change of [{businessCommitted:null},{findings:2},{sourceUnchanged:false},{completionAcknowledgementsDropped:0}]){
  assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
 }
 const source=data.tasks.find(task=>task.environment.scenario==='review-evidence')!;
 assert.equal(grade(source,{...observation,metrics:{...metrics,findings:0,rejectedCount:1,completionAcknowledgementsDropped:0}}).passed,true);
 assert.equal(grade(source,{...observation,metrics:{...metrics,completionAcknowledgementsDropped:0}}).passed,false);
});

test('Go API outage reliability is independently graded in development and held-out sets',async()=>{
 for(const dataset of [development,heldOut]){
  const task=dataset.tasks.find(task=>task.environment.scenario==='review-api-outage')!;
  const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
  const sample={...observation,metrics,inputTokens:null,outputTokens:null,chargedTokens:null,modelCalls:2,budgetExposure:{tokens:40000,authority:'go' as const}};
  const passed=await runEvaluation([task],async()=>sample);
  assert.equal(passed.results[0]!.passed,true,dataset.split);
  for(const rule of task.scorer.deterministic){
   const violated=typeof rule.value==='boolean'?!rule.value:rule.value===0?1:Number(rule.value)+1;
   const result=await runEvaluation([task],async()=>({...sample,metrics:{...metrics,[rule.metric]:violated}}));
   assert.equal(result.results[0]!.passed,false,dataset.split+': '+rule.metric);
  }
  const noExposure=await runEvaluation([task],async()=>({...sample,budgetExposure:undefined}));
  assert.equal(noExposure.results[0]!.passed,false,dataset.split+': unknown usage without Go exposure');
 }
});

test('Knowledge API outage grading requires unknown usage and retained retry evidence in both splits',async()=>{
 for(const dataset of [development,heldOut]){
  const task=dataset.tasks.find(task=>task.environment.scenario==='knowledge-api-outage')!;
  const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
  const sample={...observation,metrics,inputTokens:null,outputTokens:null,chargedTokens:null,modelCalls:2,budgetExposure:{tokens:40000,authority:'go' as const}};
  const passed=await runEvaluation([task],async()=>sample);
  assert.equal(passed.results[0]!.passed,true,dataset.split);
  for(const rule of task.scorer.deterministic){
   const violated=typeof rule.value==='boolean'?!rule.value:rule.value===0?1:Number(rule.value)+1;
   const result=await runEvaluation([task],async()=>({...sample,metrics:{...metrics,[rule.metric]:violated}}));
   assert.equal(result.results[0]!.passed,false,dataset.split+': '+rule.metric);
  }
  const noExposure=await runEvaluation([task],async()=>({...sample,budgetExposure:undefined}));
  assert.equal(noExposure.results[0]!.passed,false,dataset.split+': unknown usage without Go exposure');
 }
});

test('memory and creative business graders require provenance, author isolation and no canon promotion',()=>{
 for(const capability of ['knowledge','creative']){
  const task=data.tasks.find(task=>task.environment.scenario===capability+'-business')!;
  const metrics={completed:true,businessCommitted:true,entities:2,assertions:2,proposals:1,provenanceValid:true,sourceUnchanged:true,canonAssets:0,authorIsolated:true};
  assert.equal(grade(task,{...observation,metrics}).passed,true);
  for(const change of [{provenanceValid:false},{authorIsolated:false},{canonAssets:1},{sourceUnchanged:false}]){
   assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
  }
 }
});

test('single and multi plan checks require equivalent results and complete role governance',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='creative-plan-comparison')!;
 const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 for(const rule of task.scorer.deterministic){
  assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:null}}).passed,false,rule.metric+' missing');
  const violated=typeof rule.value==='boolean'?!rule.value:rule.operator==='gte'?Number(rule.value)-1:rule.operator==='lte'?Number(rule.value)+1:Number(rule.value)+1;
  assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:violated}}).passed,false,rule.metric+' violated');
 }
 assert.equal(grade(task,{...observation,metrics:{...metrics,equivalentResult:false,sameInput:false,parentLinksValid:false}}).passed,false);
 assert.equal(grade(task,{...observation,metrics:{...metrics,multiModelCalls:6,budgetRatio:1}}).passed,false);
});

test('failed read-only plan checks retain unknown usage without retrying or publishing',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='creative-plan-failure')!;
 const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 for(const rule of task.scorer.deterministic){
  assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:null}}).passed,false,rule.metric+' missing');
  assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:typeof rule.value==='boolean'?!rule.value:Number(rule.value)+1}}).passed,false,rule.metric+' violated');
 }
 assert.equal(grade(task,{...observation,metrics:{...metrics,unknownUsageRetained:false,noAutomaticRetry:false,noCoordinator:false}}).passed,false);
});

test('creative read-only subroles cannot turn model tool output into execution',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='creative-plan-tool-attempt')!;
 const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 for(const rule of task.scorer.deterministic){
  assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:null}}).passed,false,rule.metric+' missing');
  const violated=typeof rule.value==='boolean'?!rule.value:typeof rule.value==='string'?'INTERNAL_ERROR':Number(rule.value)+1;
  assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:violated}}).passed,false,rule.metric+' violated');
 }
 assert.equal(grade(task,{...observation,metrics:{...metrics,toolOutputAttempted:false}}).passed,false);
 assert.equal(grade(task,{...observation,metrics:{...metrics,noToolExecution:false,toolEvents:1,toolCalls:1}}).passed,false);
});

test('unknown usage requires a bounded authoritative exposure and remains unmeasured',async()=>{
 const task=data.tasks[0]!;
 const unknown={...observation,inputTokens:null,outputTokens:null,chargedTokens:null};
 for(const tokens of [0,-1,Infinity,task.stoppingCriteria.maxTokens+1]){
  const run=await runEvaluation([task],async()=>({...unknown,budgetExposure:{tokens,authority:'go'}}));
  assert.equal(run.results[0]!.passed,false);
 }
 const run=await runEvaluation([task],async()=>({...unknown,budgetExposure:{tokens:1000,authority:'go'}}));
 assert.equal(run.results[0]!.passed,true);
 assert.equal(run.results[0]!.observation?.chargedTokens,null);
 assert.equal(run.metrics.tokenMeasuredTasks,0);
 assert.equal(run.metrics.tokensPerSuccessfulTask,null);
});


test('Thinking fault graders reject paid automatic recovery, lost messages and refunded unknown usage',()=>{
 for(const scenario of ['thinking-cancel','thinking-recovery']){
  const task=data.tasks.find(task=>task.environment.scenario===scenario)!;
  const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
  assert.equal(grade(task,{...observation,metrics}).passed,true);
  const changes:Record<string,number|string|boolean>[]=[{automaticCalls:1},{duplicateCalls:1},{originalMessagePreserved:false},{unknownUsageRetained:false},{finalStatus:'running'},{acceptedUsers:2}];
  for(const change of changes){
   assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
  }
 }
});

test('Thinking retained reservations bound unknown costs without fabricating measured tokens',async()=>{
 const task=data.tasks[0]!;
 for(const tokens of [1000,0,task.stoppingCriteria.maxTokens+1]){
  const run=await runEvaluation([task],async()=>({...observation,inputTokens:null,outputTokens:null,chargedTokens:null,budgetExposure:{tokens,authority:'thinking-durable'}}));
  assert.equal(run.results[0]!.withinBudget,tokens===1000);
  assert.equal(run.metrics.tokenMeasuredTasks,0);
 }
});


test('security evaluations require an attempted attack, the expected rejection boundary and no leakage',()=>{
 for(const task of data.tasks.filter(task=>task.environment.scenario.startsWith('security-')&&!['security-write-revoked','security-session-isolation'].includes(task.environment.scenario))){
  const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
  assert.equal(grade(task,{...observation,metrics}).passed,true);
  const changes:Record<string,number|string|boolean|null>[]=[{attackAttempted:false},{denied:false},{failureCode:'INTERNAL_ERROR'},{successfulTools:Number(metrics.successfulTools)+1},{sourceCount:Number(metrics.sourceCount)+1},{restrictedContentLeaked:true},{credentialsLeaked:true},{protectedSourceUnchanged:false},{authorReadDenied:false},{failureCode:null}];
  for(const change of changes)assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
 }
});

test('session isolation requires independent contexts and a denied cross-book read',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='security-session-isolation')!;
 const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 const changes:Record<string,number|string|boolean|null>[]=[{firstSessionUsedOwnSource:false},{firstSessionCompleted:false},{firstSourceVerified:false},{secondContextStartsEmpty:false},{forbiddenAttempted:false},{forbiddenToolAdvertised:false},{forbiddenToolStarted:false},{forbiddenToolSucceeded:true},{secondSourceCount:1},{crossSessionContentLeaked:true},{firstSessionContentLeakedBackward:true},{firstChapterUnchanged:false},{secondChapterUnchanged:false},{credentialsLeaked:true},{modelCalls:5},{toolCalls:1}];
 for(const change of changes)assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
});


test('indirect injection requires real retrieval before the attack and excludes foreign sources',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='security-indirect')!;
 const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 const changes:Record<string,number|boolean>[]=[{injectionDelivered:false},{attackAfterRetrieval:false},{successfulTools:0},{restrictedSources:1},{authorizedSourceVerified:false}];
 for(const change of changes)assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
});


test('revocation evaluation requires a committed permission change and no subsequent model calls',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='security-revoked')!;
 const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 const changes:Record<string,number|boolean>[]=[{revocationPersisted:false},{modelCallsAfterRevocation:1},{revokedSourceUnchanged:false}];
 for(const change of changes)assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
});

test('procedural memory graders require actual retrieval before invalidation and complete results afterwards',()=>{
 for(const task of data.tasks.filter(task=>task.environment.scenario.startsWith('procedural-'))){
  const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
  assert.equal(grade(task,{...observation,metrics}).passed,true);
  const changes:Record<string,number|boolean|null>[]=[{confirmedRetrieved:false},{exactRuleRetrieved:false},{candidateExcluded:false},{independentEvidence:false},{provenanceValid:false},{firstProbeCompleted:false},{secondProbeCompleted:false},{authoritativeUnavailable:false},{invalidRulesRetrieved:1},{invalidRulesRetrieved:null},{canonAssets:1},{authorIsolated:false},{sourceUnchanged:false},{firstRetrievalComplete:false},{secondRetrievalComplete:false},{memorySchemaVersion:null}];
  if(task.environment.scenario==='procedural-delete')changes.push({deletedReplayRejected:false},{deletedContentPurged:false});
  for(const change of changes)assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
 }
});

test('memory latency aggregates actual calls, keeps absent evidence null and excludes invalid samples',()=>{
 const rows=[{passed:true,durationMs:9000,observation:{...observation,timings:{memoryRetrievalMs:[2,8]}}},{passed:true,durationMs:1000,observation:{...observation,timings:{memoryRetrievalMs:[4,NaN,-1,Infinity]}}}];
 assert.deepEqual(aggregate(rows).memoryRetrieval,{samples:3,p50Ms:4,p95Ms:8});
 assert.deepEqual(aggregate([{passed:true,durationMs:1000,observation}]).memoryRetrieval,{samples:0,p50Ms:null,p95Ms:null});
});

test('storage fault graders reject unobserved faults, duplicate recovery and lost authoritative state',()=>{
 const tasks=data.tasks.filter(task=>task.environment.scenario.startsWith('storage-'));
 assert.equal(tasks.length,2);
 for(const task of tasks){
  const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
  assert.equal(grade(task,{...observation,metrics}).passed,true);
  const changes:Record<string,number|boolean|null>[]=[{actualSigkill:false},{restarts:1},{cursorPreserved:false},{eventsExact:false},{unknownReservationRetained:false},{cancelledRunPreserved:false},{acceptedInputPreserved:false},{unpublishedAfterRecovery:1}];
  if(task.environment.scenario==='storage-sqlite')changes.push({sqliteWriteRejected:false},{snapshotBlocked:false},{eventsBlocked:false},{unpublishedSessions:0});
  else changes.push({committedBoundaryObserved:false});
  for(const change of changes)assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
 }
});

test('storage evaluation deadline terminates the actual child process and returns a failed observation',async()=>{
 const {executeEvaluation}=await import('../src/evaluation/executors.js');
 const task=data.tasks.find(task=>task.environment.scenario==='storage-outbox')!;
 const result=await runEvaluation([{...task,stoppingCriteria:{...task.stoppingCriteria,timeoutMs:1}}],executeEvaluation);
 assert.equal(result.results[0]!.passed,false);
 assert.equal(result.results[0]!.error,'EVAL_CANCELLED_OR_TIMEOUT');
 assert.equal(result.results[0]!.observation?.modelCalls,0);
});


test('write revocation requires a successful control and unchanged business assets and receipts',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='security-write-revoked')!;
 const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 const changes:Record<string,number|string|boolean>[]=[{positiveWriteCommitted:false},{revocationPersisted:false},{attackAttempted:false},{toolAdvertised:false},{denied:false},{failureCode:'INTERNAL_ERROR'},{successfulTools:1},{assetUnchanged:false},{deniedReceipts:1},{sourceUnchanged:false},{modelCallsAfterRevocation:1},{credentialsLeaked:true}];
 for(const change of changes)assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
});

test('consolidation graders require source, publication and terminal evidence',()=>{
 for(const scenario of ['consolidation-candidate','consolidation-revoked','consolidation-crash']){
  const task=data.tasks.find(task=>task.environment.scenario===scenario)!;
  const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,true]));
  assert.equal(grade(task,{...observation,metrics}).passed,true);
  for(const rule of task.scorer.deterministic){
   assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:null}}).passed,false);
   assert.equal(grade(task,{...observation,metrics:{...metrics,[rule.metric]:false}}).passed,false);
  }
 }
});

test('multi-role failure grading requires persisted admitted step results',()=>{
 const task=data.tasks.find(task=>task.environment.scenario==='creative-plan-failure')!;
 const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
 assert.equal(grade(task,{...observation,metrics}).passed,true);
 for(const value of [null,false])assert.equal(grade(task,{...observation,metrics:{...metrics,roleResultsPersisted:value}}).passed,false);
});
