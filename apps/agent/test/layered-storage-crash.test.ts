import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {PiHost} from '../src/runtime/pi-host.js';
import type {Config} from '../src/config.js';
import {Store,type Saved} from '../src/sessions/store.js';
import {EventStore} from '../src/sessions/event-store.js';
import {durableContext,openDurable,ThinkingState} from '../src/runtime/durable.js';
import type {JsonValue} from '@earendil-works/chord';
import type {ThinkingEvent} from '@writer-agent/contracts';

type Reply={id?:number;event?:string;phase?:string;result?:unknown;error?:string};
function start(directory:string,id:string,phase?:string){
 const child=fork(fileURLToPath(new URL('./fixtures/layered-storage-child.ts',import.meta.url)),[directory,id,...(phase?[phase]:[])],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});
 let output='',sequence=0;
 child.stdout!.on('data',chunk=>{output=(output+chunk).slice(-6000)});child.stderr!.on('data',chunk=>{output=(output+chunk).slice(-6000)});
 const pending:{matches:(reply:Reply)=>boolean;resolve:(reply:Reply)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}[]=[],queued:Reply[]=[];
 child.on('message',(reply:Reply)=>{const index=pending.findIndex(wait=>wait.matches(reply));if(index<0){queued.push(reply);return}const wait=pending.splice(index,1)[0]!;clearTimeout(wait.timer);wait.resolve(reply)});
 child.on('exit',(code,signal)=>{for(const wait of pending.splice(0)){clearTimeout(wait.timer);wait.reject(Error(`Child exited ${code??signal}: ${output}`))}});
 const next=(matches:(reply:Reply)=>boolean)=>{
  const index=queued.findIndex(matches);if(index>=0)return Promise.resolve(queued.splice(index,1)[0]!);
  return new Promise<Reply>((resolve,reject)=>{const timer=setTimeout(()=>{const index=pending.findIndex(wait=>wait.timer===timer);if(index>=0)pending.splice(index,1);reject(Error(`Child timed out: ${output}`))},15000);pending.push({matches,resolve,reject,timer})});
 };
 return {child,next,ready:()=>next(reply=>reply.event==='ready'),phase:()=>next(reply=>reply.event==='phase'),async command<T=unknown>(op:string,extra:Record<string,unknown>={}){const id=++sequence,response=next(reply=>reply.id===id);child.send({id,op,...extra});const reply=await response;if(reply.error)throw Error(reply.error);return reply.result as T}};
}
async function kill(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited}
function saved(id:string,count=2):Saved{
 const runId=randomUUID();
 return {schema:1,accountingVersion:2,owner:'author',entries:[],requests:{stable:{fingerprint:'same-input',messageId:'author-message'}},epoch:4,
 events:Array.from({length:count},(_,i)=>({id:i+1,type:'usage',usage:{input:12,output:4,charged:900,incomplete:true}})),
 view:{sessionId:id,bookId:'book',title:'Storage test',createdAt:'now',model:{provider:'fixture',model:'synthetic',endpoint:'https://example.invalid',protocol:'thinking-v1',limits:{maxTurnsPerRequest:2,maxToolCalls:2,maxInputTokens:1000,maxOutputTokens:100,maxSessionTokens:2000,maxConcurrentSessions:1,maxDurationMs:10000,maxToolResultBytes:1000}},scopes:[],status:'idle',messages:[{id:'author-message',role:'user',text:'Question',status:'completed',sources:[],createdAt:'now'},{id:'author-message-answer',role:'assistant',text:'Partial answer',status:'cancelled',sources:[],createdAt:'now'}],cursor:count,usage:{input:12,output:4,charged:900,incomplete:true},run:{runId,traceId:randomUUID(),messageId:'author-message',status:'cancelled',stepType:'provider',checkpointId:randomUUID(),epoch:4,attempt:1,retryCount:0,modelCalls:1,resumable:false,provider:'fixture',model:'synthetic',startedAt:'now',updatedAt:'now',durationMs:20}}};
}

for(const phase of ['state_committed','events_appended'] as const)test(`SIGKILL after ${phase} replays one outbox without changing cancelled runs or unknown costs`,{timeout:45000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'thinking-outbox-kill-')),id='th-'+randomUUID();let process=start(directory,id);
 try{
  await process.ready();const original=saved(id,1);await process.command('write',{value:original});
  await process.command('arm',{phase});const next=structuredClone(original);next.events.push({id:2,type:'session_completed',messageId:'author-message-answer'});next.view.cursor=2;
  const boundary=process.phase(),writing=process.command('write',{value:next}).catch(()=>undefined);await boundary;
  await kill(process.child);await writing;
  for(let restart=0;restart<3;restart++){
   process=start(directory,id);await process.ready();const actual=await process.command<Saved>('snapshot');
   assert.equal(actual.view.cursor,2);assert.equal(actual.view.run?.status,'cancelled');assert.equal(actual.view.run?.resumable,false);assert.deepEqual(actual.view.usage,next.view.usage);assert.deepEqual(actual.requests,next.requests);
   const events=await process.command<ThinkingEvent[]>('events');assert.deepEqual(events,next.events);await kill(process.child);
  }
 }finally{await kill(process.child);rmSync(directory,{recursive:true,force:true})}
});

test('event write failure rejects publication and restart completes the committed outbox',{timeout:45000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'thinking-projection-failure-')),id='th-'+randomUUID();let process=start(directory,id);
 try{
  await process.ready();const original=saved(id,1);await process.command('write',{value:original});
  await process.command('fail-projection');const next=structuredClone(original);next.events.push({id:2,type:'session_completed'});next.view.cursor=2;
  await assert.rejects(process.command('write',{value:next}),/PROJECTION|SQLITE/);
  await assert.rejects(process.command('snapshot'),/PROJECTION/);
  await assert.rejects(process.command('events'),/PROJECTION/);
  await kill(process.child);process=start(directory,id);await process.ready();
  assert.equal((await process.command<Saved>('snapshot')).view.cursor,2);assert.deepEqual(await process.command('events'),next.events);
 }finally{await kill(process.child);rmSync(directory,{recursive:true,force:true})}
});

