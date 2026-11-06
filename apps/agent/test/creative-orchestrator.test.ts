import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AgentModelResponse,AgentTask} from '@writer-agent/contracts';
import {GatewayError,ModelGateway,executionFingerprint,type ModelStep} from '../src/runtime/model-gateway.js';
import {orchestratePlanCheck,readonlyPlanModelCalls,readonlyPlanStrategy} from '../src/agents/creative/orchestrator.js';
import {definition,workerContext} from '../src/runtime/governance/runtime.js';

const final='{"checks":[{"assetId":"plan-1","assessment":"diverged","quote":"他留下","explanation":"计划离开，正文选择留下。","question":"要修改计划吗？"}]}';
function task():AgentTask{
 return {
  taskId:randomUUID(),kind:'creative.plan_check',bookId:'book',authorId:'author',leaseToken:randomUUID(),executorEpoch:1,attempt:1,
  deadline:new Date(Date.now()+30000).toISOString(),strategyVersion:readonlyPlanStrategy,revisionId:'revision',contentHash:'sha256:'+'a'.repeat(64),
  inputHash:'sha256:'+'b'.repeat(64),model:{provider:'fixture',model:'fixture',endpoint:'http://127.0.0.1:1',execution:'local'},configFingerprint:'fixture',
  outputSchemaVersion:'creative-plan-check-candidates-v2',reservedTokens:10000,budgetDay:'2026-11-05',consent:{},
  request:{system:'You compare supplied plans with the chapter.',input:JSON.stringify({chapterTitle:'第一章',chapterText:'他最后留下。',plans:[{assetId:'plan-1',kind:'event',plan:'他离开组织。'}]}),schemaName:'creative_plan_check',schema:{type:'object'}},
 };
}
function responseFor(step:ModelStep):AgentModelResponse{
 const body=step.role==='creative.plan.planner'?{items:[{assetId:'plan-1',focus:'离开与留下的冲突'}]}:
  step.role==='creative.plan.researcher'?{findings:[{assetId:'plan-1',quote:'他最后留下',observation:'正文明确写他留下。',assessment:'diverged'}]}:
  step.role==='creative.plan.analyst'?{analyses:[{assetId:'plan-1',reasoning:'结果与计划相反。',assessment:'diverged'}]}:
  step.role==='creative.plan.critic'?{concerns:[{assetId:'plan-1',concern:'需要确认留下是否有意。'}]}:JSON.parse(final);
 return {text:JSON.stringify(body),usage:{inputTokens:100,outputTokens:20},modelCalls:1};
}

test('readonly plan orchestration shares one parent execution across five fixed roles',async()=>{
 const steps:ModelStep[]=[];
 const gateway={config:{MaxOutputTokens:2048},executeStep:async(_task:AgentTask,_signal:AbortSignal,step:ModelStep)=>{steps.push(step);return responseFor(step)}};
 const result=await orchestratePlanCheck(task(),gateway,new AbortController().signal);
 assert.equal(result.text,final);
 assert.equal(result.modelCalls,readonlyPlanModelCalls);
 assert.deepEqual(result.usage,{inputTokens:500,outputTokens:100,cachedInputTokens:0});
 assert.equal(steps.length,5);
 assert.equal(result.stepResults?.length,5);
 assert(result.stepResults?.every(step=>step.status==='completed'&&step.durationMs>=0&&step.usage?.inputTokens===100));
 assert.deepEqual(result.stepResults?.map(step=>step.callIndex),[1,2,3,4,5]);
 assert.deepEqual(new Set(steps.map(step=>step.role)),new Set(['creative.plan.planner','creative.plan.researcher','creative.plan.analyst','creative.plan.critic','creative.plan.coordinator']));
 assert.deepEqual(steps.map(step=>step.callIndex),steps.map((_,index)=>index+1));
 assert(steps.every(step=>step.maxModelCalls===5&&step.parentTaskId&&step.maxOutputTokens>=128));
 assert.equal(steps.reduce((sum,step)=>sum+step.maxOutputTokens,0),2048);
 assert.equal(steps.reduce((sum,step)=>sum+step.maxTokens,0),10000);
});

test('readonly plan roles have no scopes or tools and split only the parent budget',()=>{
 const source=task();
 const contexts=[
  ['creative.plan.planner',2000],
  ['creative.plan.researcher',2000],
  ['creative.plan.analyst',2000],
  ['creative.plan.critic',2000],
  ['creative.plan.coordinator',2000],
 ] as const;
 for(const [role,maxTokens] of contexts){
  assert.equal(definition(role).tools,'none');
  const context=workerContext(source,new AbortController().signal,{role,parentTaskId:source.taskId,maxModelCalls:5,maxTokens});
  assert.deepEqual(context.scopes,[]);
  assert.equal(context.parentTaskId,source.taskId);
  assert.equal(context.budget?.maxToolCalls,0);
  assert.equal(context.budget?.maxModelCalls,5);
 }
 assert.equal(contexts.reduce((sum,[,tokens])=>sum+tokens,0),source.reservedTokens);
});

