import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,existsSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {Store,type Saved} from "../src/sessions/store.js";
import {archiveBatch,archiveThreshold} from "../src/sessions/event-archive.js";
import {server} from "../src/server/http.js";
import {PiHost} from "../src/runtime/pi-host.js";
import {durableContext} from "../src/runtime/durable.js";
import type {ThinkingEvent} from "@writer-agent/contracts";

function syntheticSaved(id:string,count:number):Saved {
 const events:ThinkingEvent[]=Array.from({length:count},(_,i)=>({id:i+1,type:"usage",usage:{input:i,output:0,charged:i,incomplete:false}}));
 return {schema:1,accountingVersion:2,owner:"synthetic-author",entries:[],events,requests:{},view:{sessionId:id,bookId:"synthetic-book",title:"Synthetic",createdAt:"now",model:{provider:"fixture",model:"synthetic",endpoint:"https://example.invalid",protocol:"thinking-v1",limits:{maxTurnsPerRequest:2,maxToolCalls:2,maxInputTokens:1000,maxOutputTokens:100,maxSessionTokens:2000,maxConcurrentSessions:1,maxDurationMs:10000,maxToolResultBytes:1000}},scopes:[],status:"idle",messages:[],cursor:count,usage:{input:0,output:0,charged:0,incomplete:false}}};
}

test("SQLite event history preserves cursor order across reopen and bounds recent snapshots",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-events-")),id=`th-${randomUUID()}`;
 let store=new Store(dir);
 try {
  const original=syntheticSaved(id,archiveThreshold+250),expected=structuredClone(original.events);
  await store.write(original);
  assert(existsSync(join(dir,`${id}.sqlite`)));assert(!existsSync(join(dir,`${id}.json`)));
  assert.equal(store.read(id,false)?.events.length,archiveThreshold);
  assert.deepEqual(store.read(id)?.events,expected);
  const recent=store.read(id,false)!;
  recent.events.push({id:++recent.view.cursor,type:"session_completed"});
  await store.write(recent);
  expected.push(recent.events.at(-1)!);
  assert.deepEqual(store.readEvents(id,archiveBatch-10)?.events,expected.filter(event=>event.id>archiveBatch-10));
  await store.close();store=new Store(dir);await store.ready;
  assert.deepEqual(store.read(id)?.events,expected);
  const detached=store.read(id)!;detached.events=[];assert.deepEqual(store.read(id)?.events,expected);
  store.markDeleted(id);
  const deleted=store.read(id)!;deleted.deleted=true;deleted.events=[];deleted.view.messages=[];deleted.view.status="deleted";
  await store.write(deleted);await store.purge(id);
  assert.equal(store.read(id)?.events.length,0);assert(store.isDeleted(id));
  assert.equal(readdirSync(dir).some(file=>file.endsWith(".sqlite")),false);
  await store.close();store=new Store(dir);await store.ready;
  assert(store.isDeleted(id));assert.equal(store.read(id),undefined);
 } finally {await store.close();rmSync(dir,{recursive:true,force:true})}
});

test("legacy JSON import retains archives, request receipts and unknown reservations once",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-import-")),id=`th-${randomUUID()}`;
 const legacy=syntheticSaved(id,archiveThreshold+1),events=structuredClone(legacy.events);
 legacy.archive={archivedThrough:archiveBatch,segments:[{firstId:1,lastId:archiveBatch}]};legacy.events=events.slice(archiveBatch);
 legacy.requests={stable:{fingerprint:"fingerprint",messageId:"author-message"}};
 legacy.view.usage={input:12,output:4,charged:1500,incomplete:true};
 legacy.entries=[{type:"session",id:"old-sdk"}];
 writeFileSync(join(dir,`${id}.json`),JSON.stringify(legacy),{mode:0o600});
 writeFileSync(join(dir,`${id}.1-${archiveBatch}.events.json`),JSON.stringify({schema:1,sessionId:id,firstId:1,lastId:archiveBatch,events:events.slice(0,archiveBatch)}),{mode:0o600});
 let store=new Store(dir);
 try {
  await store.ready;
  const saved=store.read(id)!;assert.deepEqual(saved.events,events);assert.deepEqual(saved.requests,legacy.requests);assert.deepEqual(saved.view.usage,legacy.view.usage);assert.deepEqual(saved.entries,[]);
  assert.equal(readdirSync(dir).some(file=>file.endsWith(".json")),false);
  await store.close();store=new Store(dir);await store.ready;
  assert.deepEqual(store.read(id)?.events,events);assert.deepEqual(store.read(id)?.requests,legacy.requests);
 } finally {await store.close();rmSync(dir,{recursive:true,force:true})}
});