for(const format of ['json','durable'] as const)test(`SIGKILL during ${format} migration retains its source and resumes without duplicate events`,{timeout:45000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'thinking-migration-kill-')),id='th-'+randomUUID(),original=saved(id,4100),events=original.events;
 delete original.accountingVersion;
 if(format==='json'){
  original.archive={archivedThrough:4000,segments:[{firstId:1,lastId:2000},{firstId:2001,lastId:4000}]};original.events=events.slice(4000);
  writeFileSync(join(directory,id+'.json'),JSON.stringify(original),{mode:0o600});
  for(const {firstId,lastId} of original.archive.segments)writeFileSync(join(directory,`${id}.${firstId}-${lastId}.events.json`),JSON.stringify({schema:1,sessionId:id,firstId,lastId,events:events.slice(firstId-1,lastId)}),{mode:0o600});
 }else{
  const runtime=await openDurable(join(directory,id+'.sqlite'));
  await runtime.harness.commit(async tx=>{const document=await tx.doc(ThinkingState);document.saved=original as unknown as JsonValue;delete document.layout;delete document.publishedCursor;delete document.outbox},durableContext);await runtime.harness.close(durableContext);
 }
 let process=start(directory,id,'migration_projected');
 try{
  await process.phase();await kill(process.child);
  if(format==='json')assert(existsSync(join(directory,id+'.json')));
  else{const runtime=await openDurable(join(directory,id+'.sqlite'));const old=await runtime.harness.snapshot(ThinkingState,durableContext);assert.equal((old?.saved as unknown as Saved).events.length,4100);await runtime.harness.close(durableContext)}
  process=start(directory,id);await process.ready();const actual=await process.command<Saved>('snapshot');
  assert.equal(actual.view.cursor,4100);assert.equal(actual.view.run?.status,'cancelled');assert.deepEqual(actual.view.usage,original.view.usage);assert.equal(actual.accountingVersion,2);
  const restored:ThinkingEvent[]=[];for(let after=0;after<4100;){const page=await process.command<ThinkingEvent[]>('events',{after});assert(page.length>0);restored.push(...page);after=page.at(-1)!.id}assert.deepEqual(restored,events);
  assert(!existsSync(join(directory,id+'.json')));
  await kill(process.child);process=start(directory,id);await process.ready();assert.equal((await process.command<Saved>('snapshot')).view.cursor,4100);
 }finally{await kill(process.child);rmSync(directory,{recursive:true,force:true})}
});


test('100,000 events leave Session State bounded and snapshots never load event history',{timeout:45000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'thinking-layered-scale-')),id='th-'+randomUUID();let store=new Store(directory);
 const originalRead=EventStore.prototype.read,originalRecent=EventStore.prototype.recent;
 try{
  const value=saved(id,0);let smallStateBytes=0;
  for(let start=0;start<100000;start+=1000){
   value.events=Array.from({length:1000},(_,offset)=>({id:start+offset+1,type:'usage',usage:{input:12,output:4,charged:900,incomplete:true}}));value.view.cursor=start+1000;
   await store.write(value);
   if(start===0)smallStateBytes=Buffer.byteLength(JSON.stringify(await (await store.harness(id)).snapshot(ThinkingState,durableContext)));
  }
  const document=await (await store.harness(id)).snapshot(ThinkingState,durableContext);
  assert.deepEqual((document!.saved as unknown as Saved).events,[]);assert.deepEqual(document!.outbox,[]);
  assert(Buffer.byteLength(JSON.stringify(document))-smallStateBytes<64);
  for(let after=0;after<100000;after+=997){const page=store.readEvents(id,after,997)!.events;assert.equal(page[0]!.id,after+1);assert.equal(page.at(-1)!.id,Math.min(after+997,100000))}
  EventStore.prototype.read=()=>{throw Error('Full event history must not be queried')};EventStore.prototype.recent=()=>{throw Error('Recent event history must not be queried')};
  assert.equal(store.snapshot(id)?.cursor,100000);assert.equal(store.snapshot(id)?.messages.length,2);assert.equal(store.history(id)?.totalMessages,2);
  EventStore.prototype.read=originalRead;EventStore.prototype.recent=originalRecent;
  await store.close();store=new Store(directory);await store.ready;
  assert.equal(store.snapshot(id)?.cursor,100000);assert.equal(store.readEvents(id,99900,100)?.events.length,100);
 }finally{EventStore.prototype.read=originalRead;EventStore.prototype.recent=originalRecent;await store.close();rmSync(directory,{recursive:true,force:true})}
});


test('deleting a session with a failed projection removes both databases without a restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'thinking-failed-delete-')),id='th-'+randomUUID(),store=new Store(directory);
 const project=EventStore.prototype.project;
 try{
  await store.write(saved(id,1));
  EventStore.prototype.project=()=>{throw Error('SQLITE_WRITE_FAILED')};
  const next=saved(id,2);await assert.rejects(store.write(next),/SQLITE_WRITE_FAILED/);
  const host=new PiHost({state:directory} as Config,store);
  await host.delete(id);
  assert(store.isDeleted(id));assert.equal(store.read(id)?.deleted,true);
  assert(!existsSync(join(directory,id+'.sqlite')));assert(!existsSync(join(directory,id+'.events.sqlite')));
 }finally{EventStore.prototype.project=project;await store.close();rmSync(directory,{recursive:true,force:true})}
});
