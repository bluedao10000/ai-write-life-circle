import {executionContext} from '../src/runtime/governance/runtime.js';
const fixtureGovernance={context:executionContext({executionId:'fixture',traceId:'fixture',role:'thinking',authorizationVersion:0,scopes:['creative','chapters'],deadline:Date.now()+60000,signal:new AbortController().signal}),authority:{authorize:async()=>{}}};
import test from "node:test";
import {BACKGROUND_CONTEXT, withAbortSignal} from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {tools,type StoryExecution} from "../src/tools/registry.js";
import {PiHost} from "../src/runtime/pi-host.js";
import {Store} from "../src/sessions/store.js";
import {readStoryContext,storyContextText} from "../src/tools/story-context.js";
import {failureFor} from "../src/runtime/reliability.js";
import type {Config} from "../src/config.js";

const config={storyOrigin:"http://127.0.0.1:8791",model:{limits:{maxToolResultBytes:24000}}} as Config;
const args={changes:[{intent:"decide",kind:"character",patch:{name:"林舟"},evidence:[{messageId:"author-current",quote:"主角叫林舟"}]}]};
const execution=():StoryExecution=>({messageId:"author-current",runId:"run-current",dialogueRecording:true,writes:{},persist:()=>{}});
const registered=(ex:StoryExecution,scopes=["creative"])=>tools(config,"session","fixture",new AbortController().signal,()=>{},()=>true,scopes,ex,fixtureGovernance);
const invoke=async(tool:ReturnType<typeof registered>[number],input:unknown=args)=>{
  const result=await tool.execute(input,{} as never,BACKGROUND_CONTEXT);
  return {...result,details:result.details as Record<string,unknown>};
};

test("bounded context preserves the upstream truncation signal",()=>{
  const text=storyContextText({bookId:"b",stateVersion:1,dialogueRecording:true,truncated:true,focus:null,intent:[],confirmed:[],alternatives:[],rejected:[],questions:[],recentChanges:[]},2000);
  assert.match(text,/"truncated":true/);
  assert.match(text,/use read tools for missing details/);
});

test("story mutation tools require creative access and recording opt-in",()=>{
  const names=(e:StoryExecution,scopes?:string[])=>registered(e,scopes).map(t=>t.name);
  assert(names(execution()).includes("record_story_changes"));
  assert(!names(execution()).includes("offer_story_changes"));
  assert(names(execution()).includes("update_discussion_focus"));
  assert(!names({...execution(),dialogueRecording:false}).includes("record_story_changes"));
  assert(names({...execution(),dialogueRecording:false}).includes("get_discussion_source"));
  assert(names({...execution(),dialogueRecording:false}).includes("offer_story_changes"));
  assert(names({...execution(),dialogueRecording:false}).includes("update_discussion_focus"));
  assert(!names(execution(),["chapters"]).includes("record_story_changes"));
});

test("story context read failures are distinct from answer and save failures",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response("unavailable",{status:503});
  try {
    await assert.rejects(readStoryContext(config,"session","query","fixture",new AbortController().signal),/STORY_CONTEXT_UNAVAILABLE/);
    const failure=failureFor("STORY_CONTEXT_UNAVAILABLE",false);
    assert.equal(failure.code,"STORY_CONTEXT_UNAVAILABLE");assert.equal(failure.retryable,true);assert.equal(failure.mayHaveIncurredCost,false);
  }finally{globalThis.fetch=original}
});

test("validation feedback is recoverable and successful logical-turn writes replay their receipt",async()=>{
  const original=globalThis.fetch,ex=execution();let requests=0,persisted=0;
  ex.persist=()=>{persisted++};
  globalThis.fetch=async(_url,init)=>{
    requests++;const body=JSON.parse(init?.body as string);
    assert.equal(body.messageId,"author-current");assert.equal(body.runId,"run-current");assert.equal(body.arguments.messageId,undefined);
    return requests===1?new Response(JSON.stringify({code:"VERSION_CONFLICT",detail:"Use current version 2."}),{status:409}):new Response('{"changeId":"receipt-1","status":"applied","changes":[]}');
  };
  try {
    const tool=registered(ex).find(t=>t.name==="record_story_changes")!;
    const conflict=await invoke(tool);assert.equal(conflict.details.code,"VERSION_CONFLICT");assert.equal(ex.writes.record_story_changes,undefined);
    const success=await invoke(tool);assert.match(JSON.stringify(success),/receipt-1/);
    const replay=await invoke(tool,{changes:[{...args.changes[0],patch:{name:'另一角色'}}]});assert.equal(replay.details.alreadyRecorded,true);assert.equal(requests,2);assert(persisted>=3);
  }finally{globalThis.fetch=original}
});

