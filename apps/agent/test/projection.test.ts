import test from "node:test";
import assert from "node:assert/strict";
import {projectSnapshot,projectHistory,fullMessageLimit,type MessageProjection,type SessionHeader} from "../src/sessions/projection.js";
import type {ThinkingMessage} from "@writer-agent/contracts";

const header:SessionHeader={sessionId:"session",bookId:"book",title:"Discussion",createdAt:"now",model:{provider:"fixture",model:"fixture",endpoint:"https://example.invalid",protocol:"thinking-v1",limits:{maxTurnsPerRequest:1,maxToolCalls:1,maxInputTokens:100,maxOutputTokens:100,maxSessionTokens:1000,maxConcurrentSessions:1,maxDurationMs:1000,maxToolResultBytes:1000}},scopes:[],status:"idle",cursor:100000,usage:{input:0,output:0,charged:0,incomplete:false}};
const message=(id:number):ThinkingMessage=>({id:String(id),role:"user",text:"Synthetic",status:"completed",sources:[],createdAt:"now"});

test("session projection requests only the recent message window and exposes the durable cursor",()=>{
 const calls:string[]=[];
 const projection:MessageProjection={
  messageCount:()=>10000,
  recentMessages:limit=>{calls.push(`recent:${limit}`);return Array.from({length:limit!},(_,index)=>message(10000-limit!+index))},
  fullMessages:()=>{throw Error("full history must not be read")},
  messagePage:()=>{throw Error("history page must not be read")},
 };
 const snapshot=projectSnapshot(header,projection);
 assert.deepEqual(calls,["recent:40"]);
 assert.equal(snapshot.messages.length,40);assert.equal(snapshot.cursor,100000);
 assert.deepEqual(snapshot.history,{hasMore:true,oldestMessageId:"9960",totalMessages:10000});
 snapshot.usage.charged=100;
 assert.equal(header.usage.charged,0);
});

test("message history forwards the stable before cursor with a bounded page",()=>{
 let observed:unknown;
 const projection:MessageProjection={
  messageCount:()=>{throw Error("count must come from page")},
  recentMessages:()=>{throw Error("recent must not be read")},
  fullMessages:()=>{throw Error("full must not be read")},
  messagePage:(before,limit)=>{observed={before,limit};return {items:[message(1)],hasMore:false,totalMessages:2}},
 };
 assert.deepEqual(projectHistory(projection,"2"),{items:[message(1)],hasMore:false,totalMessages:2});
 assert.deepEqual(observed,{before:"2",limit:80});
 assert.throws(()=>projectHistory(projection,undefined,81),/INVALID_HISTORY_LIMIT/);
});

test("full history projection applies an explicit maximum",()=>{
 const projection:MessageProjection={messageCount:()=>1001,recentMessages:()=>[],messagePage:()=>({items:[],hasMore:false,totalMessages:0}),fullMessages:limit=>{assert.equal(limit,1000);throw Error("SESSION_HISTORY_LIMIT")}};
 assert.throws(()=>projectSnapshot(header,projection,fullMessageLimit),/SESSION_HISTORY_LIMIT/);
 assert.throws(()=>projectSnapshot(header,projection,fullMessageLimit+1),/INVALID_HISTORY_LIMIT/);
});
