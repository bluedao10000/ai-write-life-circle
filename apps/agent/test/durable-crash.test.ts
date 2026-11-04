import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {Config} from '../src/config.js';
import type {Saved} from '../src/sessions/store.js';

const listen=async(server:ReturnType<typeof createServer>)=>{
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
};
type ChildMessage={id?:number;event?:string;origin?:string;receipt?:{messageId:string};result?:unknown;error?:string};
async function start(configPath:string){
 const child=fork(fileURLToPath(new URL('./fixtures/durable-child.ts',import.meta.url)),[configPath],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});
 let output='',sequence=0;
 child.stdout!.on('data',chunk=>{output=(output+chunk).slice(-12000)});
 child.stderr!.on('data',chunk=>{output=(output+chunk).slice(-12000)});
 const events:ChildMessage[]=[],waiters:{matches:(message:ChildMessage)=>boolean;resolve:(message:ChildMessage)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}[]=[];
 child.on('message',(message:ChildMessage)=>{
  const index=waiters.findIndex(waiter=>waiter.matches(message));
  if(index<0){events.push(message);return}
  const waiter=waiters.splice(index,1)[0]!;clearTimeout(waiter.timer);waiter.resolve(message);
 });
 child.on('exit',(code,signal)=>{for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(Error(`Child exited (${code??signal}): ${output}`))}});
 const next=(matches:(message:ChildMessage)=>boolean)=>{
  const index=events.findIndex(matches);
  if(index>=0)return Promise.resolve(events.splice(index,1)[0]!);
  return new Promise<ChildMessage>((resolve,reject)=>{
   const timer=setTimeout(()=>{const index=waiters.findIndex(waiter=>waiter.timer===timer);if(index>=0)waiters.splice(index,1);reject(Error(`Child response timed out: ${output}`))},15000);
   waiters.push({matches,resolve,reject,timer});
  });
 };
 let ready:ChildMessage;
 try{ready=await next(message=>message.event==='ready')}catch(error){await kill(child);throw error}
 return {
  child,origin:ready.origin!,next,
  async command<T=unknown>(op:string,sessionId:string){
   const id=++sequence,result=next(message=>message.id===id);child.send({id,op,sessionId});
   const reply=await result;if(reply.error)throw Error(reply.error);return reply.result as T;
  },
 };
}
async function kill(child:ChildProcess){
 if(child.exitCode!==null||child.signalCode!==null)return;
 const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;
}
async function fixture({creative=false}={}){
 const state=mkdtempSync(join(tmpdir(),'pi-durable-crash-')),id='th-'+randomUUID();
 let calls=0,authorizations=0,holdAuthorization=false,mode:'hang'|'ok'|'story'|'length'='hang',providerEntered:()=>void=()=>{},storyCommitted:()=>void=()=>{},storyWrites=0;
 let receipt:{changeId:string;status:'applied';changes:unknown[]}|null=null;
 const scopes:('creative')[]=creative?['creative']:[];
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);
  calls++;providerEntered();res.writeHead(200,{'content-type':'text/event-stream'});
  if(mode==='hang'){res.flushHeaders();return}
  if(mode==='story'&&!payload.messages.some((message:{role:string})=>message.role==='tool')){
   const messageId=JSON.stringify(payload.messages).match(/Current author message: ([a-f0-9-]+)/)?.[1];
   const delta={tool_calls:[{index:0,id:'story-call',type:'function',function:{name:'record_story_changes',arguments:JSON.stringify({changes:[{intent:'decide',kind:'character',patch:{name:'Lin'},evidence:[{messageId,quote:'Synthetic accepted input'}]}]})}}]};
   res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:'tool_calls'}],usage:{prompt_tokens:40,completion_tokens:8,total_tokens:48}})+'\n\ndata: [DONE]\n\n');return;
  }
  for(const content of ['A persisted ','final answer.'])res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:null}]})+'\n\n');
  res.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:mode==='length'?'length':'stop'}],usage:{prompt_tokens:40,completion_tokens:8,total_tokens:48}})+'\n\ndata: [DONE]\n\n');
 });
 const model:Config['model']={provider:'fixture',model:'synthetic',endpoint:await listen(provider),protocol:'thinking-v1',limits:{maxTurnsPerRequest:3,maxToolCalls:3,maxInputTokens:32000,maxOutputTokens:512,maxSessionTokens:500000,maxConcurrentSessions:1,maxDurationMs:30000,maxToolResultBytes:24000}};
 const story=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url?.endsWith('/story-context')){res.end(JSON.stringify({bookId:'b',stateVersion:0,dialogueRecording:creative,focus:null,intent:[],confirmed:[],alternatives:[],rejected:[],questions:[],recentChanges:[]}));return}
  if(req.url?.endsWith('/story-change-receipt')){res.end(JSON.stringify(receipt));return}
  if(req.url?.endsWith('/tools/execute')){
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);storyWrites++;
   receipt={changeId:'committed-change',status:'applied',changes:body.arguments.changes};storyCommitted();return;
  }
  authorizations++;
  if(holdAuthorization&&authorizations>2)return;
  res.end(JSON.stringify({sessionId:id,authorId:'a',bookId:'b',authorizationVersion:0,model,scopes}));
 });
 const config:Config={state,port:1,version:'test',key:'fixture-key',token:'fixture-token',model,storyOrigin:await listen(story)};
 const configPath=join(state,'fixture-config');writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
 let process=await start(configPath);
 const request=async(method:string,path:string,value?:unknown)=>fetch(process.origin+path,{method,headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});
 const sessionPath='/internal/v1/sessions/'+id;
 const input={text:'Synthetic accepted input'},key='stable-request';
 const message=()=>request('POST',sessionPath+'/messages',{input,key,capability:'fixture'});
 const created=await request('POST','/internal/v1/sessions',{sessionId:id,authorId:'a',bookId:'b',createdAt:new Date().toISOString(),model,scopes,capability:'fixture'});
 assert.equal(created.status,201,await created.text());
 return {
  id,state,input,key,sessionPath,request,message,
  get process(){return process},get calls(){return calls},get storyWrites(){return storyWrites},
  mode(value:'hang'|'ok'|'story'|'length'){mode=value},holdAuthorization(value:boolean){holdAuthorization=value},
  entered(){return new Promise<void>(resolve=>{providerEntered=resolve})},
  written(){return new Promise<void>(resolve=>{storyCommitted=resolve})},
  async snapshot(){return process.command<Saved>('snapshot',id)},
  async settled(){return process.command<Saved>('settled',id)},
  async restart(){await kill(process.child);process=await start(configPath)},
  async close(){await kill(process.child);provider.closeAllConnections();story.closeAllConnections();await Promise.all([new Promise<void>(resolve=>provider.close(()=>resolve())),new Promise<void>(resolve=>story.close(()=>resolve()))]);rmSync(state,{recursive:true,force:true})},
 };
}