test("story writes await budget, intent and receipt commits",async()=>{
  const original=globalThis.fetch,ex=execution(),order:string[]=[];
  ex.persist=async()=>{await Promise.resolve();order.push(ex.writes.record_story_changes.result ? "receipt" : "intent")};
  globalThis.fetch=async()=>{
    assert.deepEqual(order,["budget","intent"]);
    order.push("request");
    return new Response('{"changeId":"persisted","status":"applied"}');
  };
  try {
    const tool=tools(config,"session","fixture",new AbortController().signal,()=>{},async()=>{await Promise.resolve();order.push("budget");return true},["creative"],ex,fixtureGovernance).find(t=>t.name==="record_story_changes")!;
    await invoke(tool);
    assert.deepEqual(order,["budget","intent","request","receipt"]);
  }finally{globalThis.fetch=original}
});

test("Durable cancellation during the intent commit prevents a story write",async()=>{
  const original=globalThis.fetch,ex=execution(),cancel=new AbortController();let requests=0;
  ex.persist=async()=>{await Promise.resolve();cancel.abort(Error("cancelled"))};
  globalThis.fetch=async()=>{requests++;return new Response('{"changeId":"unexpected","status":"applied"}')};
  try {
    const tool=registered(ex).find(t=>t.name==="record_story_changes")!;
    await assert.rejects(tool.execute(args,{} as never,withAbortSignal(cancel.signal,BACKGROUND_CONTEXT)),/cancelled/);
    assert.equal(requests,0);
    assert.deepEqual(ex.writes.record_story_changes.arguments,args);
  }finally{globalThis.fetch=original}
});

test("unknown save outcome retains original batch across recovery and forbids a changed batch",async()=>{
  const original=globalThis.fetch,ex=execution();let requests=0;
  globalThis.fetch=async()=>{requests++;throw Error("connection closed after request")};
  try {
    let tool=registered(ex).find(t=>t.name==="record_story_changes")!;
    assert.equal((await invoke(tool)).details.code,"OUTCOME_UNKNOWN");
    assert.deepEqual(ex.writes.record_story_changes.arguments,args);
    assert.equal((await invoke(tool,{changes:[{...args.changes[0],patch:{name:'另一角色'}}]})).details.code,"PENDING_STORY_CHANGE");
    assert.equal((await invoke(tool)).details.code,"OUTCOME_UNKNOWN");assert.equal(requests,1);
    delete ex.writes.record_story_changes.tool;
    const offer=registered({...ex,dialogueRecording:false}).find(t=>t.name==="offer_story_changes")!;
    assert.equal((await invoke(offer)).details.code,"PENDING_STORY_CHANGE");assert.equal(requests,1,"an unknown write cannot silently switch to a different operation");
    // A new run has the durable arguments but can safely retry the original request.
    globalThis.fetch=async(_url,init)=>{requests++;assert.deepEqual(JSON.parse(init?.body as string).arguments,args);return new Response('{"changeId":"receipt-after-recovery","status":"applied"}')};
    tool=registered({...ex,runId:"run-recovery"}).find(t=>t.name==="record_story_changes")!;
    assert.equal((await invoke(tool,{changes:[{...args.changes[0],patch:{name:'另一角色'}}]})).details.code,"PENDING_STORY_CHANGE");
    assert.match(JSON.stringify(await invoke(tool)),/receipt-after-recovery/);assert.equal(requests,2);
  }finally{globalThis.fetch=original}
});