test('readonly plan output contract cannot be claimed as the legacy single-call contract',()=>{
 const config={Provider:'openai-compatible' as const,BaseURL:'http://127.0.0.1:9999/v1',APIKey:'' as const,Model:'fixture',ResponseFormat:'json_object' as const,TokenParameter:'max_tokens' as const,Timeout:10000,MaxContextBytes:32000,MaxOutputTokens:2048,MaxResponseBytes:65536};
 const source=task();
 source.model={provider:config.Provider,model:config.Model,endpoint:config.BaseURL,execution:'local'};
 source.configFingerprint=executionFingerprint(config);
 const gateway=new ModelGateway(config,'synthetic',async()=>{});
 gateway.validate(source);
 source.outputSchemaVersion='creative-plan_check-candidates-v1';
 assert.throws(()=>gateway.validate(source),(error)=>error instanceof GatewayError&&error.code==='AGENT_CONFIG_CHANGED');
});

test('readonly plan orchestration rejects parent or foreign assets before publication',async()=>{
 const source=task();
 const steps:ModelStep[]=[];
 const gateway={config:{MaxOutputTokens:2048},executeStep:async(_task:AgentTask,_signal:AbortSignal,step:ModelStep)=>{
  steps.push(step);
  return {text:JSON.stringify({items:[{assetId:'pm-foreign',focus:'fabricated'}]}),usage:{inputTokens:10,outputTokens:5},modelCalls:1};
 }};
 await assert.rejects(()=>orchestratePlanCheck(source,gateway,AbortSignal.timeout(1000)),(error)=>error instanceof GatewayError&&error.code==='LLM_INVALID_OUTPUT');
 assert.equal(steps.length,1);
});

test('readonly plan orchestration stops when a provider hides usage',async()=>{
 const gateway={config:{MaxOutputTokens:2048},executeStep:async()=>({text:JSON.stringify({items:[{assetId:'plan-1',focus:'focus'}]}),usage:null,modelCalls:1})};
 await assert.rejects(()=>orchestratePlanCheck(task(),gateway,AbortSignal.timeout(1000)),(error)=>error instanceof GatewayError&&error.code==='LLM_INVALID_USAGE'&&error.response.modelCalls===1&&error.response.usage===null);
});

test('readonly plan orchestration never presents partial usage as a complete settled cost',async()=>{
 const gateway={config:{MaxOutputTokens:2048},executeStep:async(_task:AgentTask,_signal:AbortSignal,step:ModelStep)=>{
  if(step.role==='creative.plan.planner')return responseFor(step);
  throw new GatewayError('LLM_HTTP_ERROR',{text:'',usage:null,modelCalls:1});
 }};
 await assert.rejects(()=>orchestratePlanCheck(task(),gateway,new AbortController().signal),(error)=>{
  if(!(error instanceof GatewayError))return false;
  assert.equal(error.response.stepResults?.length,4);
  assert.equal(error.response.stepResults?.filter(step=>step.status==='failed'&&step.usage===null).length,3);
  assert(error.response.stepResults?.every(step=>step.durationMs>=0));
  assert.deepEqual(error.response.stepResults?.map(step=>step.callIndex),[1,2,3,4]);
  return error.code==='LLM_HTTP_ERROR'&&error.response.modelCalls===4&&error.response.usage===null;
 });
});

test('readonly plan admission denial is not reported as a model call or step result',async()=>{
 const gateway={config:{MaxOutputTokens:2048},executeStep:async(_task:AgentTask,_signal:AbortSignal,step:ModelStep)=>{
  if(step.role==='creative.plan.coordinator')throw new GatewayError('AGENT_CONFIG_CHANGED',{text:'',usage:null});
  return responseFor(step);
 }};
 await assert.rejects(()=>orchestratePlanCheck(task(),gateway,new AbortController().signal),(error)=>{
  if(!(error instanceof GatewayError))return false;
  assert.equal(error.code,'AGENT_CONFIG_CHANGED');
  assert.equal(error.response.modelCalls,4);
  assert.deepEqual(error.response.usage,{inputTokens:400,outputTokens:80,cachedInputTokens:0});
  assert.deepEqual(error.response.stepResults?.map(step=>step.callIndex),[1,2,3,4]);
  assert(error.response.stepResults?.every(step=>step.status==='completed'));
  return true;
 });
});

test('readonly plan orchestration aborts parallel siblings when one role fails',async()=>{
 let aborted=0;
 const gateway={config:{MaxOutputTokens:2048},executeStep:async(_task:AgentTask,signal:AbortSignal,step:ModelStep)=>{
  if(step.role==='creative.plan.planner')return responseFor(step);
  if(step.role==='creative.plan.critic')throw new GatewayError('LLM_HTTP_ERROR');
  return new Promise<AgentModelResponse>((_resolve,reject)=>{
   signal.addEventListener('abort',()=>{aborted++;reject(new GatewayError('CREATIVE_INTERRUPTED'))},{once:true});
  });
 }};
 await assert.rejects(()=>orchestratePlanCheck(task(),gateway,new AbortController().signal),/LLM_HTTP_ERROR/);
 assert.equal(aborted,2);
});
