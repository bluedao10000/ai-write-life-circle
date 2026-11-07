import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {ThinkingRun} from '@writer-agent/contracts';
import {Store,type Saved} from '../src/sessions/store.js';
import {PiHost} from '../src/runtime/pi-host.js';
import {server} from '../src/server/http.js';
function saved(id:string):Saved {
 return {schema:1,accountingVersion:2,owner:"author",entries:[],events:[{id:1,type:"session_started"}],requests:{},view:{sessionId:id,bookId:"book",title:"Original",createdAt:"now",model:{provider:"fixture",model:"fixture",endpoint:"https://example.invalid",protocol:"thinking-v1",limits:{maxTurnsPerRequest:1,maxToolCalls:1,maxInputTokens:100,maxOutputTokens:100,maxSessionTokens:1000,maxConcurrentSessions:1,maxDurationMs:1000,maxToolResultBytes:1000}},scopes:[],status:"idle",messages:[],cursor:1,usage:{input:0,output:0,charged:0,incomplete:false}}};
}
function run(status:ThinkingRun['status'],attempt:number,durationMs:number,modelCalls:number):ThinkingRun {
 return {runId:randomUUID(),traceId:randomUUID(),messageId:randomUUID(),status,stepType:status==='completed'?'completed':'provider',checkpointId:randomUUID(),epoch:attempt,attempt,retryCount:attempt-1,modelCalls,resumable:false,provider:'fixture',model:'synthetic',startedAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:01.000Z',durationMs};
}

test('authenticated runtime diagnostics expose projection failure and restart recovery without session content',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'runtime-health-')),id='th-'+randomUUID();
 const value=saved(id);value.view.title='private-title';
 value.runs=[run('completed',1,10,2),run('failed',2,20,1),run('interrupted',1,30,4)];
 value.view.run=run('cancelled',3,40,3);
 const config={state:dir,port:1,version:'fixture',token:'private-token',key:'private-key',model:value.view.model,storyOrigin:'http://127.0.0.1:1'};
 let store=new Store(dir),host=new PiHost(config,store);
 await store.write(value);
 const http=server(host);await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(http.address() as {port:number}).port}/internal/v1/`;
 const headers={Authorization:'Bearer '+config.token};
 const db=new DatabaseSync(join(dir,id+'.events.sqlite'));
 try{
  for(const path of ['liveness','readiness','diagnostics'])assert.equal((await fetch(origin+path)).status,401);
  assert.equal((await fetch(origin+'readiness',{headers})).status,200);
  const legacy=await (await fetch(origin+'health',{headers})).json() as {protocol:string;runtime:{readiness:boolean}};
  assert.equal(legacy.protocol,'thinking-v1');assert.equal(legacy.runtime.readiness,true);
  db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON thinking_events BEGIN SELECT RAISE(ABORT,'private-failure'); END;");
  const next=store.state(id)!;next.events=[{id:2,type:'session_completed'}];next.view.cursor=2;
  await assert.rejects(store.write(next),/private-failure/);
  const response=await fetch(origin+'readiness',{headers});assert.equal(response.status,200);
  const health=await response.json() as ReturnType<PiHost['health']>;
  assert.equal(health.status,'degraded');assert.equal(health.components.projection,'degraded');
  assert.equal(health.counts.unpublishedSessions,1);assert.equal(health.counts.failedSessions,1);
  const diagnostic=await (await fetch(origin+'diagnostics',{headers})).text();
  for(const secret of [id,'private-title','private-token','private-key','private-failure'])assert.equal(diagnostic.includes(secret),false);
  const runMetrics=(JSON.parse(diagnostic) as {metrics:{persisted:{thinkingRuns:Record<string,unknown>}}}).metrics.persisted.thinkingRuns;
  assert.deepEqual(runMetrics,{schemaVersion:1,attempts:4,accepted:0,running:0,checkpointed:0,completed:1,failed:1,interrupted:1,cancelled:1,resumed:2,modelCalls:10,terminalSamples:4,durationP50Ms:20,durationP95Ms:40});
  db.exec('DROP TRIGGER reject_event');
  await host.close();
  assert.equal((await fetch(origin+'readiness',{headers})).status,503);
  assert.equal((await fetch(origin+'liveness',{headers})).status,200);
  store=new Store(dir);host=new PiHost(config,store);await host.ready;
  assert.equal(host.health().status,'ready');assert.equal(host.health().counts.unpublishedSessions,0);
  assert.deepEqual(host.diagnostics().metrics.persisted.thinkingRuns,runMetrics);
  const recovered=store.snapshot(id);assert(recovered);assert.equal(recovered.cursor,2);
 }finally{db.close();http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));await host.close();rmSync(dir,{recursive:true,force:true})}
});
