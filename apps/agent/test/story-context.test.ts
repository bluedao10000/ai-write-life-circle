import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {tools,type StoryExecution} from "../src/tools/registry.js";
import {PiHost} from "../src/runtime/pi-host.js";
import {Store} from "../src/sessions/store.js";
import {storyContextText} from "../src/tools/story-context.js";
import type {Config} from "../src/config.js";

const config={storyOrigin:"http://127.0.0.1:8791",model:{limits:{maxToolResultBytes:24000}}} as Config;
const args={changes:[{intent:"decide",kind:"character",patch:{name:"林舟"},evidence:[{messageId:"author-current",quote:"主角叫林舟"}]}]};
const execution=():StoryExecution=>({messageId:"author-current",runId:"run-current",dialogueRecording:true,writes:{},persist:()=>{}});
const registered=(ex:StoryExecution,scopes=["creative"])=>tools(config,"session","fixture",new AbortController().signal,()=>{},()=>true,scopes,ex);
const invoke=async(tool:ReturnType<typeof registered>[number],input:unknown=args)=>{
  const result=await tool.execute("call",input,new AbortController().signal,()=>{},{} as never);
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
  assert(names(execution()).includes("update_discussion_focus"));
  assert(!names({...execution(),dialogueRecording:false}).includes("record_story_changes"));
  assert(names({...execution(),dialogueRecording:false}).includes("get_discussion_source"));
  assert(!names(execution(),["chapters"]).includes("record_story_changes"));
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
    const replay=await invoke(tool,{changes:[]});assert.equal(replay.details.alreadyRecorded,true);assert.equal(requests,2);assert(persisted>=3);
  }finally{globalThis.fetch=original}
});

test("unknown save outcome retains original batch across recovery and forbids a changed batch",async()=>{
  const original=globalThis.fetch,ex=execution();let requests=0;
  globalThis.fetch=async()=>{requests++;throw Error("connection closed after request")};
  try {
    let tool=registered(ex).find(t=>t.name==="record_story_changes")!;
    assert.equal((await invoke(tool)).details.code,"OUTCOME_UNKNOWN");
    assert.deepEqual(ex.writes.record_story_changes.arguments,args);
    assert.equal((await invoke(tool,{changes:[]})).details.code,"PENDING_STORY_CHANGE");
    assert.equal((await invoke(tool)).details.code,"OUTCOME_UNKNOWN");assert.equal(requests,1);
    // A new run has the durable arguments but can safely retry the original request.
    globalThis.fetch=async(_url,init)=>{requests++;assert.deepEqual(JSON.parse(init?.body as string).arguments,args);return new Response('{"changeId":"receipt-after-recovery","status":"applied"}')};
    tool=registered({...ex,runId:"run-recovery"}).find(t=>t.name==="record_story_changes")!;
    assert.equal((await invoke(tool,{changes:[]})).details.code,"PENDING_STORY_CHANGE");
    assert.match(JSON.stringify(await invoke(tool)),/receipt-after-recovery/);assert.equal(requests,2);
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
