import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import type {JsonValue} from "@earendil-works/chord";
import {Store,type Saved} from "../src/sessions/store.js";
import {openDurable,ThinkingState,durableContext} from "../src/runtime/durable.js";

test("migrating a monolithic Durable document retires its historical event base immediately",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-migration-base-")),id=`th-${randomUUID()}`,path=join(dir,id+".sqlite");
 const legacy:Saved={schema:1,accountingVersion:2,owner:"synthetic",entries:[],events:Array.from({length:5000},(_,index)=>({id:index+1,type:"text_delta",messageId:"answer",text:"x".repeat(1024)})),requests:{},view:{sessionId:id,bookId:"b",title:"Synthetic",createdAt:"now",model:{provider:"fixture",model:"synthetic",endpoint:"https://example.invalid",protocol:"thinking-v1",limits:{maxTurnsPerRequest:2,maxToolCalls:2,maxInputTokens:1000,maxOutputTokens:100,maxSessionTokens:2000,maxConcurrentSessions:1,maxDurationMs:10000,maxToolResultBytes:1000}},scopes:[],status:"idle",messages:[],cursor:5000,usage:{input:0,output:0,charged:1000,incomplete:true}}};
 let store:Store|undefined;
 try {
  const runtime=await openDurable(path);
  await runtime.harness.commit(async tx=>{const state=await tx.doc(ThinkingState);state.saved=legacy as unknown as JsonValue;delete state.layout;delete state.outbox;delete state.publishedCursor;},durableContext);
  await runtime.harness.close(durableContext);
  store=new Store(dir);await store.ready;
  assert.equal(store.cursor(id),5000);assert.equal(store.readEvents(id,4900,100)?.events.length,100);
  const db=new DatabaseSync(path,{readOnly:true});
  try {
   const revisions=db.prepare("SELECT r.kind,length(r.content) AS bytes FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE d.kind=?").all(JSON.stringify("writer.thinking"));
   assert.equal(revisions.length,1);assert.equal(revisions[0]!.kind,"base");assert(Number(revisions[0]!.bytes)<8192);
  }finally{db.close();}
  await store.close();store=new Store(dir);await store.ready;
  assert.equal(store.cursor(id),5000);assert.equal(store.state(id)?.view.usage.charged,1000);assert.equal(store.state(id)?.view.usage.incomplete,true);
 }finally{await store?.close();rmSync(dir,{recursive:true,force:true});}
});