test('SIGKILL after acceptance but before HTTP response preserves one request and requires explicit recovery',{timeout:45000},async()=>{
 const f=await fixture();try{
  f.holdAuthorization(true);await f.process.command('lose-receipt',f.id);
  const accepted=f.process.next(message=>message.event==='accepted'),request=f.message().then(()=>false,()=>true);
  const receipt=(await accepted).receipt!;
  await f.restart();assert.equal(await request,true);f.holdAuthorization(false);
  const before=await f.snapshot();assert.equal(before.view.run?.status,'interrupted');assert.equal(before.view.run?.modelCalls,0);assert.equal(f.calls,0);
  const retry=await f.message();assert.equal(retry.status,202);assert.deepEqual(await retry.json(),receipt);
  const after=await f.snapshot();assert.equal(after.view.run?.runId,before.view.run?.runId);assert.equal(after.view.run?.attempt,1);assert.equal(after.view.messages.filter(message=>message.role==='user').length,1);assert.equal(f.calls,0);
 }finally{await f.close()}
});

test('SIGKILL during provider request retains unknown reservation without automatic paid replay',{timeout:45000},async()=>{
 const f=await fixture();try{
  const entered=f.entered(),accepted=await f.message();assert.equal(accepted.status,202);const receipt=await accepted.json();await entered;
  const before=await f.snapshot();assert(before.view.usage.charged>0);assert.equal(before.view.usage.incomplete,true);assert.equal(before.view.run?.modelCalls,1);
  await f.restart();
  const after=await f.snapshot();assert.equal(after.view.run?.status,'interrupted');assert.equal(after.view.usage.charged,before.view.usage.charged);assert.equal(after.view.usage.incomplete,true);assert.equal(f.calls,1);
  const retry=await f.message();assert.equal(retry.status,202);assert.deepEqual(await retry.json(),receipt);assert.equal(f.calls,1);
  f.mode('ok');const resumed=await f.request('POST',f.sessionPath+'/messages',{input:{text:'Resume accepted message',recovery:{runId:after.view.run!.runId,confirmAdditionalCost:true}},key:'explicit-recovery',capability:'fixture'});
  assert.equal(resumed.status,202,await resumed.text());const finished=await f.settled();assert.equal(finished.view.run?.status,'completed');assert.equal(finished.view.run?.attempt,2);assert.equal(finished.view.run?.messageId,before.view.run?.messageId);assert.equal(f.calls,2);assert.equal(finished.view.usage.charged,before.view.usage.charged+48);
  assert.deepEqual(finished.attempts?.[before.view.run!.runId]?.execution.modelRequests,before.execution!.modelRequests);
  assert.notEqual(finished.durable?.conversationId,before.durable?.conversationId);
 }finally{await f.close()}
});

