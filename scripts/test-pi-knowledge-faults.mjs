import assert from 'node:assert/strict';
import {createPiWorkerFixture,until,sleep} from './lib/pi-worker-fixture.mjs';
const f=await createPiWorkerFixture();let node,go;
const ready=async p=>until(()=>{if(p.exitCode!==null)throw Error(p.output);return p.output.includes('worker_started')},'Pi ready');
try{
 const book=await f.call('/v1/studio/books',{method:'POST',status:201,body:{operation:'create',baseVersion:0,title:'隔离故障测试'}}),id=book.bookId,chapter=book.chapters[0].chapterId,root=`/v1/studio/books/${id}/knowledge`,path=`/v1/projects/${id}/chapters/${chapter}`;
 const view=()=>f.call(root),jobs=async()=>(await f.call(root+'/jobs')).items;
 async function mutate(action,extra={}){return f.call(root+'/'+action,{method:'POST',body:{baseVersion:(await view()).version,...extra}})}
 async function save(text){const c=await f.call(path);return f.call(path+'/revisions',{method:'POST',status:201,body:{baseRevisionId:c.headRevision.revisionId,markdown:text}})}
 async function mode(value){await fetch(f.origin+'/control',{method:'POST',body:JSON.stringify({mode:value})})}
 const done=async count=>until(async()=>{const j=await jobs();return j.filter(x=>x.status==='completed').length>=count&&j},'Knowledge domain completion',30000);
 await save('林舟与父亲争执。');f.switchOwner('knowledge','pi');go=f.start('worker');node=f.start('pi-worker');await ready(node);
 let page=await view();await mode('usage-missing');await mutate('enable',{consent:true,model:page.model,dailyTokenBudget:1000000,dailyJobBudget:1});await done(1);page=await view();assert.ok(page.budgetTokens>=34048,'unknown model usage must remain conservatively charged');assert.equal(page.budgetAttempts,1);
 // Pause races with provider completion: no candidate can commit while paused.
 await mode('knowledge-slow');await mutate('enable',{consent:true,model:page.model,dailyTokenBudget:1000000,dailyJobBudget:20});let before=f.calls;await mutate('rebuild',{chapterId:chapter});await until(()=>f.calls>before,'provider entered');await mutate('pause');await sleep(2100);assert.equal((await jobs()).filter(j=>j.status==='completed').length,0);
 await f.stop(node);await f.stop(go);await f.expireKnowledge(id);await mode('knowledge-empty');await mutate('resume');node=f.start('pi-worker');await ready(node);await done(1);
 // Go committed a new Knowledge completion but the acknowledgement is dropped.
 before=f.calls;f.dropCompletion();await mutate('rebuild',{chapterId:chapter});await done(1);await until(()=>f.dropped===1,'dropped Knowledge acknowledgement');await sleep(500);assert.equal(f.calls,before+1);
 // A newer Revision invalidates the in-flight snapshot, then a killed Node is fenced.
 await mode('knowledge-slow');before=f.calls;await mutate('rebuild',{chapterId:chapter});await until(()=>f.calls>before,'old Revision entered provider');await save('林舟如今改行，父亲离开北港。');await f.stop(node,'SIGKILL');await f.expireKnowledge(id);await mode('knowledge-empty');node=f.start('pi-worker');await ready(node);const result=await done(1);assert.ok(result.some(j=>j.status==='superseded'));const head=await f.call(path);assert.equal(result.find(j=>j.status==='completed').revisionId,head.headRevision.revisionId);
 // API restart reconnects from durable task/domain receipts.
 await f.stop(f.api());await f.startAPI();await until(async()=>{const s=await f.call('/v1/agent-runtime');return s.executors.knowledge.ready},'Knowledge API reconnect');
 // Simulate the stored UTC budget day rolling over with all executors stopped.
 await f.stop(node);await f.rollBudgetDay(id);await mutate('rebuild',{chapterId:chapter});node=f.start('pi-worker');await ready(node);await done(1);const reset=await view();assert.equal(reset.budgetDay,new Date().toISOString().slice(0,10));assert.equal(reset.budgetAttempts,1);assert.equal(reset.budgetTokens,250);
 // Provider timeout is reported without Node retry and without refunding unknown cost.
 const attempts=(await view()).budgetAttempts;await mutate('enable',{consent:true,model:page.model,dailyTokenBudget:1000000,dailyJobBudget:attempts+1});await mode('knowledge-timeout');before=f.calls;await mutate('rebuild',{chapterId:chapter});await until(async()=>{const j=await jobs();return j.some(x=>x.failureCode==='LLM_TIMEOUT')},'provider timeout',30000);assert.equal(f.calls,before+1);await mutate('enable',{consent:true,model:page.model,dailyTokenBudget:1000000,dailyJobBudget:20});await mode('knowledge-empty');await done(1);
 // Deleting a managed book revokes active task capabilities and scrubs snapshots.
 await mode('knowledge-slow');before=f.calls;await mutate('rebuild',{chapterId:chapter});await until(()=>f.calls>before,'delete target entered provider');
 const detail=await f.call(`/v1/studio/books/${id}`);await f.call(`/v1/studio/books/${id}`,{method:'DELETE',status:204,body:{baseVersion:detail.version}});await sleep(2100);
 await f.call(`/v1/studio/books/${id}`,{status:404});await f.stop(node);await until(async()=>!(await f.call('/v1/agent-runtime')).executors.knowledge.ready,'offline executor status');
 console.log('PASS: Pi Knowledge unknown usage, budget, pause/complete race, lost acknowledgement, Revision supersede, SIGKILL, API restart and book deletion. Synthetic only.');
}finally{await f.close()}
