import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AgentModelResponse,AgentTask} from '@writer-agent/contracts';
import {ModelGateway,GatewayError,executionConfigSchema,executionFingerprint,configuredModel,boundedModelFetch} from '../src/runtime/model-gateway.js';
import {strategy,validateReviewPrompt} from '../src/agents/review/prompt.js';
const systemPrompt = 'Review the supplied sources. Return JSON with findings.';
import {executeReview,validateReview} from '../src/agents/review/executor.js';
test('Models awaits the final payload hook and keeps provider credentials isolated',async()=>{
 const requests:{payload:Record<string,unknown>;authorization:string|undefined}[]=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({payload:JSON.parse(raw),authorization:req.headers.authorization});res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
 try{
  const first=await configuredModel(endpoint,'fixture','first-key',4096,256),second=await configuredModel(endpoint,'fixture','second-key',4096,256);
  let entered!:()=>void,release!:()=>void;
  const enteredHook=new Promise<void>(r=>{entered=r}),releasedHook=new Promise<void>(r=>{release=r});
  const result=first.runtime.completeSimple(first.model,{messages:[{role:'user',content:'original',timestamp:0}]},{maxRetries:0,async onPayload(value){entered();await releasedHook;return {...value as Record<string,unknown>,messages:[{role:'user',content:'authorized payload'}]}}});
  await enteredHook;assert.equal(requests.length,0,'authorization and reservation hooks must finish before transport');release();
  assert.equal((await result).stopReason,'stop');
  await second.runtime.completeSimple(second.model,{messages:[{role:'user',content:'second',timestamp:0}]},{maxRetries:0});
  assert.deepEqual(requests.map(r=>r.authorization),['Bearer first-key','Bearer second-key']);
  assert.deepEqual(requests[0].payload.messages,[{role:'user',content:'authorized payload'}]);
  const blocked=await first.runtime.completeSimple(first.model,{messages:[{role:'user',content:'blocked',timestamp:0}]},{maxRetries:0,onPayload(){throw Error('GRANT_REVOKED')}});
  assert.equal(blocked.stopReason,'error');assert.equal(requests.length,2,'rejected final payload must never reach the provider');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
});
test('bounded transport honors SDK cancellation and business cancellation',async()=>{
 let requests=0;const server=createServer((_req,res)=>{requests++;res.end('{}')});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,url=endpoint+'/chat/completions';
 try{
  const authority=new AbortController(),sdk=new AbortController();sdk.abort();
  const bounded=boundedModelFetch(endpoint,1024,authority.signal);
  await assert.rejects(bounded(url,{signal:sdk.signal}),{name:'AbortError'});
  await assert.rejects(bounded(new Request(url,{signal:sdk.signal})),{name:'AbortError'});
  authority.abort();await assert.rejects(bounded(url,{signal:new AbortController().signal}),{name:'AbortError'});
  assert.equal(requests,0);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
});
test('Pi bounded Review sends the task prompt and preserves dialect, usage and zero tools/retries',async()=>{
 const requests:Record<string,unknown>[]=[];const requestIds:string[]=[],governance:string[]=[];let missing=false,invalid=false,oversized=false; let cached:number|undefined;
 const originalLog=console.log;console.log=(line:unknown)=>{if(String(line).includes('"event":"agent_governance"'))governance.push(String(line))};
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const value=JSON.parse(raw);requests.push(value);requestIds.push(String(req.headers['x-client-request-id']));res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:oversized?'x'.repeat(4096):invalid?'invalid-json':'{"findings":[]}'},finish_reason:'stop'}],...(missing?{}:{usage:{prompt_tokens:33,completion_tokens:8,...(cached===undefined?{}:{prompt_cache_hit_tokens:cached,prompt_tokens_details:{cached_tokens:cached}})}})})+'\n\ndata: [DONE]\n\n')});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
 const config=executionConfigSchema.parse({Provider:'openai-compatible',BaseURL:endpoint,APIKey:'',Model:'fixture',ResponseFormat:'json_schema',TokenParameter:'max_tokens',Timeout:5e9,MaxContextBytes:12000,MaxOutputTokens:2048,MaxResponseBytes:256*1024});
 const task:AgentTask={taskId:crypto.randomUUID(),kind:'review.execute',bookId:'synthetic',authorId:'author',leaseToken:crypto.randomUUID(),executorEpoch:1,attempt:1,deadline:new Date(Date.now()+15000).toISOString(),strategyVersion:strategy,revisionId:'fixture-rev',contentHash:'fixture-hash',inputHash:'sha256:'+'a'.repeat(64),model:{provider:config.Provider,model:config.Model,endpoint,execution:'local'},configFingerprint:executionFingerprint(config),outputSchemaVersion:'review-candidates-v1',reservedTokens:34048,budgetDay:'',consent:{},request:{system:systemPrompt,input:'{"sources":[]}',schemaName:'',schema:{type:'object'}}};
 try{
 const blockedGateway=new ModelGateway(config,'fixture-key',async()=>{throw Error('SYNTHETIC_STARTED_REJECTED')});
 await assert.rejects(executeReview(task,blockedGateway,new AbortController().signal),(error:unknown)=>error instanceof GatewayError&&error.code==='MODEL_REQUEST_NOT_ADMITTED'&&error.response.modelCalls===undefined);assert.equal(requests.length,0,'Go started rejection must precede network');
 const changedGateway=new ModelGateway(config,'fixture-key',async()=>{throw Error('AGENT_CONFIG_CHANGED')});
 await assert.rejects(executeReview(task,changedGateway,new AbortController().signal),(error:unknown)=>error instanceof GatewayError&&error.code==='AGENT_CONFIG_CHANGED'&&error.response.modelCalls===undefined);assert.equal(requests.length,0,'changed execution policy must remain a no-call admission failure');
 const closedGateway=new ModelGateway(config,'fixture-key');
 await assert.rejects(executeReview(task,closedGateway,new AbortController().signal));assert.equal(requests.length,0,'missing business adapter must fail closed');
 const gateway=new ModelGateway(config,'fixture-key',async()=>{});validateReview(task,gateway);
 const value=await executeReview(task,gateway,new AbortController().signal);assert.deepEqual(value.usage,{inputTokens:33,outputTokens:8,cachedInputTokens:0});assert.equal(requests.length,1);assert.equal(requestIds[0],task.taskId);
 const payload=requests[0];assert.equal(payload.max_tokens,2048);assert.equal(payload.max_completion_tokens,undefined);assert.equal(payload.tools,undefined);assert.equal((payload.response_format as {json_schema:{name:string}}).json_schema.name,'writing_review');assert.ok(JSON.stringify(payload).includes(systemPrompt.slice(0,80)));
 cached=20;const hit=await executeReview(task,gateway,new AbortController().signal);assert.deepEqual(hit.usage,{inputTokens:33,outputTokens:8,cachedInputTokens:20});
 cached=34;const invalidCache=await executeReview(task,gateway,new AbortController().signal);assert.equal(invalidCache.usage?.cachedInputTokens,0);
 missing=true;const unknown=await executeReview(task,gateway,new AbortController().signal);assert.equal(unknown.usage,null,'missing usage must remain unknown, not free');
 invalid=true;await assert.rejects(executeReview(task,gateway,new AbortController().signal),(e:unknown)=>e instanceof GatewayError&&e.code==='LLM_INVALID_OUTPUT');assert.equal(requests.length,5,'no automatic model retries');
 const capped=await executeReview({...task,request:{...task.request,outputLimit:512}},gateway,new AbortController().signal).catch(e=>e);assert.ok(capped instanceof GatewayError);assert.equal(requests.at(-1)?.max_tokens,512);
 const tuned = new ModelGateway({...config,MaxOutputTokens:4096,Timeout:10e9},'fixture-key',async()=>{});assert.doesNotThrow(()=>validateReview(task,tuned));
 const changedPrompt = {...task,request:{...task.request,system:'Use concise Chinese margin notes.'}};assert.doesNotThrow(()=>validateReview(changedPrompt,gateway));
 invalid=false;await executeReview(changedPrompt,gateway,new AbortController().signal);assert.equal((requests.at(-1)?.messages as {content:string}[])[0].content,changedPrompt.request.system);
 const lower = new ModelGateway({...config,MaxOutputTokens:256},'fixture-key',async()=>{});
 await executeReview({...task,request:{...task.request,outputLimit:512}},lower,new AbortController().signal);assert.equal(requests.at(-1)?.max_tokens,256);
 const wrong={...task,model:{...task.model,model:'another-model'}};assert.throws(()=>validateReview(wrong,gateway));assert.equal(requests.length,8);
 oversized=true;
 const limited=new ModelGateway({...config,MaxResponseBytes:1024},'fixture-key',async()=>{});
 await assert.rejects(executeReview(task,limited,new AbortController().signal),(e:unknown)=>e instanceof GatewayError&&e.code==='LLM_RESPONSE_TOO_LARGE'&&e.response.modelCalls===1);
 const events=governance.map(line=>JSON.parse(line) as {action:string;modelRequestId?:string});
 assert(events.some(event=>event.action==='failed'&&event.modelRequestId===task.taskId+':review.execute:1'));
 assert.equal(events.filter(event=>event.modelRequestId===task.taskId+':review.execute:1'&&event.action==='model_started').length,requests.length);
 }finally{console.log=originalLog;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
});
test('Review candidate Unicode limits match Go rune counts',async()=>{
 const {reviewCandidates}=await import('../src/agents/review/schema.js');
 const finding={type:'character_consistency',title:'😀'.repeat(120),inference:'推断',question:'问题',alternativeExplanation:'另一种解释',evidence:[{sourceId:'a',quote:'原文甲'},{sourceId:'b',quote:'原文乙'}]};
 assert.equal(reviewCandidates.safeParse({findings:[finding]}).success,true);
 assert.equal(reviewCandidates.safeParse({findings:[{...finding,title:'😀'.repeat(121)}]}).success,false);
});
test('stale executor stops before started or fail; no model call',async()=>{
 const {Scheduler}=await import('../src/worker/scheduler.js');
 const scheduler=new Scheduler({slots:1,kinds:['review'],version:'fixture',origin:'http://127.0.0.1:1',token:'fixture',key:'fixture',model:executionConfigSchema.parse({Provider:'openai-compatible',BaseURL:'http://127.0.0.1:1',APIKey:'',Model:'fixture',ResponseFormat:'none',TokenParameter:'max_tokens',Timeout:1e9,MaxContextBytes:12000,MaxOutputTokens:2048,MaxResponseBytes:256*1024})});
 let actions=0;const client=scheduler.client;client.action=async()=>{actions++;throw Error('must never call')};
 const task={kind:'review.execute',taskId:crypto.randomUUID(),configFingerprint:executionFingerprint(scheduler.config.model),model:{provider:'openai-compatible',model:'fixture',endpoint:'http://127.0.0.1:1'},strategyVersion:'old-version',outputSchemaVersion:'review-candidates-v1',request:{system:'obsolete prompt'}} as AgentTask;
 // Test the error path through the public scheduler lifecycle with a deterministic claim.
 let claimed=false;client.check=async()=>{};client.report=async()=>({});client.claim=async()=>{if(claimed)return null;claimed=true;return task};
 await assert.rejects(scheduler.run(new AbortController().signal),/AGENT_CONFIG_CHANGED/);assert.equal(actions,0,'incompatibility must not fail a valid domain task');
});

