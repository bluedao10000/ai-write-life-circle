import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {EventStore,eventByteLimit,eventPageLimit} from "../src/sessions/event-store.js";
import type {ThinkingEvent,ThinkingMessage} from "@writer-agent/contracts";

const event=(id:number):ThinkingEvent=>({id,type:"text_delta",messageId:"answer",text:`chunk ${id}`});
const message=(id:string,text=id):ThinkingMessage=>({id,role:"assistant",status:"completed",text,sources:[],createdAt:"now"});

test("100,000 events append in segments and support bounded indexed reads across repeated reopen",()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-event-scale-")),path=join(dir,"events.sqlite");
 let store=new EventStore(path,"synthetic");
 try {
  for(let start=0;start<100000;start+=1000)store.append(Array.from({length:1000},(_,index)=>event(start+index+1)));
  assert.equal(store.count(),100000);assert.equal(store.cursor(),100000);
  const segments=store.segments();assert.equal(segments.length,50);assert(segments.every(segment=>segment.event_count===2000&&segment.bytes<=eventByteLimit));
  assert.deepEqual(store.recent(100).map(item=>item.id),Array.from({length:100},(_,index)=>99901+index));
  let after=0,total=0;
  while(after<100000){const page=store.read(after,137);assert.equal(page[0]!.id,after+1);assert(page.length<=137);after=page.at(-1)!.id;total+=page.length;}
  assert.equal(total,100000);assert.deepEqual(store.read(40000,100,40050).map(item=>item.id),Array.from({length:50},(_,index)=>40001+index));
  for(let index=1;index<=3;index++){
   store.close();store=new EventStore(path,"synthetic");assert.equal(store.cursor(),99999+index);
   store.append([event(100000+index)]);assert.equal(store.cursor(),100000+index);
  }
  assert.throws(()=>store.read(0,eventPageLimit+1),/INVALID_READ_LIMIT/);
  const db=new DatabaseSync(path,{readOnly:true});
  try {
   const plan=db.prepare("EXPLAIN QUERY PLAN SELECT payload FROM thinking_events WHERE cursor>? AND cursor<=? ORDER BY cursor LIMIT ?").all(90000,100000,100);
   assert(plan.some(row=>String(row.detail).includes("INTEGER PRIMARY KEY")),JSON.stringify(plan));
  }finally{db.close();}
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("projection replay is idempotent and cursor conflicts or gaps roll back the whole batch",()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-event-replay-")),store=new EventStore(join(dir,"events.sqlite"),"synthetic");
 try {
  store.project([event(1),event(2)],[message("first")]);
  store.project([{text:"chunk 1",messageId:"answer",type:"text_delta",id:1},event(2)],[message("first")]);
  assert.equal(store.count(),2);assert.equal(store.messageCount(),1);
  store.verifyReplay([event(1),event(2)]);
  assert.throws(()=>store.verifyReplay([{...event(1),text:"changed replay"}]),/EVENT_CURSOR_CONFLICT/);
  assert.throws(()=>store.verifyReplay([event(3)]),/EVENT_CURSOR_CONFLICT/);
  assert.equal(store.cursor(),2);
  assert.throws(()=>store.project([event(3),{...event(2),text:"different"}],[message("changed")]),/EVENT_CURSOR_CONFLICT/);
  assert.equal(store.cursor(),2);assert.equal(store.messagePage().items[0]!.id,"first");
  assert.throws(()=>store.append([event(4)]),/EVENT_CURSOR_GAP/);
  assert.equal(store.cursor(),2);
  store.project([event(3)],[message("first","updated"),message("second")]);
  assert.equal(store.messagePage().items[0]!.text,"updated");assert.equal(store.cursor(),3);
  assert.throws(()=>store.project([event(4)],[message("second"),message("first")]),/UNIQUE/);
  assert.equal(store.cursor(),3);assert.deepEqual(store.fullMessages().map(item=>item.id),["first","second"]);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("message projection reads only requested pages and does not rewrite unchanged messages",()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-message-pages-")),path=join(dir,"events.sqlite"),store=new EventStore(path,"synthetic");
 const messages=Array.from({length:200},(_,index)=>message(`message-${index}`));
 try {
  store.project([event(1)],messages);
  const db=new DatabaseSync(path);
  try {
   db.exec("CREATE TABLE changes(count INTEGER); INSERT INTO changes VALUES(0); CREATE TRIGGER message_writes AFTER UPDATE ON thinking_messages BEGIN UPDATE changes SET count=count+1; END;");
   store.project([event(2)],messages);assert.equal(db.prepare("SELECT count FROM changes").get()!.count,0);
   messages[199]={...messages[199]!,text:"new final answer"};store.project([event(3)],messages);
   assert.equal(db.prepare("SELECT count FROM changes").get()!.count,1);
  }finally{db.close();}
  assert.equal(store.recentMessages().length,40);assert.equal(store.recentMessages()[0]!.id,"message-160");
  const page=store.messagePage("message-160");assert.equal(page.items.length,80);assert.equal(page.nextBefore,"message-80");assert.equal(page.totalMessages,200);
  assert.equal(store.messagePage("message-80").hasMore,false);assert.equal(store.fullMessages().length,200);
  assert.throws(()=>store.messagePage("missing"),/INVALID_HISTORY_CURSOR/);
  assert.throws(()=>store.fullMessages(100),/SESSION_HISTORY_LIMIT/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("segments rotate at their byte bound and oversized events leave cursor unchanged",()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-event-bytes-")),store=new EventStore(join(dir,"events.sqlite"),"synthetic");
 try {
  const text="x".repeat(17*1024*1024);
  store.append([{...event(1),text},{...event(2),text}]);
  assert.equal(store.segments().length,2);assert(store.segments().every(segment=>segment.bytes<=eventByteLimit));
  assert.throws(()=>store.append([{...event(3),text:"x".repeat(eventByteLimit)}]),/EVENT_STORAGE_LIMIT/);
  assert.equal(store.cursor(),2);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
