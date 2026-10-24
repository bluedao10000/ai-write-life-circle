// Actual Go API/private listener ↔ shared Zod contract; no model requests.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {agentTaskClaimResultSchema,agentTaskEnvelopeSchema,agentTaskAcknowledgementSchema} from '../packages/contracts/dist/index.js';
import {startThinkingFixture,seedThinkingBook} from './lib/thinking-fixture.mjs';
const f=await startThinkingFixture({taskProtocol:true});
try{
 const book=await seedThinkingBook(f),base=`/v1/studio/books/${book.bookId}/knowledge`;
 const page=await f.call(base);
 await f.call(base+'/enable',{method:'POST',key:'consent',body:{baseVersion:page.version,consent:true,model:page.model,dailyTokenBudget:200000,dailyJobBudget:20}});
 async function taskCall(path,body,instance='fixture',status=200,token=f.taskToken){
  const r=await fetch(f.taskOrigin+'/internal/v1/agent/tasks/'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;
 }
 const cap=await taskCall('capabilities');assert.equal(cap.protocol,'agent-tasks-v1');
 const request={instance:'fixture',configFingerprint:cap.configFingerprint,contracts:cap.contracts};
 await taskCall('claim',{...request,contracts:{}},'fixture',409);
 assert.equal(agentTaskClaimResultSchema.parse(await taskCall('claim',request)).task,null);
 await taskCall('claim',request,'fixture',401,f.token); // Thinking credential is not a Worker credential.
 const result=spawnSync(new URL('../apps/api-go/dist/writer-agent-control',import.meta.url).pathname,['--state',join(f.root,'go-state'),'--kind','knowledge','--owner','pi','--wait','2s'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 await delay(2100);
 const claimed=await Promise.all([taskCall('claim',request),taskCall('claim',{...request,instance:'other'})]);
 const winner=claimed.findIndex(v=>agentTaskClaimResultSchema.parse(v).task!==null);assert.equal(claimed.filter(v=>v.task).length,1);
 const task=agentTaskClaimResultSchema.parse(claimed[winner]).task;
 assert.equal(task.kind,'knowledge.extract');assert.equal(task.bookId,book.bookId);
 const input=agentTaskEnvelopeSchema.parse({leaseToken:task.leaseToken,executorEpoch:task.executorEpoch,attempt:task.attempt,kind:task.kind,inputHash:task.inputHash,instance:winner===0?'fixture':'other',response:{text:'{"entities":[],"assertions":[]}',usage:{inputTokens:10,outputTokens:10}}});
 await taskCall(task.taskId+'/complete',input,'fixture',409);
 agentTaskAcknowledgementSchema.parse(await taskCall(task.taskId+'/started',input));
 agentTaskAcknowledgementSchema.parse(await taskCall(task.taskId+'/started',input));
 agentTaskAcknowledgementSchema.parse(await taskCall(task.taskId+'/heartbeat',input));
 agentTaskAcknowledgementSchema.parse(await taskCall(task.taskId+'/complete',input));
 agentTaskAcknowledgementSchema.parse(await taskCall(task.taskId+'/complete',input));
 assert.equal(f.calls.length,0,'Protocol preparation must never call an external model');
 const publicRoute=await fetch(f.api+'/internal/v1/agent/tasks/claim',{method:'POST',headers:{authorization:'Bearer '+f.bearer}});assert.equal(publicRoute.status,404);
 console.log('PASS: real Go task API / Zod, distinct service identity, unchanged Go default, ownership switch, racing claims, started, heartbeat, idempotent completion, public denial; zero LLM calls.');
}finally{await f.close()}