test("legacy import rejects a missing archived segment without replacing its source",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-import-invalid-")),id=`th-${randomUUID()}`;
 const legacy=syntheticSaved(id,1);legacy.events=[];legacy.archive={archivedThrough:1,segments:[{firstId:1,lastId:1}]};
 const path=join(dir,`${id}.json`);writeFileSync(path,JSON.stringify(legacy),{mode:0o600});
 const store=new Store(dir);
 try {await assert.rejects(store.ready,/SESSION_ARCHIVE_MISSING/);assert(existsSync(path));}
 finally {await store.close().catch(()=>{});rmSync(dir,{recursive:true,force:true})}
});

test("request state and durable work share an atomic commit",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-admission-")),id=`th-${randomUUID()}`,store=new Store(dir);
 try {
  const saved=syntheticSaved(id,0);await store.write(saved);
  const runtime=await store.runtime(id);
  const conversation=await runtime.harness.createConversation({ownership:{kind:"ownerless"}},durableContext);
  saved.requests={key:{fingerprint:"input",messageId:"author"}};
  await assert.rejects(store.write(saved,async tx=>{await runtime.createRun(tx,conversation.id,"run");throw Error("admission failed")}),/admission failed/);
  assert.deepEqual(store.read(id)?.requests,{});assert.equal((await runtime.harness.inspect(durableContext)).tasks.length,0);
  let calls=0;runtime.setRun(async()=>{calls++});
  const task=await store.write(saved,tx=>runtime.createRun(tx,conversation.id,"run"));
  assert.deepEqual(store.read(id)?.requests,saved.requests);assert.equal(calls,0);
  await runtime.harness.waitForTask(task!,durableContext);assert.equal(calls,1);
 } finally {await store.close();rmSync(dir,{recursive:true,force:true})}
});

test("startup interrupts accepted durable work and retains unknown model reservations",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-interrupted-")),id=`th-${randomUUID()}`;
 let store=new Store(dir);
 try {
  const saved=syntheticSaved(id,0),runId=randomUUID();
  saved.epoch=1;saved.executionLease={owner:"previous-process",epoch:1,expiresAt:Date.now()+10000};
  saved.view.status="running";saved.view.usage={input:0,output:0,charged:1200,incomplete:true};
  saved.view.run={runId,traceId:randomUUID(),messageId:"author",status:"running",stepType:"provider",checkpointId:randomUUID(),epoch:1,attempt:1,retryCount:0,modelCalls:1,resumable:true,provider:"fixture",model:"synthetic",startedAt:"now",updatedAt:"now",durationMs:0};
  saved.view.messages=[{id:"author-answer",role:"assistant",text:"partial",status:"running",sources:[],createdAt:"now"}];
  saved.execution={calls:1,turns:1,memoryCalls:0,spent:1500,modelRequests:[{id:"request",reservedTokens:1200,bound:1500,status:"reserved"}]};
  saved.requests={key:{fingerprint:"input",messageId:"author"}};
  const runtime=await store.runtime(id),conversation=await runtime.harness.createConversation({ownership:{kind:"ownerless"}},durableContext);
  saved.durable={conversationId:conversation.id};
  await store.write(saved,async tx=>{saved.durable!.taskId=await runtime.createRun(tx,conversation.id,runId)});
  await store.close();store=new Store(dir);await store.ready;
  const recovered=store.read(id)!;
  assert.equal(recovered.view.status,"idle");assert.equal(recovered.view.run?.status,"interrupted");assert.equal(recovered.view.messages[0]?.status,"interrupted");
  assert.deepEqual(recovered.view.usage,saved.view.usage);assert.deepEqual(recovered.execution,saved.execution);assert.deepEqual(recovered.requests,saved.requests);assert.equal(recovered.executionLease,undefined);
  assert.equal((await (await store.harness(id)).inspect(durableContext)).tasks.length,0);
 } finally {await store.close();rmSync(dir,{recursive:true,force:true})}
});

