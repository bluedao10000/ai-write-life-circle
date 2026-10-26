import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import type {AgentTask} from '@writer-agent/contracts';
import {ModelGateway,GatewayError,executionConfigSchema} from '../src/runtime/model-gateway.js';
import {systemPrompt,strategy} from '../src/agents/review/prompt.js';
import {executeReview,validateReview} from '../src/agents/review/executor.js';
test('Pi bounded Review keeps prompt, dialect, usage and zero tools/retries',async()=>{
 const requests:Record<string,unknown>[]=[];const requestIds:string[]=[];let missing=false,invalid=false; let cached:number|undefined;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const value=JSON.parse(raw);requests.push(value);requestIds.push(String(req.headers['x-client-request-id']));res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:invalid?'invalid-json':'{"findings":[]}'},finish_reason:'stop'}],...(missing?{}:{usage:{prompt_tokens:33,completion_tokens:8,...(cached===undefined?{}:{prompt_cache_hit_tokens:cached,prompt_tokens_details:{cached_tokens:cached}})}})})+'\n\ndata: [DONE]\n\n')});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
 const config=executionConfigSchema.parse({Provider:'openai-compatible',BaseURL:endpoint,APIKey:'',Model:'fixture',ResponseFormat:'json_schema',TokenParameter:'max_tokens',Timeout:5e9,MaxContextBytes:12000,MaxOutputTokens:2048,MaxResponseBytes:256*1024});
 const task:AgentTask={taskId:crypto.randomUUID(),kind:'review.execute',bookId:'synthetic',authorId:'author',leaseToken:crypto.randomUUID(),executorEpoch:1,attempt:1,deadline:new Date(Date.now()+15000).toISOString(),strategyVersion:strategy,revisionId:'fixture-rev',contentHash:'fixture-hash',inputHash:'sha256:'+'a'.repeat(64),model:{provider:config.Provider,model:config.Model,endpoint,execution:'local'},configFingerprint:JSON.stringify(config),outputSchemaVersion:'review-candidates-v1',reservedTokens:34048,budgetDay:'',consent:{},request:{system:systemPrompt,input:'{"sources":[]}',schemaName:'',schema:{type:'object'}}};
 try{
 const gateway=new ModelGateway(config,'fixture-key');validateReview(task,gateway);
 const value=await executeReview(task,gateway,new AbortController().signal);assert.deepEqual(value.usage,{inputTokens:33,outputTokens:8,cachedInputTokens:0});assert.equal(requests.length,1);assert.equal(requestIds[0],task.taskId);
 const payload=requests[0];assert.equal(payload.max_tokens,2048);assert.equal(payload.max_completion_tokens,undefined);assert.equal(payload.tools,undefined);assert.equal((payload.response_format as {json_schema:{name:string}}).json_schema.name,'writing_review');assert.ok(JSON.stringify(payload).includes(systemPrompt.slice(0,80)));
 cached=20;const hit=await executeReview(task,gateway,new AbortController().signal);assert.deepEqual(hit.usage,{inputTokens:33,outputTokens:8,cachedInputTokens:20});
 cached=34;const invalidCache=await executeReview(task,gateway,new AbortController().signal);assert.equal(invalidCache.usage?.cachedInputTokens,0);
 missing=true;const unknown=await executeReview(task,gateway,new AbortController().signal);assert.equal(unknown.usage,null,'missing usage must remain unknown, not free');
 invalid=true;await assert.rejects(executeReview(task,gateway,new AbortController().signal),(e:unknown)=>e instanceof GatewayError&&e.code==='LLM_INVALID_OUTPUT');assert.equal(requests.length,5,'no automatic model retries');
 const capped=await executeReview({...task,request:{...task.request,outputLimit:512}},gateway,new AbortController().signal).catch(e=>e);assert.ok(capped instanceof GatewayError);assert.equal(requests.at(-1)?.max_tokens,512);
 const wrong={...task,configFingerprint:task.configFingerprint.replace('"MaxOutputTokens":2048','"MaxOutputTokens":4096')};assert.throws(()=>validateReview(wrong,gateway));assert.equal(requests.length,6);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
 const go=await readFile(new URL('../../api-go/internal/review/context.go',import.meta.url),'utf8');const prefix=go.match(/const systemPrompt = `([^`]+)`/)![1];const schema=await readFile(new URL('../../api-go/internal/review/candidate.schema.json',import.meta.url),'utf8');assert.equal(systemPrompt,prefix+schema,'migration must not silently rewrite Go prompt');
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
 const task={kind:'review.execute',taskId:crypto.randomUUID(),configFingerprint:JSON.stringify(scheduler.config.model),model:{provider:'openai-compatible',model:'fixture',endpoint:'http://127.0.0.1:1'},strategyVersion:'old-version',outputSchemaVersion:'review-candidates-v1',request:{system:'obsolete prompt'}} as AgentTask;
 // Test the error path through the public scheduler lifecycle with a deterministic claim.
 let claimed=false;client.check=async()=>{};client.report=async()=>({});client.claim=async()=>{if(claimed)return null;claimed=true;return task};
 await assert.rejects(scheduler.run(new AbortController().signal),/AGENT_CONFIG_CHANGED/);assert.equal(actions,0,'incompatibility must not fail a valid domain task');
});

test('execution contract accepts expanded output usage without accepting unlimited output', async()=>{
 const {agentModelResponseSchema}=await import('@writer-agent/contracts');
 assert.ok(agentModelResponseSchema.safeParse({text:'x'.repeat(512*1024),usage:{inputTokens:65536,outputTokens:131072}}).success);
 assert.equal(agentModelResponseSchema.safeParse({text:'x'.repeat(512*1024+1),usage:{inputTokens:1,outputTokens:1}}).success,false);
 assert.equal(agentModelResponseSchema.safeParse({text:'{}',usage:{inputTokens:1,outputTokens:131073}}).success,false);
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