test('admission policy change is recorded before stopping an incompatible worker',async()=>{
 const {Scheduler}=await import('../src/worker/scheduler.js');
 const scheduler=new Scheduler({slots:1,kinds:['creative'],version:'fixture',origin:'http://127.0.0.1:1',token:'fixture',key:'fixture',model:executionConfigSchema.parse({Provider:'openai-compatible',BaseURL:'http://127.0.0.1:1/v1',APIKey:'',Model:'fixture',ResponseFormat:'none',TokenParameter:'max_tokens',Timeout:1e9,MaxContextBytes:12000,MaxOutputTokens:2048,MaxResponseBytes:256*1024})});
 const value:AgentTask={taskId:crypto.randomUUID(),kind:'creative.plan_check',bookId:'book',authorId:'author',leaseToken:crypto.randomUUID(),executorEpoch:1,attempt:1,deadline:new Date(Date.now()+15000).toISOString(),strategyVersion:'creative-plan-check-readonly-v1',revisionId:'revision',contentHash:'sha256:'+'a'.repeat(64),inputHash:'sha256:'+'b'.repeat(64),model:{provider:'openai-compatible',model:'fixture',endpoint:'http://127.0.0.1:1/v1',execution:'local'},configFingerprint:executionFingerprint(scheduler.config.model),outputSchemaVersion:'creative-plan-check-candidates-v2',reservedTokens:10000,budgetDay:'fixture',consent:{},request:{system:'fixture',input:JSON.stringify({chapterTitle:'chapter',chapterText:'text',plans:[{assetId:'plan',kind:'event',plan:'plan'}]}),schemaName:'creative_plan_check',schema:{type:'object'}}};
 const actions:{action:string;failureCode?:string;response:AgentModelResponse}[]=[];
 scheduler.client.action=async(_task,_action,response={text:'',usage:null},failureCode)=>{actions.push({action:_action,...(failureCode?{failureCode}:{}),response});return {acknowledged:true}};
 scheduler.gateway.executeStep=async(_task,_signal,step)=>{
  if(step.role==='creative.plan.coordinator')throw new GatewayError('AGENT_CONFIG_CHANGED',{text:'',usage:null});
  const text=step.role==='creative.plan.planner'?JSON.stringify({items:[{assetId:'plan',focus:'focus'}]}):step.role==='creative.plan.researcher'?JSON.stringify({findings:[{assetId:'plan',quote:'text',observation:'observation',assessment:'diverged'}]}):step.role==='creative.plan.analyst'?JSON.stringify({analyses:[{assetId:'plan',reasoning:'reasoning',assessment:'diverged'}]}):JSON.stringify({concerns:[{assetId:'plan',concern:'concern'}]});
  return {text,usage:{inputTokens:10,outputTokens:5},modelCalls:1};
 };
 await (scheduler as unknown as {process(task:AgentTask,abort:AbortController):Promise<void>}).process(value,new AbortController());
 assert.equal((scheduler as unknown as {incompatible:boolean}).incompatible,true);
 assert.deepEqual(actions.map(action=>[action.action,action.failureCode]),[['fail','AGENT_CONFIG_CHANGED']]);
 assert.equal(actions[0].response.modelCalls,4,'unadmitted policy failure is not counted as a fifth model call');
 assert.equal(actions[0].response.stepResults?.length,4);
});

