import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Config} from '../src/config.js';
import {PiHost,AgentError} from '../src/runtime/pi-host.js';
import {Store} from '../src/sessions/store.js';
const listen=async(s:ReturnType<typeof createServer>)=>{await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(s.address() as {port:number}).port}`};
test('model admission is independent of the default model and still obeys an explicit process ceiling',async()=>{
 const state=mkdtempSync(join(tmpdir(),'pi-concurrency-'));
 const provider=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders()});
 const endpoint=await listen(provider);
 const limits={maxTurnsPerRequest:2,maxToolCalls:2,maxInputTokens:32000,maxOutputTokens:100,maxSessionTokens:200000,maxConcurrentSessions:1,maxDurationMs:4000,maxToolResultBytes:1000};
 const first={modelId:'first',provider:'fixture',model:'first',endpoint,protocol:'thinking-v1' as const,limits};
 const second={...first,modelId:'second',model:'second'};
 const grants=new Map<string,typeof first>();
 const story=createServer((req,res)=>{const id=req.headers.authorization!.slice(7);res.setHeader('content-type','application/json');res.end(JSON.stringify({sessionId:id,authorId:'a',bookId:'b',model:grants.get(id),scopes:[]}))});
 const config:Config={state,port:1,version:'test',key:'fixture',token:'fixture',model:first,models:[{model:first,key:'fixture',enabled:true,description:''},{model:second,key:'fixture',enabled:true,description:''}],storyOrigin:await listen(story)};
 const host=new PiHost(config,new Store(state));
 const create=async(model:typeof first)=>{const id='th-'+randomUUID();grants.set(id,model);await host.create({sessionId:id,authorId:'a',bookId:'b',model,scopes:[],createdAt:'now',capability:id});return id};
 const send=(id:string)=>host.accept(id,{text:'Synthetic waiting reply'},'one',id);
 try {
  const a=await create(first),a2=await create(first),b=await create(second),b2=await create(second);
  await send(a);
  await assert.rejects(send(a2),(e)=>e instanceof AgentError && e.code==='AGENT_BUSY');
  await send(b);assert.equal(host.active.size,2,'a default-model ceiling of one must not block the other model');
  await assert.rejects(send(b2),(e)=>e instanceof AgentError && e.code==='AGENT_BUSY');
  await host.cancel(a);await host.cancel(b);
  config.maxConcurrentSessions=1;
  await host.accept(a,{text:'New ceiling'},'two',a);
  await assert.rejects(host.accept(b,{text:'Global ceiling'},'two',b),(e)=>e instanceof AgentError && e.code==='AGENT_BUSY');
 } finally {await host.close();provider.closeAllConnections();story.closeAllConnections();provider.close();story.close();rmSync(state,{recursive:true,force:true})}
});
