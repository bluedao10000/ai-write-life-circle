import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {systemPrefix,systemPrompt,schema} from '../src/agents/knowledge/prompt.js';
import {knowledgeCandidates} from '../src/agents/knowledge/schema.js';
test('Knowledge fixed prompt preserves Go v1 and byte-limited candidates',async()=>{
 const source=await readFile(new URL('../../api-go/internal/knowledge/extraction.go',import.meta.url),'utf8');
 assert.equal(systemPrefix,source.match(/const SystemPrompt = `([^`]+)`/)![1]);assert.equal(systemPrompt,systemPrefix+JSON.stringify(schema));
 const entity={key:'e',type:'character',name:'林舟',aliases:[],identity:''};const assertion={entityKey:'e',predicate:'身份',text:'林舟是医师。',epistemic:'observation',sourceKind:'narration',quote:'林舟是医师。'};
 assert.ok(knowledgeCandidates.safeParse({entities:[entity],assertions:[assertion]}).success);
 assert.equal(knowledgeCandidates.safeParse({entities:[{...entity,name:'林'.repeat(41)}],assertions:[assertion]}).success,false,'UTF-8 bytes, not JS length');
 assert.equal(knowledgeCandidates.safeParse({entities:[entity],assertions:[{...assertion,epistemic:'canon'}]}).success,false);
 assert.ok(knowledgeCandidates.safeParse({entities:[{...entity,name:'\ufeff'}],assertions:[assertion]}).success,'Go does not classify BOM as whitespace');
 assert.ok(knowledgeCandidates.safeParse({entities:[],assertions:[]}).success);
});
test('Pi SDK accepts Knowledge above the former 96 KiB candidate limit and preserves Review isolation',async()=>{
 const {createServer}=await import('node:http');const {ModelGateway,GatewayError,executionConfigSchema}=await import('../src/runtime/model-gateway.js');const {executeKnowledge,validateKnowledge}=await import('../src/agents/knowledge/executor.js');
 const count=110;const output=()=>({entities:[{key:'e',type:'character',name:'林舟',aliases:[],identity:''}],assertions:Array.from({length:count},(_,i)=>({entityKey:'e',predicate:'observation-'+i,text:'x'.repeat(900),epistemic:'observation',sourceKind:'narration',quote:'林舟'}))});
 const server=createServer(async(req,res)=>{for await(const chunk of req){void chunk}res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:JSON.stringify(output())},finish_reason:'stop'}],usage:{prompt_tokens:33,completion_tokens:8}})+'\n\ndata: [DONE]\n\n')});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const cfg=executionConfigSchema.parse({Provider:'openai-compatible',BaseURL:endpoint,APIKey:'',Model:'fixture',ResponseFormat:'none',TokenParameter:'max_tokens',Timeout:5e9,MaxContextBytes:12000,MaxOutputTokens:131072,MaxResponseBytes:1024*1024});
 const task:import('@writer-agent/contracts').AgentTask={taskId:crypto.randomUUID(),kind:'knowledge.extract',bookId:'synthetic-large-output',authorId:'fixture-author',leaseToken:crypto.randomUUID(),executorEpoch:1,attempt:1,deadline:new Date(Date.now()+30000).toISOString(),strategyVersion:'knowledge-extraction-v1',revisionId:'fixture-revision',contentHash:'sha256:'+'a'.repeat(64),inputHash:'sha256:'+'b'.repeat(64),model:{provider:cfg.Provider,model:cfg.Model,endpoint,execution:'local'},configFingerprint:JSON.stringify(cfg),outputSchemaVersion:'knowledge-candidates-v1',reservedTokens:1000,budgetDay:'2026-10-22',consent:{},request:{system:systemPrompt,input:'{}',schemaName:'knowledge_extraction',schema}};
 try{
  const gateway=new ModelGateway(cfg,'synthetic-only');validateKnowledge(task,gateway);const result=await executeKnowledge(task,gateway,new AbortController().signal);assert.ok(Buffer.byteLength(result.text)>96*1024);assert.ok(Buffer.byteLength(result.text)<=512*1024);
  await assert.rejects(gateway.execute({...task,kind:'review.execute'},new AbortController().signal),(e:unknown)=>e instanceof GatewayError&&e.code==='LLM_RESPONSE_TOO_LARGE');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
});