for(const action of ['cancel','delete'] as const)test(`${action} followed by SIGKILL cannot resurrect a Durable run`,{timeout:45000},async()=>{
 const f=await fixture();try{
  const entered=f.entered();assert.equal((await f.message()).status,202);await entered;const before=await f.snapshot();
  const response=action==='cancel'?await f.request('POST',f.sessionPath+'/cancel',{}):await f.request('DELETE',f.sessionPath);
  assert.equal(response.status,200,await response.text());await f.restart();
  if(action==='cancel'){
   const after=await f.snapshot();assert.equal(after.view.run?.status,'cancelled');assert.equal(after.view.run?.resumable,false);assert.equal(after.view.messages.at(-1)?.status,'cancelled');
   const retry=await f.message();assert.equal(retry.status,202);
  }else{
   assert.equal((await f.request('GET',f.sessionPath)).status,404);assert.equal((await f.message()).status,404);
   assert.equal(readdirSync(f.state).some(file=>file.startsWith(f.id)&&/\.sqlite(?:-|$)/.test(file)),false);
  }
  const resume=await f.request('POST',f.sessionPath+'/messages',{input:{text:'Resume',recovery:{runId:before.view.run!.runId,confirmAdditionalCost:true}},key:'resume-after-'+action,capability:'fixture'});assert.notEqual(resume.status,202);assert.equal(f.calls,1);
 }finally{await f.close()}
});

test('completed text, usage and event cursors survive SIGKILL without a connected event consumer',{timeout:45000},async()=>{
 const f=await fixture();try{
  f.mode('ok');assert.equal((await f.message()).status,202);const before=await f.settled();assert.equal(before.view.run?.status,'completed');
  assert.equal(before.view.messages.at(-1)?.text,'A persisted final answer.');assert.equal(before.view.usage.charged,48);
  await f.restart();const after=await f.snapshot();assert.deepEqual(after.view,before.view);assert.deepEqual(after.events,before.events);assert.equal(f.calls,1);
  const response=await f.request('GET',f.sessionPath+'/events?after=0');assert.equal(response.status,200);const events=await response.json() as {items:{id:number;type:string}[];cursor:number};
  assert.deepEqual(events.items.map(event=>event.id),Array.from({length:events.items.length},(_,index)=>index+1));assert.equal(events.cursor,after.view.cursor);assert(events.items.some(event=>event.type==='message_completed'));assert(events.items.some(event=>event.type==='session_completed'));
  assert.equal((await f.message()).status,202);assert.equal(f.calls,1);
 }finally{await f.close()}
});

test('SIGKILL between Durable completion and the public terminal commit restores the completed answer once',{timeout:45000},async()=>{
 const f=await fixture();try{
  f.mode('ok');await f.process.command('hold-final',f.id);
  const finalReady=f.process.next(message=>message.event==='final-ready');
  assert.equal((await f.message()).status,202);await finalReady;
  const before=await f.snapshot();assert.equal(before.view.status,'running');assert.notEqual(before.view.run?.status,'completed');assert.equal(before.view.messages.at(-1)?.text,'A persisted final answer.');assert.equal(before.view.usage.charged,48);assert.equal(f.calls,1);
  await f.restart();const after=await f.snapshot();
  assert.equal(after.view.status,'idle');assert.equal(after.view.run?.status,'completed');assert.equal(after.view.run?.resumable,false);assert.equal(after.view.messages.at(-1)?.status,'completed');assert.equal(after.view.messages.at(-1)?.text,'A persisted final answer.');assert.deepEqual(after.view.usage,before.view.usage);assert.equal(f.calls,1);
  assert.equal(after.view.run?.stepType,'completed');assert.deepEqual(after.view.messages.at(-1)?.usage,after.view.usage);
  assert.equal(after.events.filter(event=>event.type==='message_completed').length,1);assert.equal(after.events.filter(event=>event.type==='session_completed').length,1);
  assert.deepEqual(after.events.map(event=>event.id),Array.from({length:after.events.length},(_,index)=>index+1));assert.equal(after.view.cursor,after.events.at(-1)?.id);
  await f.restart();const repeated=await f.snapshot();assert.deepEqual(repeated.view,after.view);assert.deepEqual(repeated.events,after.events);assert.equal(f.calls,1);
 }finally{await f.close()}
});

