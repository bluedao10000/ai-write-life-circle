import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Tx} from '@earendil-works/pi-durable';
import {PiHost,AgentError} from '../src/runtime/pi-host.js';
import {Store,type Saved,type ExecutionFence} from '../src/sessions/store.js';
import type {Config} from '../src/config.js';

const deferred=()=>{
 let resolve!:()=>void;
 const promise=new Promise<void>(ready=>{resolve=ready});
 return {promise,resolve};
};
const listen=async(server:ReturnType<typeof createServer>)=>{
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
};
async function fixture(maxConcurrentSessions=2){
 const state=mkdtempSync(join(tmpdir(),'pi-durable-lifecycle-'));let calls=0;
 const provider=createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders()});
 const endpoint=await listen(provider);
 const model:Config['model']={modelId:'a',provider:'fixture',model:'a',endpoint,protocol:'thinking-v1',limits:{maxTurnsPerRequest:2,maxToolCalls:2,maxInputTokens:32000,maxOutputTokens:512,maxSessionTokens:500000,maxConcurrentSessions:1,maxDurationMs:5000,maxToolResultBytes:24000}};
 const models=[model,{...model,modelId:'b',model:'b'}];
 const grants=new Map<string,Config['model']>();
 const story=createServer((req,res)=>{const id=req.headers.authorization!.slice(7);res.setHeader('content-type','application/json');res.end(JSON.stringify({sessionId:id,authorId:'a',bookId:'b',model:grants.get(id),scopes:[]}))});
 const config:Config={state,port:1,version:'test',key:'fixture',token:'fixture',model,models:models.map(model=>({model,key:'fixture',enabled:true,description:''})),maxConcurrentSessions,storyOrigin:await listen(story)};
 let host=new PiHost(config,new Store(state));await host.ready;
 return {
  get host(){return host},get calls(){return calls},
  async create(index=0){const id='th-'+randomUUID();grants.set(id,models[index]);await host.create({sessionId:id,authorId:'a',bookId:'b',model:models[index],scopes:[],createdAt:'now',capability:id});return id},
  select(id:string,index:number){grants.set(id,models[index])},
  accept(id:string,key='one'){return host.accept(id,{text:'Synthetic input',modelId:grants.get(id)!.modelId},key,id)},
  async restart(){await host.close();host=new PiHost(config,new Store(state));await host.ready},
  async close(){await host.close();provider.closeAllConnections();story.closeAllConnections();await Promise.all([new Promise<void>(resolve=>provider.close(()=>resolve())),new Promise<void>(resolve=>story.close(()=>resolve()))]);rmSync(state,{recursive:true,force:true})},
 };
}
async function holdConversation(host:PiHost,id:string){
 const runtime=await host.store.runtime(id),entered=deferred(),release=deferred();
 const create=runtime.harness.createConversation.bind(runtime.harness);
 runtime.harness.createConversation=async(...args)=>{entered.resolve();await release.promise;return create(...args)};
 return {entered:entered.promise,release:release.resolve};
}
function cancellationCommitted(store:Store,id:string){
 const committed=deferred(),write=store.write.bind(store),initialEpoch=store.read(id)!.epoch??0;
 store.write=async<T>(value:Saved,mutate?: (tx:Tx)=>T|Promise<T>,fence?:ExecutionFence)=>{
  const result=await write(value,mutate,fence);
  if(value.view.sessionId===id&&(value.epoch??0)>initialEpoch&&!value.executionLease)committed.resolve();
  return result;
 };
 return committed.promise;
}

test('cancel during asynchronous conversation creation fences the admission transaction',{timeout:15000},async()=>{
 const f=await fixture(),id=await f.create(),gate=await holdConversation(f.host,id);
 try{
  const admitted=f.accept(id),rejected=assert.rejects(admitted,error=>error instanceof AgentError&&error.code==='SESSION_INTERRUPTED');
  await gate.entered;
  const committed=cancellationCommitted(f.host.store,id),cancelled=f.host.cancel(id);await committed;gate.release();
  await Promise.all([rejected,cancelled]);
  const value=f.host.get(id);assert.equal(value.view.status,'idle');assert.equal(value.view.messages.length,0);assert.equal(value.view.run,undefined);assert.equal(f.calls,0);
 }finally{gate.release();await f.close()}
});

for(const action of ['cancel','close'] as const)test(`${action} terminalizes an accepted Durable task before its run handler starts`,{timeout:15000},async()=>{
 const f=await fixture(),id=await f.create(),entered=deferred(),release=deferred();
 try{
  const runtime=await f.host.store.runtime(id),setRun=runtime.setRun.bind(runtime);
  runtime.setRun=handler=>setRun(async(...args)=>{entered.resolve();await release.promise;await handler(...args)});
  await f.accept(id);await entered.promise;
  const committed=cancellationCommitted(f.host.store,id),cancelled=action==='cancel'?f.host.cancel(id):f.host.close();
  await committed;release.resolve();await cancelled;
  if(action==='close')await f.restart();
  const value=f.host.get(id);assert.equal(value.view.status,'idle');assert.equal(value.view.run?.status,'cancelled');assert.equal(value.view.run?.resumable,false);assert.equal(value.view.run?.modelCalls,0);assert.equal(value.view.messages.at(-1)?.status,'cancelled');assert.equal(f.calls,0);
  assert.equal(value.events.filter(event=>event.type==='session_completed').length,1);
 }finally{release.resolve();await f.close()}
});

for(const kind of ['process','model-switch'] as const)test(`asynchronous ${kind} admission reserves capacity before creating a conversation`,{timeout:15000},async()=>{
 const f=await fixture(kind==='process'?1:2),first=await f.create(),second=await f.create(1),gate=await holdConversation(f.host,first);
 try{
  if(kind==='model-switch')f.select(first,1);
  const admitted=f.accept(first);await gate.entered;
  await assert.rejects(f.accept(second),error=>error instanceof AgentError&&error.code==='AGENT_BUSY');
  gate.release();await admitted;await f.host.cancel(first);
  assert.equal(f.host.get(second).view.messages.length,0);
 }finally{gate.release();await f.close()}
});