test("offered batches report awaiting author action and preserve one batch across setting changes",async()=>{
  const original=globalThis.fetch,ex=execution();let calls=0;
  const states:unknown[]=[];ex.dialogueRecording=false;ex.onStoryRecording=state=>states.push(state);
  globalThis.fetch=async(_url,init)=>{calls++;assert.equal(JSON.parse(init?.body as string).tool,"offer_story_changes");return new Response('{"changeId":"offered-1","status":"offered","changes":[{}]}')};
  try {
    await invoke(registered(ex).find(t=>t.name==="offer_story_changes")!);
    assert.deepEqual(states,[{status:"saving",changeCount:1},{status:"offered",changeCount:1,changeId:"offered-1"}]);
    await invoke(registered({...ex,dialogueRecording:true}).find(t=>t.name==="record_story_changes")!,{changes:[{...args.changes[0],patch:{name:'另一角色'}}]});
    assert.equal(calls,1);assert.deepEqual(states.at(-1),{status:"offered",changeCount:1,changeId:"offered-1"});
  }finally{globalThis.fetch=original}
});

const listen=async(s:ReturnType<typeof createServer>)=>{await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));return `http://127.0.0.1:${(s.address() as {port:number}).port}`};

test("Pi loads fresh source-labelled story state on each turn and recovery before requesting a model",async()=>{
  const state=mkdtempSync(join(tmpdir(),"pi-story-context-")),id="th-"+randomUUID();let version=0,fail=false;
  const payloads:Record<string,unknown>[]=[];
  const provider=createServer(async(req,res)=>{
    let raw="";for await(const part of req)raw+=part;payloads.push(JSON.parse(raw));
    if(fail){res.writeHead(500);res.end("{}");return}
    res.writeHead(200,{"content-type":"text/event-stream"});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:"继续围绕人物的选择讨论。"},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n');
  });
  const model={provider:"fixture",model:"synthetic",endpoint:await listen(provider),protocol:"thinking-v1" as const,limits:{maxTurnsPerRequest:3,maxToolCalls:4,maxInputTokens:32000,maxOutputTokens:512,maxSessionTokens:500000,maxConcurrentSessions:1,maxDurationMs:5000,maxToolResultBytes:24000}};
  const story=createServer(async(req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.url?.endsWith("/authorize")){res.end(JSON.stringify({sessionId:id,authorId:"a",bookId:"b",model,scopes:["creative"]}));return}
    assert(req.url?.endsWith("/story-context"));let raw="";for await(const part of req)raw+=part;
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),["query","sessionId"]);version++;
    res.end(JSON.stringify({bookId:"b",stateVersion:version,dialogueRecording:version>1,focus:{sessionId:id,goal:"fresh-goal-"+version,assetIds:[],questionIds:[],updatedFromMessageId:"old",version,updatedAt:new Date().toISOString()},intent:[],confirmed:[],alternatives:[],rejected:[],questions:[],recentChanges:[]}));
  });
  const cfg:Config={state,port:1,version:"test",key:"fixture",token:"fixture",storyOrigin:await listen(story),model};
  const host=new PiHost(cfg,new Store(state));
  try {
    await host.create({sessionId:id,authorId:"a",bookId:"b",createdAt:new Date().toISOString(),model,scopes:["creative"],capability:"fixture"});
    const first=await host.accept(id,{text:"主角叫林舟"},"first","fixture");await host.active.get(id)?.done;
    assert.equal(host.get(id).view.run?.status,"completed");assert.equal(version,1);
    assert.match(JSON.stringify(payloads[0]),/fresh-goal-1/);assert.match(JSON.stringify(payloads[0]),new RegExp(first.messageId));
    assert(!JSON.stringify(payloads[0].tools).includes('"name":"record_story_changes"'));
    fail=true;const second=await host.accept(id,{text:"现在确定他是医师"},"second","fixture");await host.active.get(id)?.done;
    assert.equal(host.get(id).view.run?.status,"failed");assert.equal(version,2);
    assert.match(JSON.stringify(payloads[1]),/fresh-goal-2/);assert.doesNotMatch(JSON.stringify(payloads[1]),/fresh-goal-1/);
    assert(JSON.stringify(payloads[1].tools).includes('"name":"record_story_changes"'));
    const run=host.get(id).view.run!;fail=false;
    const resumed=await host.accept(id,{text:"继续",recovery:{runId:run.runId,confirmAdditionalCost:true}},"resume","fixture");await host.active.get(id)?.done;
    assert.equal(host.get(id).view.run?.status,"completed");assert.equal(resumed.messageId,second.messageId);assert.equal(version,3);
    assert.match(JSON.stringify(payloads[2]),/fresh-goal-3/);assert.doesNotMatch(JSON.stringify(payloads[2]),/fresh-goal-2/);
  }finally{await host.close();provider.closeAllConnections();story.closeAllConnections();provider.close();story.close();rmSync(state,{recursive:true,force:true})}
});

