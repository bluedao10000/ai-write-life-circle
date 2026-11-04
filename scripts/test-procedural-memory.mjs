import assert from 'node:assert/strict';
import {createPiWorkerFixture,until} from './lib/pi-worker-fixture.mjs';
import {proceduralRecordSchema,proceduralListSchema,proceduralEvidenceListSchema} from '../packages/contracts/dist/procedural-memory.js';
const f=await createPiWorkerFixture({modelBudget:{maxModelCalls:10,maxTokens:200000}});
try{
 const worker=f.start('pi-worker');await until(()=>worker.output.includes('worker_started'),'Worker ready');
 const book=await f.call('/v1/studio/books',{method:'POST',status:201,body:{operation:'create',baseVersion:0,title:'Procedural evidence fixture'}});
 const base='/v1/studio/books/'+book.bookId,root=base+'/procedural-memory',knowledge=base+'/knowledge';
 await f.call(base+'/creative/settings/pause',{method:'POST',body:{}});
 const settings=await f.call(knowledge);
 await f.call(knowledge+'/enable',{method:'POST',body:{baseVersion:settings.version,consent:true,model:settings.model,dailyTokenBudget:100000,dailyJobBudget:3}});
 const chapter='/v1/projects/'+book.bookId+'/chapters/'+book.chapters[0].chapterId;
 for(const text of ['林舟在北港等待。','林舟在南港整理旧信。']){
  const head=await f.call(chapter);
  const saved=await f.call(chapter+'/revisions',{method:'POST',status:201,body:{baseRevisionId:head.headRevision.revisionId,markdown:text}});
  await until(async()=>{const {items}=await f.call(knowledge+'/jobs');return items.some(job=>job.revisionId===saved.revisionId&&job.status==='completed')},'completed independent extraction');
 }
 const evidence=await until(async()=>{const page=proceduralEvidenceListSchema.parse(await f.call(root+'/evidence'));return page.items.filter(item=>item.kind==='knowledge.extract').length===2&&page},'completed task receipts');
 const ids=evidence.items.filter(item=>item.kind==='knowledge.extract').map(item=>item.taskId);
 assert.equal(ids.length,2);assert.notEqual(evidence.items[0].inputHash,evidence.items[1].inputHash);
 const candidate=proceduralRecordSchema.parse(await f.call(root,{method:'POST',key:'create-memory',status:201,body:{content:'PROCEDURAL_REVIEWED_RULE: 核对林舟的原文证据后再整理人物观察。',taskIds:[ids[0]]}}));
 assert.equal(candidate.status,'candidate');
 assert.equal(proceduralListSchema.parse(await f.call(root)).items[0].available,false);
 await f.call(root,{user:{id:'other-author',email:'other@example.com'},status:404});
 const second=proceduralRecordSchema.parse(await f.call(root,{method:'POST',key:'create-duplicate',status:201,body:{content:candidate.content,taskIds:[ids[1]]}}));
 const mergePath=root+'/'+candidate.id+'/merge',mergeInput={baseVersion:1,sources:[{id:second.id,baseVersion:1}]};
 await f.call(mergePath,{method:'POST',status:422,body:{...mergeInput,bookId:'other-book'}});
 await f.call(mergePath,{method:'POST',user:{id:'other-author',email:'other@example.com'},status:404,body:mergeInput});
 const merged=proceduralRecordSchema.parse(await f.call(mergePath,{method:'POST',key:'merge-memory',body:mergeInput}));
 assert.equal(merged.status,'candidate');assert.equal(merged.version,2);assert.equal(merged.provenance.length,2);
 await f.stop(f.api());await f.startAPI();
 assert.deepEqual(proceduralRecordSchema.parse(await f.call(mergePath,{method:'POST',key:'merge-memory',body:mergeInput})),merged);
 const pending=proceduralListSchema.parse(await f.call(root)).items;
 assert(pending.every(item=>!item.available));assert.equal(pending.find(item=>item.id===second.id).status,'rejected');
 const pi=f.start('pi');await until(()=>pi.output.includes('agent_started'),'Thinking ready');
 await fetch(f.origin+'/control',{method:'POST',body:JSON.stringify({mode:'memory-read'})});
 async function retrieve(){
  const start=f.requests.length,model=await f.call(base+'/thinking/capabilities');
  const session=await f.call(base+'/thinking/sessions',{method:'POST',status:201,body:{consent:true,model,scopes:['creative','knowledge']}});
  const path=base+'/thinking/sessions/'+session.sessionId;
  await f.call(path+'/messages',{method:'POST',status:202,body:{text:'检索作者审核的操作经验。'}});
  const state=await until(async()=>{const s=await f.call(path);return s.status==='idle'&&s},'memory reply');
  assert.equal(state.messages.at(-1)?.status,'completed');
  const memories=f.requests.slice(start).flatMap(request=>request.messages.filter(m=>m.role==='tool').flatMap(m=>{try{const v=JSON.parse(m.content);return Array.isArray(v.records)?[v]:[]}catch{return []}}));
  assert(memories.length);return memories.at(-1).records.filter(r=>r.layer==='procedural');
 }
 assert.deepEqual(await retrieve(),[]);
 const confirmed=proceduralRecordSchema.parse(await f.call(root+'/'+candidate.id,{method:'POST',key:'confirm-memory',body:{action:'confirm',baseVersion:merged.version}}));
 assert.equal(confirmed.status,'confirmed');
 await f.call(root+'/'+candidate.id,{method:'POST',body:{action:'reject',baseVersion:1},status:409});
 await f.stop(f.api());await f.startAPI();
 assert.equal(proceduralListSchema.parse(await f.call(root)).items.find(item=>item.id===candidate.id).available,true);
 const records=await retrieve();assert.equal(records.length,1);assert.equal(records[0].id,candidate.id);assert.equal(records[0].provenance.length,2);assert.equal(records[0].status,'confirmed');
 await f.call(root+'/'+candidate.id,{method:'POST',key:'delete-memory',body:{action:'delete',baseVersion:confirmed.version}});
 await f.call(root,{method:'POST',key:'create-memory',status:410,body:{content:'PROCEDURAL_REVIEWED_RULE: 核对林舟的原文证据后再整理人物观察。',taskIds:[ids[0]]}});
 await f.call(mergePath,{method:'POST',key:'merge-memory',status:410,body:mergeInput});
 assert.deepEqual(await retrieve(),[]);
 console.log('PASS: real Go/Pi Worker receipts, duplicate candidate merge, restart replay, separate author review, independent evidence, scoped retrieval, API restart, version conflict and deletion replay. Synthetic provider only.');
}finally{await f.close()}
