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