test("public history paginates immutable message IDs while private full snapshot retains every turn",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-history-")),id=`th-${randomUUID()}`,store=new Store(dir);
 const messages=Array.from({length:123},(_,i)=>({id:`message-${i}`,role:i%2?"assistant" as const:"user" as const,text:"Synthetic",status:"completed" as const,sources:[],createdAt:"now"}));
 const saved=syntheticSaved(id,1);saved.view.messages=messages;await store.write(saved);
 const host={config:{token:"test-token",models:[]},store,get:()=>store.read(id)!,getRecent:()=>store.read(id,false)!} as unknown as PiHost;
 const http=server(host);
 try {
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
  const call=async(path:string)=>{const r=await fetch(origin+path,{headers:{Authorization:"Bearer test-token"}});assert.equal(r.status,200);return r.json()};
  const recent=await call(`/internal/v1/sessions/${id}`);assert.equal(recent.messages.length,40);assert.equal(recent.history.totalMessages,123);assert.equal(recent.history.oldestMessageId,"message-83");
  const older=await call(`/internal/v1/sessions/${id}/history?before=message-83`);assert.equal(older.items.length,80);assert.equal(older.nextBefore,"message-3");
  const oldest=await call(`/internal/v1/sessions/${id}/history?before=message-3`);assert.equal(oldest.items.length,3);assert.equal(oldest.hasMore,false);
  const full=await call(`/internal/v1/sessions/${id}?full=1`);assert.equal(full.messages.length,123);
 } finally {http.closeAllConnections();http.close();await store.close();rmSync(dir,{recursive:true,force:true})}
});

test("execution authority rejects expired, replaced and deleted leases deterministically",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-fence-")),id=`th-${randomUUID()}`,store=new Store(dir);
 try {
  const s=syntheticSaved(id,1),runId=randomUUID();
  const fence={runId,owner:"fixture-owner",epoch:2};
  s.epoch=2;s.executionLease={owner:fence.owner,epoch:2,expiresAt:100};
  s.view.run={runId,traceId:randomUUID(),messageId:"m",status:"running",stepType:"provider",checkpointId:randomUUID(),epoch:2,attempt:1,retryCount:0,modelCalls:1,resumable:true,provider:"fixture",model:"synthetic",startedAt:"now",updatedAt:"now",durationMs:0};
  await store.write(s);
  assert.equal(store.executionStatus(id,fence,99),"current");
  assert.equal(store.executionStatus(id,fence,100),"expired");
  for(const stale of [{...fence,owner:"other"},{...fence,epoch:1},{...fence,runId:randomUUID()}])assert.equal(store.executionStatus(id,stale,99),"stale");
  s.epoch=3;await store.write(s);assert.equal(store.executionStatus(id,fence,99),"stale");
  store.markDeleted(id);assert.equal(store.executionStatus(id,fence,99),"deleted");
 } finally {await store.close();rmSync(dir,{recursive:true,force:true})}
});

test("a queued run commit cannot replace a persisted cancellation epoch",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-cancel-fence-")),id=`th-${randomUUID()}`,store=new Store(dir);
 try {
  const saved=syntheticSaved(id,0),runId=randomUUID(),fence={runId,owner:"executor",epoch:1};
  saved.epoch=1;saved.executionLease={owner:fence.owner,epoch:1,expiresAt:Date.now()+10000};
  saved.view.run={runId,traceId:randomUUID(),messageId:"m",status:"running",stepType:"provider",checkpointId:randomUUID(),epoch:1,attempt:1,retryCount:0,modelCalls:1,resumable:true,provider:"fixture",model:"synthetic",startedAt:"now",updatedAt:"now",durationMs:0};
  await store.write(saved);
  const cancelled=store.read(id)!;cancelled.epoch=2;delete cancelled.executionLease;
  const cancellation=store.write(cancelled);
  saved.view.title="late mutation";
  const late=store.write(saved,undefined,fence);
  await cancellation;await assert.rejects(late,/SESSION_INTERRUPTED/);
  assert.equal(store.read(id)?.epoch,2);assert.equal(store.read(id)?.view.title,"Synthetic");
 } finally {await store.close();rmSync(dir,{recursive:true,force:true})}
});
