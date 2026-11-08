import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {ThinkingModel} from "@writer-agent/contracts";
import {completeOnce} from "../src/runtime/oneshot.js";
import {server} from "../src/server/http.js";
import {PiHost} from "../src/runtime/pi-host.js";
import {Store} from "../src/sessions/store.js";
import type {Config} from "../src/config.js";

const model=(endpoint:string):ThinkingModel=>(({provider:"fixture",model:"fixture",endpoint,protocol:"thinking-v1",limits:{maxTurnsPerRequest:1,maxToolCalls:1,maxInputTokens:20000,maxOutputTokens:2048,maxSessionTokens:20000,maxConcurrentSessions:1,maxDurationMs:90000,maxToolResultBytes:24000}} as unknown as ThinkingModel));

test("one-shot generation sends one bounded tool-free JSON request",async()=>{
 const requests:Record<string,unknown>[]=[];
 const http=createServer(async(req,res)=>{let raw="";for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.writeHead(200,{"content-type":"text/event-stream"});res.end("data: "+JSON.stringify({id:"fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta:{role:"assistant",content:'{"title":"逐玉"}'},finish_reason:"stop"}],usage:{prompt_tokens:1200,completion_tokens:300}})+"\n\ndata: [DONE]\n\n")});
 await new Promise<void>(r=>http.listen(0,"127.0.0.1",r));
 const endpoint=`http://127.0.0.1:${(http.address() as {port:number}).port}/v1`;
 try{
  const result=await completeOnce(model(endpoint),"fixture-key",{system:"发布资料",input:"书名：逐玉",maxOutputTokens:1200},new AbortController().signal);
  assert.equal(result.text,'{"title":"逐玉"}');
  assert.deepEqual(result.usage,{inputTokens:1200,outputTokens:300,cachedInputTokens:0});
  assert.equal(requests.length,1);
  assert.equal(requests[0].max_tokens,1200);
  assert.deepEqual(requests[0].response_format,{type:"json_object"});
  assert.equal(requests[0].tools,undefined);
 }finally{http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()))}
});

test("PiHost generate uses the enabled model entry and its own key",async()=>{
 const keys:string[]=[];
 const http=createServer(async(req,res)=>{let raw="";for await(const chunk of req)raw+=chunk;keys.push(String(req.headers.authorization));res.writeHead(200,{"content-type":"text/event-stream"});res.end("data: "+JSON.stringify({id:"fixture",object:"chat.completion.chunk",model:"entry",choices:[{index:0,delta:{role:"assistant",content:'{"title":"逐玉"}'},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:20}})+"\n\ndata: [DONE]\n\n")});
 await new Promise<void>(r=>http.listen(0,"127.0.0.1",r));
 const endpoint=`http://127.0.0.1:${(http.address() as {port:number}).port}/v1`;
 const state=mkdtempSync(join(tmpdir(),"pi-generate-"));
 const fallback={...model(endpoint),model:"fallback"} as ThinkingModel;
 const entry={...model(endpoint),model:"entry"} as ThinkingModel;
 const config={state,port:8790,storyOrigin:"http://127.0.0.1:8791",token:"t".repeat(64),key:"",version:"fixture",model:fallback,models:[{model:entry,key:"entry-key",enabled:true,description:"fixture"}]} as Config;
 const host=new PiHost(config,new Store(state));
 try{
  const out=await host.generate({system:"s",input:"i",maxOutputTokens:256});
  assert.equal(out.text,'{"title":"逐玉"}');
  assert.deepEqual(keys,["Bearer entry-key"]);
 }finally{await host.close();rmSync(state,{recursive:true,force:true});http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()))}
});

test("generate route validates input and rejects GET",async()=>{
 const inputs:unknown[]=[];
 const host={config:{token:"test-token"},generate:async(input:unknown)=>{inputs.push(input);return {text:"{}",usage:null}}} as unknown as PiHost;
 const http=server(host);
 try{
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${(http.address() as {port:number}).port}/internal/v1/generate`;
  const ok=await fetch(url,{method:"POST",headers:{Authorization:"Bearer test-token","Content-Type":"application/json"},body:JSON.stringify({system:"s",input:"i",maxOutputTokens:512})});
  assert.equal(ok.status,200);
  assert.deepEqual(inputs,[{system:"s",input:"i",maxOutputTokens:512}]);
  const bad=await fetch(url,{method:"POST",headers:{Authorization:"Bearer test-token","Content-Type":"application/json"},body:JSON.stringify({system:"",input:"i",maxOutputTokens:512})});
  assert.equal(bad.status,422);
  assert.equal((await fetch(url,{headers:{Authorization:"Bearer test-token"}})).status,404);
 }finally{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()))}
});
