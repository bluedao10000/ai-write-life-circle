import test from "node:test";
import assert from "node:assert/strict";
import type {ThinkingEvent} from "@writer-agent/contracts";
import type {PiHost} from "../src/runtime/pi-host.js";
import {server} from "../src/server/http.js";

test("HTTP event pages and idle SSE drain indexed batches without reading full session history",async()=>{
 const id="th-00000000-0000-0000-0000-000000000000";
 const events:ThinkingEvent[]=Array.from({length:450},(_,index)=>({id:index+1,type:"session_completed"}));
 const requests:number[]=[];
 const view={sessionId:id,status:"idle",cursor:450,messages:[]};
 const host={
  config:{token:"test-token"},ready:Promise.resolve(),
  get:()=>{throw Error("full session must not be read")},getRecent:()=>{throw Error("old session view must not be read")},
  store:{
   waitPublished:async()=>{},
   snapshot:()=>view,
   readEvents:(_id:string,after:number,limit:number)=>{requests.push(limit);return {view,events:events.slice(after,after+limit)}},
  },
 } as unknown as PiHost;
 const http=server(host);
 try {
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${(http.address() as {port:number}).port}/internal/v1/sessions/${id}/events`;
  const page=await fetch(url,{headers:{Authorization:"Bearer test-token"}});
  assert.equal(page.status,200);
  const response=await page.json() as {items:ThinkingEvent[];cursor:number;status:string};
  assert.equal(response.items.length,200);assert.equal(response.cursor,200);assert.equal(response.status,"idle");
  const stream=await fetch(url,{headers:{Authorization:"Bearer test-token",Accept:"text/event-stream"}});
  assert.equal(stream.status,200);
  const text=await stream.text(),ids=[...text.matchAll(/^id: (\d+)$/gm)].map(match=>Number(match[1]));
  assert.deepEqual(ids,events.map(event=>event.id));
  assert(requests.every(limit=>limit===200));
  assert.equal((await fetch(url+"?after=451",{headers:{Authorization:"Bearer test-token"}})).status,422);
 } finally {http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()))}
});
