import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {Store,type Saved} from "../src/sessions/store.js";
import type {PiHost} from "../src/runtime/pi-host.js";
import {server} from "../src/server/http.js";

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}};
function saved(id:string):Saved {
 return {schema:1,accountingVersion:2,owner:"author",entries:[],events:[{id:1,type:"session_started"}],requests:{},view:{sessionId:id,bookId:"book",title:"Original",createdAt:"now",model:{provider:"fixture",model:"fixture",endpoint:"https://example.invalid",protocol:"thinking-v1",limits:{maxTurnsPerRequest:1,maxToolCalls:1,maxInputTokens:100,maxOutputTokens:100,maxSessionTokens:1000,maxConcurrentSessions:1,maxDurationMs:1000,maxToolResultBytes:1000}},scopes:[],status:"idle",messages:[],cursor:1,usage:{input:0,output:0,charged:0,incomplete:false}}};
}
async function listen(store:Store,id:string){
 const http=server({config:{token:"test-token"},ready:store.ready,store} as PiHost);
 await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
 return {http,url:`http://127.0.0.1:${(http.address() as {port:number}).port}/internal/v1/sessions/${id}`};
}
const headers={Authorization:"Bearer test-token"};

test("Session GET waits for the committed state to finish event projection",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-publication-wait-")),id="th-"+randomUUID(),entered=deferred(),release=deferred();let hold=false;
 const store=new Store(dir,{onPhase:async phase=>{if(hold&&phase==="state_committed"){entered.resolve();await release.promise}}});
 await store.write(saved(id));const {http,url}=await listen(store,id);
 try {
  const next=store.state(id)!;next.view.title="Published";next.events=[{id:2,type:"session_completed"}];next.view.cursor=2;
  hold=true;const write=store.write(next);await entered.promise;
  const requested=deferred(),waitPublished=store.waitPublished.bind(store);
  store.waitPublished=async value=>{requested.resolve();await waitPublished(value)};
  let received=false;const response=fetch(url,{headers}).then(value=>{received=true;return value});
  await requested.promise;assert.equal(received,false);
  assert.throws(()=>store.snapshot(id),/SESSION_PROJECTION_PENDING/);
  release.resolve();await write;
  const reply=await response;assert.equal(reply.status,200);
  const body=await reply.json() as {title:string;cursor:number};assert.equal(body.title,"Published");assert.equal(body.cursor,2);
 } finally {release.resolve();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));await store.close();rmSync(dir,{recursive:true,force:true})}
});

test("Session GET fails after SQLite event append failure instead of publishing a successful snapshot",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"thinking-publication-failure-")),id="th-"+randomUUID(),store=new Store(dir);
 await store.write(saved(id));const {http,url}=await listen(store,id);
 const eventDb=new DatabaseSync(join(dir,id+".events.sqlite"));
 try {
  eventDb.exec("CREATE TRIGGER reject_event BEFORE INSERT ON thinking_events BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END;");
  const next=store.state(id)!;next.view.title="Unpublished";next.events=[{id:2,type:"session_completed"}];next.view.cursor=2;
  await assert.rejects(store.write(next),/synthetic projection failure/);
  const reply=await fetch(url,{headers});assert.equal(reply.status,500);
  const body=await reply.json() as Record<string,unknown>;assert.equal(body.cursor,undefined);assert.equal(body.title,undefined);assert.equal(typeof body.code,"string");
  assert.equal((eventDb.prepare("SELECT COUNT(*) AS count FROM thinking_events").get() as {count:number}).count,1);
 } finally {eventDb.close();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));await store.close();rmSync(dir,{recursive:true,force:true})}
});
