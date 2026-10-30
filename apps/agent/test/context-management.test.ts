import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PiHost} from '../src/runtime/pi-host.js';
import {Store} from '../src/sessions/store.js';
import type {Config} from '../src/config.js';
const listen = async (s: ReturnType<typeof createServer>) => {await new Promise<void>(r => s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(s.address() as {port:number}).port}`};
const question = '我想讨论一个问题，什么样的人品才是真正的好人品。我想以明朝的张居正为原型，写一部背景是平行宇宙的科幻小说。';

test('45 Chinese turns compact through real Pi sessions, retain history, switch models and restart', async () => {
  const state = mkdtempSync(join(tmpdir(),'pi-chat-'));
  const id='th-'+randomUUID(); let count=0; let scopes:string[]=[];let mode='chat';let networkTools=0;
  const payloads: Record<string, unknown>[]=[];
  const provider = createServer(async (req,res) => {
    let raw='';for await(const p of req) raw+=p;
    const body=JSON.parse(raw);payloads.push(body);count++;
    assert.equal(req.headers.authorization, body.model === "gpt-oss-fixture" ? "Bearer second-fixture" : "Bearer first-fixture");
    if(mode==='limited') {res.writeHead(429);res.end('{}');return}
    if(mode==='empty') {res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: [DONE]\n\n');return}
    const tool = mode==='loop' && body.tool_choice!=='none';
    if(!scopes.length) assert.equal((body.tools??[]).length,0);
    const delta=tool?{tool_calls:[{index:0,id:'call-'+count,type:'function',function:{name:'search_knowledge',arguments:'{"query":"林舟"}'}}]}:{content:'可以把人品放在权力、责任与代价之间讨论，并将这些作为人物的不同选择。'};
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140}})+'\n\n');res.end('data: [DONE]\n\n');
  });
  const endpoint=await listen(provider);
  const limits={maxTurnsPerRequest:3,maxToolCalls:4,maxInputTokens:32000,maxOutputTokens:1024,maxSessionTokens:1000000,maxConcurrentSessions:2,maxDurationMs:5000,maxToolResultBytes:24000};
  const deepseek={modelId:'deepseek',displayName:'DeepSeek',provider:'deepseek',model:'deepseek-fixture',endpoint,protocol:'thinking-v1' as const,limits};
  const openai={...deepseek,modelId:'gpt-oss',displayName:'OpenAI · GPT-OSS 120B',provider:'bedrock',model:'gpt-oss-fixture',hostedBy:'Amazon Bedrock',tokenParameter:'max_completion_tokens' as const};
  let chosen=deepseek;
  const story=createServer((req,res) => {res.setHeader('content-type','application/json');if(req.url?.endsWith('/authorize'))res.end(JSON.stringify({sessionId:id,authorId:'a',bookId:'b',model:chosen,scopes}));else {networkTools++;res.end('{"items":[],"sources":[]}')}});
  const config:Config={state,port:1,version:'test',key:'fixture',token:'t'.repeat(64),storyOrigin:await listen(story),model:deepseek,models:[{model:deepseek,key:'first-fixture',enabled:true,description:'讨论'},{model:openai,key:'second-fixture',enabled:true,description:'分析'}]};
  let host=new PiHost(config,new Store(state));
  const send=async(text:string,key:string) => {const receipt=await host.accept(id,{text,modelId:chosen.modelId},key,'fixture');await host.active.get(id)?.done;return receipt};
  try {
    await host.create({sessionId:id,authorId:'a',bookId:'b',createdAt:new Date().toISOString(),model:chosen,scopes:[],capability:'fixture'});
    const receipt=await send(question,'first');
    assert.equal(host.get(id).view.messages.at(-1)?.status,'completed');assert.equal(count,1);assert.equal(networkTools,0);
    assert.deepEqual(await send(question,'first'),receipt);assert.equal(count,1);
    for(let i=1;i<45;i++) await send('继续讨论选择 '+i+'。林舟的决定尚未确认，父亲失踪仍是未决问题。'.repeat(12),'next-'+i);
    chosen=openai;await send('从另一个角度继续','switch');
    assert.equal(host.get(id).view.messages.length,92);
    assert.equal(host.get(id).view.messages[1]?.modelId,'deepseek');assert.equal(host.get(id).view.messages.at(-1)?.modelId,'gpt-oss');
    assert(host.get(id).view.messages.some(m=>m.text===question));
    assert(host.get(id).discussionMemory);
    assert(host.get(id).events.some(e=>e.type==="compaction"));
    assert(payloads.every(p=>Buffer.byteLength(JSON.stringify(p)) < 32000));
    assert.equal(payloads.at(-1)?.max_completion_tokens,1024);assert.equal(payloads.at(-1)?.max_tokens,undefined);
    await host.close();host=new PiHost(config,new Store(state));
    assert.equal(host.get(id).view.messages.length,92);
    scopes=['knowledge'];mode='loop';await send('查询作品资料','loop');
    assert.equal(host.get(id).view.messages.at(-1)?.status,'completed');
    assert.equal(networkTools,1,'identical tool lookups are not repeated');
    assert.equal(payloads.at(-1)?.tool_choice,'none','last turn summarizes without tools');
    mode='limited';await send('限流测试','limited');assert.equal(host.get(id).view.messages.at(-1)?.status,'failed');
    mode='empty';await send('空结果测试','empty');assert.equal(host.get(id).view.messages.at(-1)?.status,'failed');
    assert.notEqual(host.get(id).view.messages.at(-1)?.errorCode,undefined);
  } finally {await host.close();provider.closeAllConnections();story.closeAllConnections();provider.close();story.close();rmSync(state,{recursive:true,force:true})}
});

import { manageDiscussion, inputBytes, discussionText } from '../src/runtime/context-management.js';
import { SessionManager } from '@earendil-works/pi-coding-agent';

test('oversized UTF-8 history reproduces the old guard; summary failure preserves originals', async () => {
  const messages = Array.from({length:80},(_,i)=>({id:String(i),role:i%2?'assistant' as const:'user' as const,text:'人物林舟，作者尚未确认，父亲失踪仍待调查。'.repeat(12),status:'completed' as const,sources:[],createdAt:new Date().toISOString()}));
  const before=JSON.stringify(messages);
  assert(inputBytes(discussionText(messages))>32000);
  assert(Buffer.byteLength('人物林舟')> '人物林舟'.length);
  await assert.rejects(manageDiscussion(messages,undefined,32000,'问题',async()=>{throw Error('synthetic failure')}));
  assert.equal(JSON.stringify(messages),before);
  const memory=await manageDiscussion(messages,undefined,32000,'问题',async text=>{
    assert(text.includes('林舟'));return '作者决定：林舟保留姓氏。未决：父亲失踪。假设未确认。';
  });
  assert(memory);
  const manager=SessionManager.inMemory('/tmp');
  manager.appendCustomMessageEntry('discussion-memory',memory.summary,false);
  const reloaded=SessionManager.inMemory('/tmp',undefined,[manager.getHeader()!,...manager.getEntries()]);
  assert(JSON.stringify(reloaded.buildSessionContext()).includes('未决：父亲失踪'));
  assert.equal(JSON.stringify(messages),before);
});
