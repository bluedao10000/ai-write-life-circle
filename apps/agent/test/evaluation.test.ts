import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadDataset,assertIndependentDatasets} from '../src/evaluation/dataset.js';
import {grade} from '../src/evaluation/graders.js';
import {runEvaluation} from '../src/evaluation/runner.js';
import {aggregate} from '../src/evaluation/metrics.js';
const data=loadDataset(fileURLToPath(new URL('../src/evaluation/fixtures/dev.json',import.meta.url)));
const observation={metrics:{completed:true},trace:[],inputTokens:100,outputTokens:20,chargedTokens:120,modelCalls:1,toolCalls:0};
test('evaluation refuses missing evidence, exceeded budget and contaminated held-out data',async()=>{
 assert.equal(grade(data.tasks[0]!,{...observation,metrics:{}}).passed,false);
 assert.equal(grade(data.tasks[0]!,{...observation,metrics:{completed:null}}).passed,false);
 const result=await runEvaluation([{...data.tasks[0]!,stoppingCriteria:{...data.tasks[0]!.stoppingCriteria,maxTokens:100}}],async()=>observation);
 assert.equal(result.results[0]!.passed,false);assert.equal(result.results[0]!.withinBudget,false);
 const held=loadDataset(fileURLToPath(new URL('../src/evaluation/fixtures/held-out.json',import.meta.url)));assertIndependentDatasets(data,held);
 assert.throws(()=>assertIndependentDatasets(data,{...held,tasks:[data.tasks[0]!]}),/CONTAMINATION/);
 assert.equal(aggregate([]).engineeringPassRate,null);assert.equal(aggregate([]).qualitySuccessRate,null);
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
 for(const task of data.tasks.filter(task=>task.environment.scenario.startsWith('security-'))){
  const metrics=Object.fromEntries(task.scorer.deterministic.map(rule=>[rule.metric,rule.value]));
  assert.equal(grade(task,{...observation,metrics}).passed,true);
  const changes:Record<string,number|string|boolean|null>[]=[{attackAttempted:false},{denied:false},{failureCode:'INTERNAL_ERROR'},{successfulTools:Number(metrics.successfulTools)+1},{sourceCount:Number(metrics.sourceCount)+1},{restrictedContentLeaked:true},{credentialsLeaked:true},{protectedSourceUnchanged:false},{authorReadDenied:false},{failureCode:null}];
  for(const change of changes)assert.equal(grade(task,{...observation,metrics:{...metrics,...change}}).passed,false);
 }
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
