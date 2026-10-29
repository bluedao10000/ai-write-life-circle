import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PiHost, AgentError } from "../src/runtime/pi-host.js";
import { Store } from "../src/sessions/store.js";
import { failureFor } from "../src/runtime/reliability.js";
import type { Config } from "../src/config.js";

const rows: {name:string;completed:boolean;recovered:boolean|null;accepted:number;lost:number;duplicateTools:number;unexpectedCalls:number;recoveryMs:number|null;consistent:boolean}[] = [];
const listen = async (s: ReturnType<typeof createServer>) => {
  await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));
  return `http://127.0.0.1:${(s.address() as {port:number}).port}`;
};
async function fixture({scopes=[] as string[],duration=3000}={}) {
  const state=mkdtempSync(join(tmpdir(),"pi-reliability-")),id="th-"+randomUUID();
  let mode="ok",calls=0,toolCalls=0,revoked=false,authorizationVersion=0;
  let notify: (()=>void)|undefined;
  const payloads: unknown[]=[];
  const provider=createServer(async(req,res)=>{
    let body="";for await(const chunk of req) body+=chunk;
    const payload=JSON.parse(body);payloads.push(payload);calls++;notify?.();notify=undefined;
    if(mode==="429" || mode==="500") {res.writeHead(Number(mode));res.end('{}');return}
    if(mode==="overflow") {res.writeHead(400);res.end(JSON.stringify({error:{code:"context_length_exceeded",message:"maximum context length exceeded"}}));return}
    res.writeHead(200,{"content-type":"text/event-stream"});
    if(mode==="hang") {res.flushHeaders();return}
    const delta=mode==="tool" || mode==="toolhang" || mode==="sideeffect" ? {tool_calls:[{index:0,id:"tool-"+calls,type:"function",function:{name:mode==="sideeffect"?"request_turn_organize":"search_knowledge",arguments:mode==="sideeffect"?"{}":'{"query":"synthetic"}'}}]} : {content:"Synthetic creative suggestion. Not confirmed canon."};
    res.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:mode==="incomplete"?"length":delta.tool_calls?"tool_calls":"stop"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  const model={provider:"fixture",model:"synthetic",endpoint:await listen(provider),protocol:"thinking-v1" as const,limits:{maxTurnsPerRequest:3,maxToolCalls:3,maxInputTokens:32000,maxOutputTokens:512,maxSessionTokens:500000,maxConcurrentSessions:1,maxDurationMs:duration,maxToolResultBytes:24000}};
  const story=createServer((req,res)=>{
    res.setHeader("content-type","application/json");
    if(revoked) {res.writeHead(403);res.end('{}');return}
    if(req.url?.endsWith("/authorize")) res.end(JSON.stringify({sessionId:id,authorId:"a",bookId:"b",authorizationVersion,model,scopes}));
    else {toolCalls++;if(mode==="toolhang"){res.flushHeaders();return}if(mode==="sideeffect"){mode="500";res.end('{"items":[],"sources":[]}')}else{res.writeHead(500);res.end('{}')}}
  });
  const config:Config={state,port:1,version:"test",key:"synthetic-only",token:"synthetic-only",model,storyOrigin:await listen(story)};
  let host=new PiHost(config,new Store(state));
  await host.create({sessionId:id,authorId:"a",bookId:"b",createdAt:new Date().toISOString(),model,scopes:scopes as never,capability:"fixture"});
  return {
    id,state,model,payloads,get host(){return host},get calls(){return calls},get toolCalls(){return toolCalls},
    mode(value:string){mode=value},revoke(){revoked=true},reauthorize(){revoked=false;authorizationVersion++},
    entered(){return new Promise<void>(r=>{notify=r})},
    async send(key="one",text="Synthetic question") {const result=await host.accept(id,{text},key,"fixture");await host.active.get(id)?.done;return result},
    async resume(key="resume",context?:string) {const run=host.get(id).view.run!;const result=await host.accept(id,{text:"Resume accepted message",recovery:{runId:run.runId,confirmAdditionalCost:true,...(context?{continuationContext:context}:{})}},key,"fixture");await host.active.get(id)?.done;return result},
    restart(){host.store.close();host=new PiHost(config,new Store(state))},
    async close(){await host.close();provider.closeAllConnections();story.closeAllConnections();provider.close();story.close();rmSync(state,{recursive:true,force:true})},
  };
}

for(const [mode,code] of [["429","RATE_LIMITED"],["500","PROVIDER_UNAVAILABLE"],["incomplete","PROVIDER_UNAVAILABLE"],["overflow","CONTEXT_OVERFLOW"]]) {
  test(`provider ${mode}: classified failure, no automatic paid retry, explicit idempotent recovery`,async()=>{
    const f=await fixture();try {
      f.mode(mode);const original=await f.send();const failed=f.host.get(f.id).view;
      assert.equal(failed.run?.status,"failed");assert.equal(failed.run?.failure?.code,code);assert.equal(failed.run?.failure?.autoRecoverable,false);assert.equal(f.calls,1);
      const recovery={text:"Resume accepted message",recovery:{runId:failed.run!.runId,confirmAdditionalCost:true as const,...(code==="CONTEXT_OVERFLOW"?{continuationContext:"Author confirms: uncertain motivations; keep source:synthetic at revision:v1 as a reference, not canon."}:{})}};
      f.mode("ok");const start=performance.now();
      await f.host.accept(f.id,recovery,"recovery","fixture");await f.host.active.get(f.id)?.done;
      const restored=f.host.get(f.id).view;
      assert.equal(restored.run?.status,"completed");assert.equal(restored.messages.filter(m=>m.role==="user").length,1);
      assert.equal(restored.messages[0].id,original.messageId);assert.equal(restored.messages[1].status,"failed");
      assert.equal(restored.run?.attempt,2);assert.equal(f.calls,2);
      await f.host.accept(f.id,recovery,"recovery","fixture");assert.equal(f.calls,2);
      rows.push({name:mode,completed:restored.run?.status==="completed",recovered:restored.run?.status==="completed",accepted:1,lost:Number(!restored.messages.some(m=>m.id===original.messageId && m.role==="user")),duplicateTools:f.toolCalls,unexpectedCalls:f.calls-2,recoveryMs:performance.now()-start,consistent:restored.run!.status===restored.messages.at(-1)!.status});
    }finally{await f.close()}
  });
}

test("known usage settles the reservation so repeated small turns do not exhaust a cumulative ceiling",async()=>{
  const f=await fixture();try {
    f.model.limits.maxSessionTokens=18000;
    // Config is deliberately changed in the same isolated fixture grant before acceptance.
    for(let i=0;i<15;i++){await f.send("turn-"+i);assert.equal(f.host.get(f.id).view.messages.at(-1)?.status,"completed")}
    assert.equal(f.calls,15);assert.equal(f.host.get(f.id).view.usage.charged,1800);
    rows.push({name:"multi-turn-budget",completed:f.host.get(f.id).view.run?.status==="completed",recovered:null,accepted:15,lost:Math.max(0,15-f.host.get(f.id).view.messages.filter(m=>m.role==="user").length),duplicateTools:f.toolCalls,unexpectedCalls:f.calls-15,recoveryMs:null,consistent:f.host.get(f.id).view.run?.status===f.host.get(f.id).view.messages.at(-1)?.status});
  }finally{await f.close()}
});

test("an admission guard fences stale lock takeover; repeated close cannot unlink the next owner",()=>{
 const state=mkdtempSync(join(tmpdir(),"pi-lock-admission-"));
 try{
  writeFileSync(join(state,".process-lock"),"99999999");
  writeFileSync(join(state,".process-lock-admission"),"synthetic-other-starter");
  assert.throws(()=>new Store(state),/AGENT_LOCK_ADMISSION_REQUIRED/);
  rmSync(join(state,".process-lock-admission"));
  const first=new Store(state);first.close();const second=new Store(state);first.close();
  assert.throws(()=>new Store(state),/AGENT_ALREADY_RUNNING/);second.close();
 }finally{rmSync(state,{recursive:true,force:true})}
});

test("legacy known reservations migrate lazily while unknown costs are never released",async()=>{
 const f=await fixture();try{
  const saved=f.host.get(f.id);delete saved.accountingVersion;
  saved.view.usage={input:100,output:20,charged:17000,incomplete:false};f.host.store.write(saved);
  assert.equal(f.host.get(f.id).view.usage.charged,120);
  saved.view.usage.incomplete=true;f.host.store.write(saved);
  assert.equal(f.host.get(f.id).view.usage.charged,17000);
 }finally{await f.close()}
});

test("restart preserves a completed answer persisted before legacy session finalization",async()=>{
 const f=await fixture();try{
  await f.send();const saved=f.host.get(f.id),runId=saved.view.run!.runId,calls=f.calls;
  saved.view.status="running";saved.view.run!.resumable=true;
  saved.events=saved.events.filter(e=>e.type!=="session_completed");
  f.host.store.write(saved);f.restart();
  const restored=f.host.get(f.id).view;
  assert.equal(restored.status,"idle");assert.equal(restored.run?.runId,runId);
  assert.equal(restored.run?.status,"completed");assert.equal(restored.run?.resumable,false);
  assert.equal(restored.run?.failure,undefined);assert.equal(restored.messages.at(-1)?.status,"completed");
  await assert.rejects(f.resume("must-not-pay-twice"),e=>e instanceof AgentError && e.code==="RESUME_NOT_SAFE");
  assert.equal(f.calls,calls);
 }finally{await f.close()}
});

test("safe accepted checkpoint survives restart without automatic model invocation",async()=>{
  const f=await fixture();try {
    // Simulate the durable state left by SIGKILL, without manufacturing SDK internals.
    const saved=f.host.get(f.id),mid=randomUUID();
    saved.view.status="running";saved.view.messages=[{id:mid,role:"user",text:"Synthetic persisted input",status:"completed",sources:[],createdAt:"now"},{id:mid+"-answer",role:"assistant",text:"",status:"accepted",sources:[],createdAt:"now"}];
    saved.checkpoint={input:{text:"Synthetic persisted input"},entries:[],messageId:mid};
    saved.view.run={runId:randomUUID(),traceId:randomUUID(),messageId:mid,status:"accepted",stepType:"accepted",checkpointId:randomUUID(),epoch:1,attempt:1,retryCount:0,modelCalls:0,resumable:true,provider:"fixture",model:"synthetic",startedAt:"now",updatedAt:"now",durationMs:0};
    f.host.store.write(saved);f.restart();
    assert.equal(f.calls,0);assert.equal(f.host.get(f.id).view.run?.status,"interrupted");
    await f.resume();assert.equal(f.calls,1);assert.equal(f.host.get(f.id).view.messages[0].text,"Synthetic persisted input");
    assert.equal(f.host.get(f.id).view.run?.status,"completed");
    rows.push({name:"restart-checkpoint",completed:f.host.get(f.id).view.run?.status==="completed",recovered:f.host.get(f.id).view.run?.status==="completed",accepted:1,lost:Number(!f.host.get(f.id).view.messages.some(m=>m.id===mid && m.role==="user")),duplicateTools:f.toolCalls,unexpectedCalls:f.calls-1,recoveryMs:null,consistent:f.host.get(f.id).view.run?.status===f.host.get(f.id).view.messages.at(-1)?.status});
  }finally{await f.close()}
});

test("timeout is retained as unknown cost and never retried automatically",async()=>{
  const f=await fixture({duration:1000});try {
    f.mode("hang");await f.send();const s=f.host.get(f.id);
    assert.equal(f.calls,1);assert.equal(s.view.run?.failure?.code,"PROVIDER_TIMEOUT");assert.equal(s.view.run?.failure?.mayHaveIncurredCost,true);assert.equal(s.view.usage.incomplete,true);assert(s.view.usage.charged>120);
    rows.push({name:"timeout",completed:s.view.run?.status==="completed",recovered:null,accepted:1,lost:Number(!s.view.messages.some(m=>m.role==="user")),duplicateTools:f.toolCalls,unexpectedCalls:f.calls-1,recoveryMs:null,consistent:s.view.messages.at(-1)?.status==="failed"});
  }finally{await f.close()}
});

test("a tool body stalled after headers reaches a tool timeout without another model request",async()=>{
 const f=await fixture({scopes:["knowledge"],duration:1000});try{
  f.mode("toolhang");await f.send();const run=f.host.get(f.id).view.run!;
  assert.equal(f.toolCalls,1);assert.equal(f.calls,1);assert.equal(run.status,"failed");assert.equal(run.failure?.code,"TOOL_TIMEOUT");
 }finally{await f.close()}
});

test("tool failure stops paid continuation; side effect checkpoints cannot be replayed",async()=>{
  for(const mode of ["tool","sideeffect"]){
    const f=await fixture({scopes:["knowledge","creative"]});try {
      f.mode(mode);await f.send();const run=f.host.get(f.id).view.run!;
      assert.equal(f.toolCalls,1);assert.equal(run.status,"failed");
      if(mode==="tool"){assert.equal(run.failure?.code,"TOOL_EXECUTION_FAILED");assert.equal(f.calls,1)}
      else {assert.equal(run.resumable,false);await assert.rejects(f.resume(),(e)=>e instanceof AgentError && e.code==="RESUME_NOT_SAFE");assert.equal(f.calls,2)}
      rows.push({name:mode,completed:f.host.get(f.id).view.run?.status==="completed",recovered:null,accepted:1,lost:Number(!f.host.get(f.id).view.messages.some(m=>m.role==="user")),duplicateTools:f.toolCalls-1,unexpectedCalls:f.calls-(mode==="tool"?1:2),recoveryMs:null,consistent:run.status===f.host.get(f.id).view.messages.at(-1)?.status});
    }finally{await f.close()}
  }
});

test("cancelled, deleted and authorization-revoked runs cannot resume",async()=>{
  for(const action of ["cancel","delete","revoke"]){const f=await fixture();try{
    f.mode("500");await f.send();const run=f.host.get(f.id).view.run!;
    if(action==="cancel")await f.host.cancel(f.id);else if(action==="delete")await f.host.delete(f.id);else f.revoke();
    await assert.rejects(f.host.accept(f.id,{text:"Resume accepted message",recovery:{runId:run.runId,confirmAdditionalCost:true}},"resume","fixture"));
    assert.equal(f.calls,1);
  }finally{await f.close()}}
});

test("revoking then regranting identical scopes cannot revive an interrupted old grant",async()=>{
 const f=await fixture();try{
  f.mode("500");await f.send();f.revoke();f.reauthorize();
  await assert.rejects(f.resume(),e=>e instanceof AgentError && e.code==="AUTHORIZATION_REQUIRED");assert.equal(f.calls,1);
 }finally{await f.close()}
});

test("Resume versus Cancel terminates an admitted recovery without resurrecting it",async()=>{
  // The deterministic delayed-authorize race is shared with the admission test.
  const f=await fixture();try{
    f.mode("500");await f.send();
    const entered=f.entered();f.mode("hang");
    const run=f.host.get(f.id).view.run!;
    const input={text:"Resume accepted message",recovery:{runId:run.runId,confirmAdditionalCost:true as const}};
    await f.host.accept(f.id,input,"resume","fixture");await entered;
    await f.host.cancel(f.id);
    assert.equal(f.host.get(f.id).view.run?.status,"cancelled");assert.equal(f.calls,2);
    await f.host.accept(f.id,input,"resume","fixture");assert.equal(f.calls,2);
    await assert.rejects(f.resume("again"));
  }finally{await f.close()}
});

test("simultaneous duplicate admission returns one durable receipt and one model call",async()=>{
 const f=await fixture();try{
  const [a,b]=await Promise.all([f.host.accept(f.id,{text:"duplicate synthetic"},"same","fixture"),f.host.accept(f.id,{text:"duplicate synthetic"},"same","fixture")]);
  await f.host.active.get(f.id)?.done;assert.deepEqual(a,b);assert.equal(f.calls,1);assert.equal(f.host.get(f.id).view.messages.filter(m=>m.role==="user").length,1);
 }finally{await f.close()}
});

test("delete fences late results and removes every private checkpoint",async()=>{
 const f=await fixture();try{
  f.mode("hang");const entered=f.entered();await f.host.accept(f.id,{text:"Synthetic accepted input"},"one","fixture");await entered;
  await f.host.delete(f.id);const saved=f.host.store.read(f.id)!;
  assert(saved.deleted);assert.deepEqual(saved.view.messages,[]);assert.equal(saved.checkpoint,undefined);assert.equal(saved.runs,undefined);assert.equal(saved.executionLease,undefined);assert.equal(f.calls,1);
  await assert.rejects(f.host.accept(f.id,{text:"late"},"late","fixture"));assert.equal(f.calls,1);
 }finally{await f.close()}
});

test("run logs contain metadata and never chat, credentials or tool arguments",async()=>{
 const f=await fixture(),logs:string[]=[],original=console.log;
 try{
  console.log=(line:unknown)=>{logs.push(String(line))};await f.send("private-key","private-synthetic-chat");
  const events=logs.map(line=>JSON.parse(line));
  assert(events.some(e=>e.run_status==="accepted"));assert(events.some(e=>e.step_type==="provider"));assert(events.some(e=>e.run_status==="completed"));
  for(const event of events)for(const name of ["session_id","run_id","trace_id","provider","model","run_status","step_type","duration","token_usage","retry_count","checkpoint_id","error_code"])assert(Object.hasOwn(event,name));
  assert(!logs.join("").includes("private-synthetic-chat"));assert(!logs.join("").includes("private-key"));assert(!logs.join("").includes("synthetic-only"));
 }finally{console.log=original;await f.close()}
});

test("all public failure categories carry a bounded recovery policy and safe message",()=>{
  const codes=["PROVIDER_TIMEOUT","PROVIDER_UNAVAILABLE","RATE_LIMITED","CONTEXT_OVERFLOW","TOOL_TIMEOUT","TOOL_EXECUTION_FAILED","SESSION_INTERRUPTED","SESSION_EXPIRED","AUTHORIZATION_REQUIRED","MODEL_CONFIGURATION_ERROR","BUDGET_EXCEEDED","INTERNAL_ERROR"];
  for(const code of codes){const failure=failureFor(code,true);assert.equal(failure.code,code);assert.equal(failure.autoRecoverable,false);assert(failure.message);assert.equal(failure.contextRetained,true)}
});

after(()=>{
  if(!process.env.RELIABILITY_EVAL_REPORT)return;
  const recovered=rows.filter(r=>r.recovered!==null),times=rows.flatMap(r=>r.recoveryMs===null?[]:[r.recoveryMs]);
  const report={syntheticOnly:true,realLLMCalled:false,scope:"isolated Pi SDK fault scenarios; no production or semantic quality claim",cases:rows,metrics:{taskCompletionRate:rows.filter(r=>r.completed).length/rows.length,sessionRecoverySuccessRate:recovered.filter(r=>r.recovered).length/recovered.length,messageLossRate:rows.reduce((n,r)=>n+r.lost,0)/rows.reduce((n,r)=>n+r.accepted,0),duplicateToolExecutions:rows.reduce((n,r)=>n+r.duplicateTools,0),unexpectedDuplicateModelCalls:rows.reduce((n,r)=>n+r.unexpectedCalls,0),recoveryDurationMs:times,errorStateConsistencyRate:rows.filter(r=>r.consistent).length/rows.length}};
  mkdirSync(dirname(process.env.RELIABILITY_EVAL_REPORT),{recursive:true});writeFileSync(process.env.RELIABILITY_EVAL_REPORT,JSON.stringify(report,null,2)+"\n");
});