test('SIGKILL before an incomplete answer terminal commit never promotes truncated output to completed',{timeout:45000},async()=>{
 const f=await fixture();try{
  f.mode('length');await f.process.command('hold-final',f.id);
  const finalReady=f.process.next(message=>message.event==='final-ready');
  assert.equal((await f.message()).status,202);await finalReady;
  const before=await f.snapshot();assert.equal(before.view.status,'running');assert.equal(before.view.messages.at(-1)?.text,'A persisted final answer.');assert.equal(f.calls,1);
  await f.restart();const after=await f.snapshot();
  assert.equal(after.view.status,'idle');assert(['interrupted','failed'].includes(after.view.run!.status));assert(['interrupted','failed'].includes(after.view.messages.at(-1)!.status));assert.equal(after.view.messages.at(-1)?.text,before.view.messages.at(-1)?.text);assert.deepEqual(after.view.usage,before.view.usage);assert.equal(f.calls,1);
  assert.equal(after.events.some(event=>event.type==='message_completed'),false);
 }finally{await f.close()}
});

test('SIGKILL after a story commit recovers its authoritative receipt without applying the change twice',{timeout:45000},async()=>{
 const f=await fixture({creative:true});try{
  f.mode('story');const written=f.written();assert.equal((await f.message()).status,202);await written;
  const before=await f.snapshot();assert.equal(f.storyWrites,1);assert(before.checkpoint?.storyWrites?.record_story_changes);assert.equal(before.checkpoint.storyWrites.record_story_changes.result,undefined);
  const messageId=before.view.run!.messageId;assert.equal(before.view.messages.find(message=>message.id===messageId)?.storyRecording?.status,'saving');
  await f.restart();const interrupted=await f.snapshot();assert.equal(interrupted.view.run?.status,'interrupted');assert.equal(f.calls,1);assert.equal(f.storyWrites,1);
  const response=await f.request('POST',f.sessionPath+'/messages',{input:{text:'Resume original story change',recovery:{runId:interrupted.view.run!.runId,confirmAdditionalCost:true}},key:'recover-story',capability:'fixture'});
  assert.equal(response.status,202,await response.text());const finished=await f.settled();assert.equal(finished.view.run?.status,'completed');assert.equal(finished.view.run?.messageId,messageId);assert.equal(f.storyWrites,1);
  assert.equal(finished.view.messages.find(message=>message.id===messageId)?.storyRecording?.status,'applied');assert.equal(finished.view.messages.find(message=>message.id===messageId)?.storyRecording?.changeId,'committed-change');
 }finally{await f.close()}
});


test('cancelling an unacknowledged story write preserves its unknown outcome',{timeout:45000},async()=>{
 const f=await fixture({creative:true});try{
  f.mode('story');const written=f.written();assert.equal((await f.message()).status,202);await written;
  const before=await f.snapshot(),messageId=before.view.run!.messageId;
  assert.equal(before.view.messages.find(message=>message.id===messageId)?.storyRecording?.status,'saving');
  assert.equal((await f.request('POST',f.sessionPath+'/cancel',{})).status,200);
  const after=await f.snapshot();assert.equal(after.view.run?.status,'cancelled');
  assert.equal(after.view.messages.find(message=>message.id===messageId)?.storyRecording?.status,'unknown');
  assert.equal(after.view.messages.find(message=>message.id===messageId)?.storyRecording?.code,'OUTCOME_UNKNOWN');
  assert.equal(f.storyWrites,1);assert.equal(f.calls,1);
 }finally{await f.close()}
});
