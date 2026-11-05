import {executeStorageEvaluation} from './storage-fault.js';
import {EvaluationFailure} from './runner.js';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Type} from 'typebox';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import type {AgentTask,ThinkingMessage} from '@writer-agent/contracts';
import {PiHost} from '../runtime/pi-host.js';
import {Store} from '../sessions/store.js';
import {EventStore} from '../sessions/event-store.js';
import {ModelGateway,executionConfigSchema,executionFingerprint} from '../runtime/model-gateway.js';
import {executeTask,validateTask} from '../worker/dispatcher.js';
import {executionContext,governTool} from '../runtime/governance/index.js';
import {manageDiscussion} from '../runtime/context-management.js';
import {currentWorkingMemory} from '../memory/working-memory.js';
import type {Config} from '../config.js';
import type {EvaluationTask,Observation} from './task-schema.js';
const empty=():Observation=>({metrics:{},trace:[],inputTokens:0,outputTokens:0,chargedTokens:0,modelCalls:0,toolCalls:0});
const listen=async(server:ReturnType<typeof createServer>)=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as {port:number}).port}`};
const close=async(server:ReturnType<typeof createServer>)=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))};
export async function executeEvaluation(task:EvaluationTask,signal:AbortSignal):Promise<Observation>{
 const result=empty();
 try{return await execute(task,signal,result)}catch{throw new EvaluationFailure(result)}
}
async function execute(task:EvaluationTask,signal:AbortSignal,result:Observation):Promise<Observation>{
 signal.throwIfAborted();
 if(task.environment.scenario.startsWith('storage-'))return executeStorageEvaluation(task,signal,result);
 if(task.environment.scenario.startsWith('consolidation-')){
  const modulePath=new URL('../../../../scripts/lib/evaluation-consolidation.mjs',import.meta.url).href;
  const {executeConsolidationEvaluation}=await import(modulePath) as {executeConsolidationEvaluation:(task:EvaluationTask,signal:AbortSignal,result:Observation)=>Promise<Observation>};
  return executeConsolidationEvaluation(task,signal,result);
 }
 if(task.environment.scenario.startsWith('extraction-')){
  const modulePath=new URL('../../../../scripts/lib/evaluation-extraction.mjs',import.meta.url).href;
  const {executeExtractionEvaluation}=await import(modulePath) as {executeExtractionEvaluation:(task:EvaluationTask,signal:AbortSignal,result:Observation)=>Promise<Observation>};
  return executeExtractionEvaluation(task,signal,result);
 }
 if(task.environment.scenario.startsWith('security-')){
  const modulePath=new URL('../../../../scripts/lib/evaluation-security.mjs',import.meta.url).href;
  const {executeSecurityEvaluation}=await import(modulePath) as {executeSecurityEvaluation:(task:EvaluationTask,signal:AbortSignal,result:Observation)=>Promise<Observation>};
  return executeSecurityEvaluation(task,signal,result);
 }
 if(task.environment.scenario.startsWith('thinking-')){
  const modulePath=new URL('../../../../scripts/lib/evaluation-thinking.mjs',import.meta.url).href;
  const {executeThinkingEvaluation}=await import(modulePath) as {executeThinkingEvaluation:(task:EvaluationTask,signal:AbortSignal,result:Observation)=>Promise<Observation>};
  return executeThinkingEvaluation(task,signal,result);
 }
 if(task.environment.scenario.startsWith('procedural-')||task.environment.scenario==='creative-expiry'||task.environment.scenario==='creative-plan-comparison'||task.environment.scenario==='creative-plan-failure'||task.environment.scenario.startsWith('review-')||task.environment.scenario.startsWith('knowledge-')||task.environment.scenario.endsWith('-business')){
  const modulePath=new URL('../../../../scripts/lib/evaluation-business.mjs',import.meta.url).href;
  const {executeBusinessEvaluation}=await import(modulePath) as {executeBusinessEvaluation:(task:EvaluationTask,signal:AbortSignal,result:Observation)=>Promise<Observation>};
  return executeBusinessEvaluation(task,signal,result);
 }
 if(task.environment.scenario==='tool-denial'){
  const execution=executionContext({executionId:task.taskId,traceId:task.taskId,role:'thinking',authorizationVersion:1,scopes:task.environment.initialState.scope,deadline:Date.now()+task.stoppingCriteria.timeoutMs,signal});
  let executed=0,denied=false;
  const tool=governTool({name:'read_private',description:'synthetic restricted resource',parameters:Type.Object({query:Type.String()},{additionalProperties:false}),replay:'safe',execute:async()=>{executed++;return {output:[{type:'text',text:'synthetic private resource'}]}}},{name:'read_private',risk:'read',replay:'safe',requiredScopes:['private'],maxInputBytes:4096,maxOutputBytes:4096,timeoutMs:1000,idempotencyRequired:false},execution,{authorize:async()=>{throw Error('AUTHORIZATION_REVOKED')}});
  try{await tool.execute({query:task.request},{} as never,BACKGROUND_CONTEXT)}catch{denied=true}
  result.toolCalls=1;result.trace.push({action:denied?'denied':'executed',name:'read_private'});result.metrics={denied,unauthorizedCalls:executed};return result;
 }
 if(task.environment.scenario==='event-recovery'){
  const dir=mkdtempSync(join(tmpdir(),'agent-eval-events-')),path=join(dir,'events.sqlite');let store=new EventStore(path,task.taskId);
  try{
   const count=task.environment.initialState.events;
   for(let first=0;first<count;first+=200){signal.throwIfAborted();store.append(Array.from({length:Math.min(200,count-first)},(_,n)=>({id:first+n+1,type:'text_delta',text:'synthetic'})))}
   const cursor=store.cursor();store.close();store=new EventStore(path,task.taskId);
   if(cursor)store.append([{id:cursor,type:'text_delta',text:'synthetic'}]);
   let after=0,total=0;const started=performance.now();
   while(after<cursor){signal.throwIfAborted();const page=store.read(after,137);if(!page.length)throw Error('CURSOR_STALLED');total+=page.length;after=page.at(-1)!.id}
   result.metrics={cursorPreserved:store.cursor()===cursor,duplicateEvents:store.count()-count,eventCount:total,paginationMs:performance.now()-started,sqliteBytes:statSync(path).size};result.trace.push({action:'reopened'},{action:'replayed'},{action:'paged'});return result;
  }finally{store.close();rmSync(dir,{recursive:true,force:true})}
 }
 if(task.environment.scenario==='discussion-memory'){
  const messages:ThinkingMessage[]=Array.from({length:task.environment.initialState.messages},(_,index)=>({id:String(index),role:index%2?'assistant':'user',text:task.request.repeat(12),sources:[],status:'completed',createdAt:'synthetic'}));
  let summaries=0;
  const memory=await manageDiscussion(messages,undefined,16000,'synthetic discussion',async()=>{signal.throwIfAborted();summaries++;return '用户决定和未确认假设需分别保留。'});
  const changed=messages.map((message,index)=>index===0?{...message,id:'replaced-source'}:message);
  result.metrics={compacted:!!memory,retainedMessages:messages.length-(memory?.through??0),summaryBytes:memory?Buffer.byteLength(memory.summary):0,summaries,semanticRecall:null,provenanceComplete:!!memory&&currentWorkingMemory(messages,memory)===memory,staleSourcesRejected:!!memory&&currentWorkingMemory(changed,memory)===undefined,memorySchemaVersion:memory?.provenance?.schemaVersion??null};result.trace.push({action:'discussion_compaction'});return result;
 }
 if(task.stoppingCriteria.maxModelCalls<1)throw Error('EVAL_MODEL_BUDGET');
 const payload=task.capability==='review'?'{"findings":[]}':task.capability==='knowledge'?'{"entities":[],"assertions":[]}':task.capability==='creative'?'{"proposals":[]}':'这些是候选建议，需要作者确认。';
 const provider=createServer(async(req,res)=>{
  for await(const chunk of req){void chunk}
  result.modelCalls++;result.inputTokens=null;result.outputTokens=null;result.chargedTokens=null;
  if(result.modelCalls>task.stoppingCriteria.maxModelCalls||400*result.modelCalls>task.stoppingCriteria.maxTokens){res.writeHead(429);res.end('{}');return}
  result.trace.push({action:'model_request'});res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:payload},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20}})+'\n\ndata: [DONE]\n\n');
 });
 const endpoint=await listen(provider);
 try{
  if(task.capability!=='thinking'){
   const cfg=executionConfigSchema.parse({Provider:'openai-compatible',BaseURL:endpoint,APIKey:'',Model:'fixture',ResponseFormat:'json_object',TokenParameter:'max_tokens',Timeout:task.stoppingCriteria.timeoutMs*1e6,MaxContextBytes:16000,MaxOutputTokens:256,MaxResponseBytes:65536});
   const kind=task.capability==='review'?'review.execute':task.capability==='knowledge'?'knowledge.extract':'creative.organize';
   const request:AgentTask={taskId:randomUUID(),kind,bookId:'synthetic',authorId:'synthetic',leaseToken:randomUUID(),executorEpoch:1,attempt:1,deadline:new Date(Date.now()+task.stoppingCriteria.timeoutMs).toISOString(),strategyVersion:task.capability==='review'?'continuity-review-v4':task.capability==='knowledge'?'knowledge-extraction-v1':'creative-v1',revisionId:'synthetic',contentHash:'synthetic',inputHash:'sha256:'+'a'.repeat(64),model:{provider:cfg.Provider,model:cfg.Model,endpoint,execution:'local'},configFingerprint:executionFingerprint(cfg),outputSchemaVersion:task.capability==='review'?'review-candidates-v1':task.capability==='knowledge'?'knowledge-candidates-v1':'creative-organize-candidates-v1',reservedTokens:task.stoppingCriteria.maxTokens,budgetDay:'synthetic',consent:{},request:{system:'Return the synthetic candidate JSON. No tools.',input:task.request,schemaName:task.capability==='creative'?'creative_organize':'synthetic',schema:{type:'object'}}};
   const gateway=new ModelGateway(cfg,'synthetic-only',async()=>{signal.throwIfAborted();result.trace.push({action:'synthetic_admission'})});validateTask(request,gateway);
   const response=await executeTask(request,gateway,signal);
   result.inputTokens=response.usage?.inputTokens??null;result.outputTokens=response.usage?.outputTokens??null;result.chargedTokens=response.usage?response.usage.inputTokens+response.usage.outputTokens:null;
   result.metrics={completed:true,candidateParsed:true,businessCommitted:null};return result;
  }
  const directory=mkdtempSync(join(tmpdir(),'agent-eval-thinking-')),id='th-'+randomUUID();
  const model={provider:'fixture',model:'fixture',endpoint,protocol:'thinking-v1' as const,limits:{maxTurnsPerRequest:task.stoppingCriteria.maxModelCalls,maxToolCalls:Math.max(1,task.stoppingCriteria.maxToolCalls),maxInputTokens:16000,maxOutputTokens:256,maxSessionTokens:task.stoppingCriteria.maxTokens,maxConcurrentSessions:1,maxDurationMs:task.stoppingCriteria.timeoutMs,maxToolResultBytes:4096}};
  const authority=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({sessionId:id,authorId:'synthetic',bookId:'synthetic',model,scopes:[]}))});
  const config:Config={state:directory,port:1,version:'eval',key:'synthetic-only',token:'synthetic',storyOrigin:await listen(authority),model};const host=new PiHost(config,new Store(directory));
  const cancel=()=>{void host.cancel(id).catch(()=>{})};signal.addEventListener('abort',cancel,{once:true});
  try{
   await host.create({sessionId:id,authorId:'synthetic',bookId:'synthetic',createdAt:new Date().toISOString(),model,scopes:[],capability:'synthetic'});signal.throwIfAborted();
   await host.accept(id,{text:task.request},task.taskId,'synthetic');await host.active.get(id)?.done;
   const state=host.store.state(id)!;result.inputTokens=state.view.usage.input;result.outputTokens=state.view.usage.output;result.chargedTokens=state.view.usage.charged;
   result.metrics={completed:state.view.messages.at(-1)?.status==='completed',retainedMessages:state.view.messages.length,unknownUsage:state.view.usage.incomplete};result.trace.push(...(state.execution?.audit??[]).map(event=>({action:event.action})));return result;
  }finally{signal.removeEventListener('abort',cancel);await host.close();await close(authority);rmSync(directory,{recursive:true,force:true})}
 }finally{await close(provider)}
}