test('execution contract accepts expanded output usage without accepting unlimited output', async()=>{
 const {agentModelResponseSchema}=await import('@writer-agent/contracts');
 assert.ok(agentModelResponseSchema.safeParse({text:'x'.repeat(512*1024),usage:{inputTokens:65536,outputTokens:131072}}).success);
 assert.equal(agentModelResponseSchema.safeParse({text:'x'.repeat(512*1024+1),usage:{inputTokens:1,outputTokens:1}}).success,false);
 assert.equal(agentModelResponseSchema.safeParse({text:'{}',usage:{inputTokens:1,outputTokens:131073}}).success,false);
 const step={callIndex:1,status:'completed',durationMs:12.5,usage:{inputTokens:10,outputTokens:5}};
 assert.ok(agentModelResponseSchema.safeParse({text:'{}',usage:{inputTokens:10,outputTokens:5},stepResults:[step]}).success);
 for(const bad of [{...step,callIndex:0},{...step,status:'private'},{...step,durationMs:-1},{...step,usage:{inputTokens:10,outputTokens:-1}}]){
  assert.equal(agentModelResponseSchema.safeParse({text:'{}',usage:null,stepResults:[bad]}).success,false);
 }
 assert.equal(agentModelResponseSchema.safeParse({text:'{}',usage:null,stepResults:Array.from({length:6},(_,index)=>({...step,callIndex:index+1}))}).success,false);
 const base={Provider:'openai-compatible',BaseURL:'https://api.deepseek.com',APIKey:'',Model:'deepseek-flash',ResponseFormat:'json_object',TokenParameter:'max_tokens',Timeout:180e9,MaxContextBytes:65536,MaxOutputTokens:131072,MaxResponseBytes:1024*1024};
 assert.ok(executionConfigSchema.safeParse(base).success);
 assert.equal(executionConfigSchema.safeParse({...base,MaxOutputTokens:131073}).success,false);
 assert.equal(executionConfigSchema.safeParse({...base,MaxResponseBytes:2*1024*1024+1}).success,false);
});

test('task protocol carries configured maximum ASCII request', async()=>{
 const {agentModelRequestSchema}=await import('@writer-agent/contracts');
 const base={system:'fixture',input:'x'.repeat(256*1024),schemaName:'fixture',schema:{}};
 assert.ok(agentModelRequestSchema.safeParse(base).success);
 assert.equal(agentModelRequestSchema.safeParse({...base,input:base.input+'x'}).success,false);
});

test('Review task validation depends on kind, strategy and output schema', () => {
 const task = {kind:'review.execute',strategyVersion:strategy,outputSchemaVersion:'review-candidates-v1',request:{system:'An updated Go prompt'}} as AgentTask;
 assert.doesNotThrow(()=>validateReviewPrompt(task));
 for (const change of [{kind:'knowledge.extract'}, {strategyVersion:'next-strategy'}, {outputSchemaVersion:'next-schema'}]) assert.throws(()=>validateReviewPrompt({...task,...change} as AgentTask),/AGENT_CONFIG_CHANGED/);
});
