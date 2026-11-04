import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {Saved} from '../sessions/store.js';
import type {ThinkingEvent} from '@writer-agent/contracts';
import type {EvaluationTask,Observation} from './task-schema.js';

type Reply={id?:number;event?:string;phase?:string;result?:unknown;error?:string};
function child(directory:string,id:string,signal:AbortSignal){
 const process=fork(fileURLToPath(new URL('../../test/fixtures/layered-storage-child.ts',import.meta.url)),[directory,id],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','ignore','ignore','ipc']});
 const queued:Reply[]=[],pending:{match:(reply:Reply)=>boolean;resolve:(reply:Reply)=>void;reject:(error:Error)=>void}[]=[];
 let sequence=0,exited=false;
 const exit=new Promise<void>(resolve=>process.once('exit',()=>{exited=true;for(const waiter of pending.splice(0))waiter.reject(Error('EVAL_STORAGE_PROCESS_EXIT'));resolve()}));
 const cancel=()=>process.kill('SIGKILL');
 signal.addEventListener('abort',cancel,{once:true});
 process.on('error',()=>{for(const waiter of pending.splice(0))waiter.reject(Error('EVAL_STORAGE_PROCESS_ERROR'))});
 process.on('message',(reply:Reply)=>{const index=pending.findIndex(waiter=>waiter.match(reply));if(index<0)queued.push(reply);else pending.splice(index,1)[0]!.resolve(reply)});
 const next=(match:(reply:Reply)=>boolean)=>{
  signal.throwIfAborted();if(exited)return Promise.reject(Error('EVAL_STORAGE_PROCESS_EXIT'));
  const index=queued.findIndex(match);if(index>=0)return Promise.resolve(queued.splice(index,1)[0]!);
  return new Promise<Reply>((resolve,reject)=>pending.push({match,resolve,reject}));
 };
 return {process,ready:()=>next(reply=>reply.event==='ready'),phase:()=>next(reply=>reply.event==='phase'),async command<T=unknown>(op:string,extra:Record<string,unknown>={}){
  const id=++sequence,response=next(reply=>reply.id===id);process.send({id,op,...extra});const reply=await response;if(reply.error)throw Error(reply.error);return reply.result as T;
 },async stop(){signal.removeEventListener('abort',cancel);if(!exited)process.kill('SIGKILL');await exit}};
}
function state(id:string,text:string):Saved{
 const runId=randomUUID();
 return {schema:1,accountingVersion:2,owner:'eval-author',entries:[],epoch:4,requests:{accepted:{fingerprint:'same-input',messageId:'input'}},events:[{id:1,type:'session_started'}],
 view:{sessionId:id,bookId:'eval-book',title:'Storage evaluation',createdAt:'2026-11-04T00:00:00Z',model:{provider:'fixture',model:'storage-fixture',endpoint:'http://127.0.0.1:9',protocol:'thinking-v1',limits:{maxTurnsPerRequest:1,maxToolCalls:1,maxInputTokens:1000,maxOutputTokens:100,maxSessionTokens:2000,maxConcurrentSessions:1,maxDurationMs:1000,maxToolResultBytes:1000}},scopes:[],status:'idle',messages:[{id:'input',role:'user',text,status:'completed',sources:[],createdAt:'2026-11-04T00:00:00Z'}],cursor:1,usage:{input:12,output:4,charged:900,incomplete:true},run:{runId,traceId:randomUUID(),messageId:'input',status:'cancelled',stepType:'provider',checkpointId:randomUUID(),epoch:4,attempt:1,retryCount:0,modelCalls:1,resumable:false,provider:'fixture',model:'storage-fixture',startedAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z',durationMs:20}}};
}
async function rejected(operation:()=>Promise<unknown>,pattern:RegExp){try{await operation();return false}catch(error){return error instanceof Error&&pattern.test(error.message)}}
export async function executeStorageEvaluation(task:EvaluationTask,signal:AbortSignal,result:Observation){
 const directory=mkdtempSync(join(tmpdir(),'agent-eval-storage-')),id='th-'+randomUUID();
 let runtime:ReturnType<typeof child>|undefined;
 try{
  runtime=child(directory,id,signal);await runtime.ready();
  const original=state(id,task.request),updated=structuredClone(original);
  updated.events.push({id:2,type:'session_completed'});updated.view.cursor=2;
  await runtime.command('write',{value:original});
  if(task.environment.scenario==='storage-sqlite'){
   await runtime.command('fail-sqlite');
   result.metrics.sqliteWriteRejected=await rejected(()=>runtime!.command('write',{value:updated}),/EVAL_SQLITE_WRITE_FAILED/);
   result.metrics.snapshotBlocked=await rejected(()=>runtime!.command('snapshot'),/PROJECTION/);
   result.metrics.eventsBlocked=await rejected(()=>runtime!.command('events'),/PROJECTION/);
   const health=await runtime.command<{unpublishedSessions:number}>('health');result.metrics.unpublishedSessions=health.unpublishedSessions;
   await runtime.command('repair-sqlite');result.trace.push({action:'sqlite_trigger_rejected_projection'});
  }else{
   await runtime.command('arm',{phase:'state_committed'});
   const reached=runtime.phase(),writing=runtime.command('write',{value:updated}).catch(()=>undefined);
   const boundary=await reached;result.metrics.committedBoundaryObserved=boundary.phase==='state_committed';
   await runtime.stop();await writing;
   result.trace.push({action:'sigkill_after_state_commit'});
  }
  await runtime.stop();result.metrics.actualSigkill=runtime.process.signalCode==='SIGKILL';
  const recovered:Saved[]=[],eventPages:ThinkingEvent[][]=[];
  for(let restart=0;restart<2;restart++){
   signal.throwIfAborted();runtime=child(directory,id,signal);await runtime.ready();
   recovered.push(await runtime.command<Saved>('snapshot'));eventPages.push(await runtime.command<ThinkingEvent[]>('events'));
   const health=await runtime.command<{unpublishedSessions:number}>('health');result.metrics.unpublishedAfterRecovery=health.unpublishedSessions;
   await runtime.stop();result.trace.push({action:'storage_reopened_and_published'});
  }
  result.metrics={...result.metrics,restarts:recovered.length,cursorPreserved:recovered.every(s=>s.view.cursor===2),eventsExact:eventPages.every(events=>JSON.stringify(events)===JSON.stringify(updated.events)),unknownReservationRetained:recovered.every(s=>JSON.stringify(s.view.usage)===JSON.stringify(original.view.usage)),cancelledRunPreserved:recovered.every(s=>s.view.run?.status==='cancelled'&&s.view.run.resumable===false&&s.epoch===4),acceptedInputPreserved:recovered.every(s=>s.view.messages[0]?.text===task.request&&JSON.stringify(s.requests)===JSON.stringify(original.requests))};
  return result;
 }finally{await runtime?.stop();rmSync(directory,{recursive:true,force:true})}
}