test("Pi fits growing story state beside all tools and two recent exchanges",async()=>{
  const state=mkdtempSync(join(tmpdir(),"pi-story-budget-")),id="th-"+randomUUID();let version=0;
  const payloads:Record<string,unknown>[]=[];
  const provider=createServer(async(req,res)=>{
    let raw="";for await(const part of req)raw+=part;payloads.push(JSON.parse(raw));
    res.writeHead(200,{"content-type":"text/event-stream"});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:"我们继续讨论林舟为什么留下，以及这个选择如何影响后面的故事。"},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n');
  });
  const scopes:("chapters"|"knowledge"|"creative")[]=["chapters","knowledge","creative"];
  const model={provider:"fixture",model:"synthetic",endpoint:await listen(provider),protocol:"thinking-v1" as const,limits:{maxTurnsPerRequest:3,maxToolCalls:4,maxInputTokens:32000,maxOutputTokens:4096,maxSessionTokens:500000,maxConcurrentSessions:1,maxDurationMs:5000,maxToolResultBytes:24000}};
  const story=createServer(async(req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.url?.endsWith("/authorize")){res.end(JSON.stringify({sessionId:id,authorId:"a",bookId:"b",model,scopes}));return}
    assert(req.url?.endsWith("/story-context"));version++;
    const confirmed=version<3?[]:Array.from({length:8},(_,index)=>({assetId:"asset-"+index,bookId:"b",kind:"character",name:"林舟的设定"+index,aliases:[],summary:"他选择留在小城，照顾曾帮助过自己的居民。".repeat(35),fields:[],status:"accepted",origin:"conversation",version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
    res.end(JSON.stringify({bookId:"b",stateVersion:version,dialogueRecording:false,focus:null,intent:[],confirmed,alternatives:[],rejected:[],questions:[],recentChanges:[]}));
  });
  const cfg:Config={state,port:1,version:"test",key:"fixture",token:"fixture",storyOrigin:await listen(story),model};
  const host=new PiHost(cfg,new Store(state));
  try {
    await host.create({sessionId:id,authorId:"a",bookId:"b",createdAt:new Date().toISOString(),model,scopes,capability:"fixture"});
    for(const [key,text] of ["主角叫林舟，离开过家乡。","我们讨论三个可能的结局。","写完第一章了，我们聊聊他为什么留下。"].entries()){
      await host.accept(id,{text},String(key),"fixture");await host.active.get(id)?.done;
      assert.equal(host.get(id).view.run?.status,"completed",JSON.stringify(host.get(id).view.run));
    }
    assert.equal(payloads.length,3);
    const messages=JSON.stringify(payloads[2].messages);
    assert.match(messages,/asset-0/);
    assert.doesNotMatch(messages,/asset-7/);
    assert.match(messages,/主角叫林舟/);assert.match(messages,/三个可能的结局/);
    assert(JSON.stringify(payloads[2].tools).includes('"name":"offer_story_changes"'));
  }finally{await host.close();provider.closeAllConnections();story.closeAllConnections();provider.close();story.close();rmSync(state,{recursive:true,force:true})}
});

test("Pi keeps save outcomes on the original author message and recovery respects an undone receipt",async()=>{
  const state=mkdtempSync(join(tmpdir(),"pi-story-receipt-")),id="th-"+randomUUID();
  let mode:"applied"|"offered"|"failed"|"unknown"="applied",interruptAnswer=true,recording=true,toolCalls=0,sawSaving=false;
  let stored:{changeId:string;status:"applied"|"offered"|"undone";changes:unknown[]}|null=null;
  const provider=createServer(async(req,res)=>{
    let raw="";for await(const part of req)raw+=part;const payload=JSON.parse(raw);
    const afterTool=payload.messages.some((m:{role:string})=>m.role==="tool");
    if(afterTool&&interruptAnswer){res.writeHead(500);res.end("{}");return}
    const messageId=JSON.stringify(payload.messages).match(/Current author message: ([a-f0-9-]+)/)?.[1];
    const delta=afterTool?{content:"我们可以继续讨论这个人物。"}:{tool_calls:[{index:0,id:"story-call",type:"function",function:{name:recording?"record_story_changes":"offer_story_changes",arguments:JSON.stringify({changes:[{...args.changes[0],evidence:[{messageId,quote:"主角叫林舟"}]}]})}}]};
    res.writeHead(200,{"content-type":"text/event-stream"});res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:afterTool?"stop":"tool_calls"}],usage:{prompt_tokens:200,completion_tokens:20,total_tokens:220}})+'\n\ndata: [DONE]\n\n');
  });
  const model={provider:"fixture",model:"synthetic",endpoint:await listen(provider),protocol:"thinking-v1" as const,limits:{maxTurnsPerRequest:3,maxToolCalls:4,maxInputTokens:32000,maxOutputTokens:512,maxSessionTokens:500000,maxConcurrentSessions:1,maxDurationMs:5000,maxToolResultBytes:24000}};
  const story=createServer(async(req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.url?.endsWith("/authorize")){res.end(JSON.stringify({sessionId:id,authorId:"a",bookId:"b",model,scopes:["creative"]}));return}
    if(req.url?.endsWith("/story-context")){res.end(JSON.stringify({bookId:"b",stateVersion:0,dialogueRecording:recording,focus:null,intent:[],confirmed:[],alternatives:[],rejected:[],questions:[],recentChanges:[]}));return}
    if(req.url?.endsWith("/story-change-receipt")){res.end(JSON.stringify(stored));return}
    toolCalls++;let raw="";for await(const part of req)raw+=part;const body=JSON.parse(raw);
    sawSaving ||= host.get(id).view.messages.find(m=>m.id===body.messageId)?.storyRecording?.status==="saving";
    if(mode==="unknown"){req.socket.destroy();return}
    if(mode==="failed"){res.writeHead(409);res.end('{"code":"VERSION_CONFLICT","detail":"Read the latest setting."}');return}
    stored={changeId:"receipt-"+toolCalls,status:mode,changes:[{}]};res.end(JSON.stringify(stored));
  });
  const cfg:Config={state,port:1,version:"test",key:"fixture",token:"fixture",storyOrigin:await listen(story),model};
  const host=new PiHost(cfg,new Store(state));
  const send=async(key:string)=>{const receipt=await host.accept(id,{text:"主角叫林舟"},key,"fixture");await host.active.get(id)?.done;return host.get(id).view.messages.find(m=>m.id===receipt.messageId)!};
  try {
    await host.create({sessionId:id,authorId:"a",bookId:"b",createdAt:new Date().toISOString(),model,scopes:["creative"],capability:"fixture"});
    const author=await send("applied");assert(sawSaving);assert.equal(author.storyRecording?.status,"applied");assert.equal(host.get(id).view.run?.status,"failed");
    stored!.status="undone";interruptAnswer=false;const run=host.get(id).view.run!;
    await host.accept(id,{text:"继续",recovery:{runId:run.runId,confirmAdditionalCost:true}},"resume","fixture");await host.active.get(id)?.done;
    assert.equal(toolCalls,1,"recovery must not issue the committed batch again");assert.equal(host.get(id).view.messages.find(m=>m.id===author.id)?.storyRecording?.status,"undone");assert.equal(host.get(id).view.run?.status,"completed");
    mode="failed";assert.equal((await send("failed")).storyRecording?.status,"failed");assert.equal(host.get(id).view.run?.status,"completed");
    mode="unknown";assert.equal((await send("unknown")).storyRecording?.status,"unknown");assert.equal(host.get(id).view.run?.status,"completed");
    mode="offered";recording=false;assert.equal((await send("offered")).storyRecording?.status,"offered");assert.equal(host.get(id).view.run?.status,"completed");
  }finally{await host.close();provider.closeAllConnections();story.closeAllConnections();provider.close();story.close();rmSync(state,{recursive:true,force:true})}
});
