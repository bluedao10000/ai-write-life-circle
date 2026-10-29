import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {Store,type Saved} from "../src/sessions/store.js";
import {archiveBatch,archiveThreshold} from "../src/sessions/event-archive.js";
import {server} from "../src/server/http.js";
import {PiHost} from "../src/runtime/pi-host.js";
import type {ThinkingEvent} from "@writer-agent/contracts";

function syntheticSaved(id:string,count:number):Saved {
 const events:ThinkingEvent[]=Array.from({length:count},(_,i)=>({id:i+1,type:"usage",usage:{input:i,output:0,charged:i,incomplete:false}}));
 return {schema:1,accountingVersion:2,owner:"synthetic-author",entries:[],events,requests:{},view:{sessionId:id,bookId:"synthetic-book",title:"Synthetic",createdAt:"now",model:{provider:"fixture",model:"synthetic",endpoint:"https://example.invalid",protocol:"thinking-v1",limits:{maxTurnsPerRequest:2,maxToolCalls:2,maxInputTokens:1000,maxOutputTokens:100,maxSessionTokens:2000,maxConcurrentSessions:1,maxDurationMs:10000,maxToolResultBytes:1000}},scopes:[],status:"idle",messages:[],cursor:count,usage:{input:0,output:0,charged:0,incomplete:false}}};
}

test("terminal event archives preserve cursor order, bound polling reads and delete durably",()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-archive-")),id=`th-${randomUUID()}`,store=new Store(dir);
 try {
  const original=syntheticSaved(id,archiveThreshold+250),expected=structuredClone(original.events);
  store.write(original);
  const raw=JSON.parse(readFileSync(join(dir,`${id}.json`),"utf8"));
  assert.equal(raw.archive.archivedThrough,archiveBatch);assert.equal(raw.events.length,archiveThreshold+250-archiveBatch);
  assert.equal(store.read(id,false)?.events.length,raw.events.length);
  const restored=store.read(id)!;assert.deepEqual(restored.events,expected);
  const after=archiveBatch-10;
  const recent=store.readEvents(id,after)!;assert.equal(recent.events[0]?.id,after+1);assert.equal(recent.events.at(-1)?.id,expected.at(-1)?.id);assert.deepEqual(recent.events,expected.filter(e=>e.id>after));
  // An unreferenced segment is never treated as authoritative. A repeated
  // terminal commit deterministically replaces it and publishes one manifest.
  store.write(restored);assert.deepEqual(store.read(id)?.events,expected);
  const second=store.read(id)!;second.events.push(...Array.from({length:archiveThreshold+50},(_,i)=>({id:expected.length+i+1,type:"usage" as const,usage:{input:i,output:0,charged:i,incomplete:false}})));second.view.cursor=second.events.at(-1)!.id;
  store.write(second);const all=store.read(id)!;assert.equal(all.events.length,expected.length+archiveThreshold+50);assert.equal(all.archive?.segments.length,2);
  const tail=store.readEvents(id,expected.length-1)!;assert.equal(tail.events[0]?.id,expected.length);assert.equal(tail.events.at(-1)?.id,all.events.at(-1)?.id);
 const across=store.readEvents(id,archiveBatch-1)!;assert.equal(across.events.length,all.events.length-archiveBatch+1);assert.equal(across.events[0]?.id,archiveBatch);assert.equal(across.events.at(-1)?.id,all.events.at(-1)?.id);
 const broken=join(dir,`${id}.json`),snapshot=readFileSync(broken,"utf8");
 rmSync(join(dir,`${id}.1-${archiveBatch}.events.json`));assert.throws(()=>store.readEvents(id,0),/SESSION_ARCHIVE_MISSING/);
 store.markDeleted(id);const deleted=store.read(id,false)!;deleted.deleted=true;deleted.view.status="deleted";deleted.events=[];deleted.view.messages=[];delete deleted.archive;store.write(deleted);
  // Exercise the same startup purge path used after a tombstone arrives.
  writeFileSync(join(dir,`${id}.json`),JSON.stringify({...deleted,deleted:false,view:{...deleted.view,status:"idle"}}),{mode:0o600});store.recover();
  assert.equal(store.read(id)?.deleted,true);assert.equal(readdirSync(dir).some(file=>file.endsWith(".events.json")),false);
 writeFileSync(broken,snapshot,{mode:0o600});assert.throws(()=>store.readEvents(id,0),/SESSION_ARCHIVE_MISSING/);
 } finally {store.close();rmSync(dir,{recursive:true,force:true})}
});

test("archive corruption fails closed and deletion removes every event segment",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-archive-invalid-")),id=`th-${randomUUID()}`,store=new Store(dir);
 try {
  const saved=syntheticSaved(id,archiveThreshold+1);store.write(saved);
  const segment=join(dir,`${id}.1-${archiveBatch}.events.json`),valid=readFileSync(segment,"utf8");
  const corrupted=JSON.parse(valid);corrupted.events[0].id=2;writeFileSync(segment,JSON.stringify(corrupted),{mode:0o600});
  assert.throws(()=>store.read(id),/Archive|ARCHIVE|id/);
  writeFileSync(segment,valid,{mode:0o600});
  const host={store,active:new Map()} as unknown as PiHost;
  await PiHost.prototype.delete.call(host,id);
  assert.equal(readdirSync(dir).some(file=>file.endsWith(".events.json")),false);
  assert(store.isDeleted(id));assert.equal(store.read(id)?.view.messages.length,0);
 } finally {store.close();rmSync(dir,{recursive:true,force:true})}
});

test("public history paginates immutable message IDs while private full snapshot retains every turn",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-history-")),id=`th-${randomUUID()}`,store=new Store(dir);
 const messages=Array.from({length:123},(_,i)=>({id:`message-${i}`,role:i%2?"assistant" as const:"user" as const,text:"Synthetic",status:"completed" as const,sources:[],createdAt:"now"}));
 const saved=syntheticSaved(id,1);saved.view.messages=messages;store.write(saved);
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
 } finally {http.closeAllConnections();http.close();store.close();rmSync(dir,{recursive:true,force:true})}
});

test("execution authority rejects expired, replaced and deleted leases deterministically",()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-fence-")),id=`th-${randomUUID()}`,store=new Store(dir);
 try {
  const s=syntheticSaved(id,1),runId=randomUUID();
  const fence={runId,owner:"fixture-owner",epoch:2};
  s.epoch=2;s.executionLease={owner:fence.owner,epoch:2,expiresAt:100};
  s.view.run={runId,traceId:randomUUID(),messageId:"m",status:"running",stepType:"provider",checkpointId:randomUUID(),epoch:2,attempt:1,retryCount:0,modelCalls:1,resumable:true,provider:"fixture",model:"synthetic",startedAt:"now",updatedAt:"now",durationMs:0};
  store.write(s);
  assert.equal(store.executionStatus(id,fence,99),"current");
  assert.equal(store.executionStatus(id,fence,100),"expired");
  for(const stale of [{...fence,owner:"other"},{...fence,epoch:1},{...fence,runId:randomUUID()}])assert.equal(store.executionStatus(id,stale,99),"stale");
  s.epoch=3;store.write(s);assert.equal(store.executionStatus(id,fence,99),"stale");
  store.markDeleted(id);assert.equal(store.executionStatus(id,fence,99),"deleted");
 } finally {store.close();rmSync(dir,{recursive:true,force:true})}
});
