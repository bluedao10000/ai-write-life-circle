import assert from 'node:assert/strict';
import {createPiWorkerFixture,until} from './lib/pi-worker-fixture.mjs';
import {proceduralRecordSchema,proceduralListSchema,proceduralEvidenceListSchema,proceduralOutcomeSchema} from '../packages/contracts/dist/procedural-memory.js';
import {thinkingSessionSchema} from '../packages/contracts/dist/thinking.js';
const f=await createPiWorkerFixture({modelBudget:{maxModelCalls:16,maxTokens:320000}});
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
 const previews=[];
 for(const taskId of ids){
  const source=await f.call(root+'/evidence/'+taskId);
  assert.equal(source.evidence.taskId,taskId);assert.equal(source.source.type,'chapter');assert.equal(source.truncated,false);
  previews.push(source.source.text);
  const outcome=proceduralOutcomeSchema.parse(await f.call(root+'/evidence/'+taskId+'/outcome'));
  assert.equal(outcome.evidence.taskId,taskId);assert.equal(outcome.basis,'revision_observations');
  assert(outcome.items.length<=20);assert(outcome.items.reduce((sum,item)=>sum+Buffer.byteLength(item.text),0)<=16384);

  assert(!JSON.stringify(source).includes('leaseToken'));
 }
 assert.deepEqual(previews.sort(),['林舟在北港等待。','林舟在南港整理旧信。'].sort());
 await f.call(root+'/evidence/'+ids[0],{user:{id:'other-author',email:'other@example.com'},status:404});
 await f.call(root+'/evidence/'+ids[0]+'/outcome',{user:{id:'other-author',email:'other@example.com'},status:404});

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
 let retrievalPath;
 async function retrieve(){
  await fetch(f.origin+'/control',{method:'POST',body:JSON.stringify({mode:'memory-read'})});
  if(!retrievalPath){const model=await f.call(base+'/thinking/capabilities'),session=await f.call(base+'/thinking/sessions',{method:'POST',status:201,body:{consent:true,model,scopes:['creative','knowledge']}});retrievalPath=base+'/thinking/sessions/'+session.sessionId}
  const start=f.requests.length;
  await f.call(retrievalPath+'/messages',{method:'POST',status:202,body:{text:'检索作者审核的操作经验。'}});
  const state=await until(async()=>{const s=await f.call(retrievalPath);return s.status==='idle'&&s},'memory reply');
  assert.equal(state.messages.at(-1)?.status,'completed',JSON.stringify({failure:state.run?.failure,last:state.messages.at(-1)}));
  const memories=f.requests.slice(start).flatMap(request=>request.messages.filter(m=>m.role==='tool').flatMap(m=>{try{const v=JSON.parse(m.content);return Array.isArray(v.records)?[v]:[]}catch{return []}}));
  assert(memories.length,JSON.stringify({state,stats:await (await fetch(f.origin+'/stats')).json(),failures:state.messages.filter(message=>message.status==='failed').map(message=>message.errorCode),requests:f.requests.slice(start).map(request=>({system:request.messages.find(message=>message.role==='system')?.content.slice(0,120),roles:request.messages.map(message=>message.role)}))}));
  const procedural=memories.at(-1).records.filter(r=>r.layer==='procedural');
  return procedural;
 }
 assert.deepEqual(await retrieve(),[]);
 const confirmed=proceduralRecordSchema.parse(await f.call(root+'/'+candidate.id,{method:'POST',key:'confirm-memory',body:{action:'confirm',baseVersion:merged.version}}));
 assert.equal(confirmed.status,'confirmed');
 await f.call(root+'/'+candidate.id,{method:'POST',body:{action:'reject',baseVersion:1},status:409});
 await f.stop(f.api());await f.startAPI();
 assert.equal(proceduralListSchema.parse(await f.call(root)).items.find(item=>item.id===candidate.id).available,true);
 const records=await retrieve();assert.equal(records.length,1);assert.equal(records[0].id,candidate.id);assert.equal(records[0].provenance.length,2);assert.equal(records[0].status,'confirmed');
 await fetch(f.origin+'/control',{method:'POST',body:JSON.stringify({mode:'memory-relation'})});
 const extractionSession=thinkingSessionSchema.parse(await f.call(base+'/thinking/sessions',{method:'POST',status:201,body:{consent:true,memoryExtraction:{taskIds:[ids[0]]}}}));
 assert.equal(extractionSession.memoryExtraction.version,3);assert.deepEqual(extractionSession.memoryExtraction.comparisons,[{memoryId:candidate.id,memoryVersion:confirmed.version}]);assert.equal(extractionSession.memoryExtraction.comparisonOmitted,0);
 const extractionPath=base+'/thinking/sessions/'+extractionSession.sessionId;
 await f.call(extractionPath+'/messages',{method:'POST',status:202,body:{text:'提取经验并比较已有方法。'}});
 const extracted=await until(async()=>{const state=await f.call(extractionPath);return state.status==='idle'&&state.run?.status==='completed'&&state},'extraction with relation');
 assert(f.requests.at(-1).messages.find(message=>message.role==='system').content.includes(candidate.content));
 const relational=proceduralRecordSchema.parse(await f.call(extractionPath+'/memory-candidate',{method:'POST',status:201,body:{runId:extracted.run.runId}}));
 assert.equal(relational.extractions[0].promptVersion,'memory-extraction-v3');
 assert.deepEqual(relational.extractions[0].relations,[{memoryId:candidate.id,memoryVersion:confirmed.version,kind:'conflict',reason:'合成比较：两条方法对当前修订的使用顺序不同。'}]);
 await f.call(root+'/'+relational.id,{method:'POST',key:'delete-relation-candidate',body:{action:'delete',baseVersion:relational.version}});
 await fetch(f.origin+'/control',{method:'POST',body:JSON.stringify({mode:'memory-relation-foreign'})});
 const rejectedSession=thinkingSessionSchema.parse(await f.call(base+'/thinking/sessions',{method:'POST',status:201,body:{consent:true,memoryExtraction:{taskIds:[ids[0]]}}}));
 const rejectedPath=base+'/thinking/sessions/'+rejectedSession.sessionId;
 await f.call(rejectedPath+'/messages',{method:'POST',status:202,body:{text:'提取经验并尝试引用未绑定的经验。'}});
 const rejectedRun=await until(async()=>{const state=await f.call(rejectedPath);return state.status==='idle'&&state.run?.status==='completed'&&state},'invalid relation extraction');
 await f.call(rejectedPath+'/memory-candidate',{method:'POST',status:422,body:{runId:rejectedRun.run.runId}});
 await f.call(rejectedPath,{method:'DELETE',status:204});
 const replacement=proceduralRecordSchema.parse(await f.call(root,{method:'POST',key:'create-replacement',status:201,body:{content:'PROCEDURAL_REVIEWED_RULE: 先核对当前修订，再按人物关系整理观察。',taskIds:ids}}));
 const supersedePath=root+'/'+replacement.id+'/supersede';
 const supersedeInput={baseVersion:replacement.version,replaces:[{id:candidate.id,baseVersion:confirmed.version}]};
 await f.call(supersedePath,{method:'POST',status:422,body:{...supersedeInput,bookId:'other-book'}});
 await f.call(supersedePath,{method:'POST',user:{id:'other-author',email:'other@example.com'},status:404,body:supersedeInput});
 const superseded=proceduralRecordSchema.parse(await f.call(supersedePath,{method:'POST',key:'supersede-memory',body:supersedeInput}));
 assert.equal(superseded.status,'confirmed');assert.equal(superseded.version,2);assert.deepEqual(superseded.supersedes,[candidate.id]);
 const replaced=proceduralListSchema.parse(await f.call(root)).items;
 assert.equal(replaced.find(item=>item.id===candidate.id).status,'rejected');
 assert.equal(replaced.find(item=>item.id===candidate.id).unavailableReason,'superseded');
 assert.equal(replaced.find(item=>item.id===candidate.id).supersededBy,replacement.id);
 assert.equal(replaced.find(item=>item.id===replacement.id).available,true);
 await f.call(supersedePath,{method:'POST',body:{...supersedeInput,baseVersion:replacement.version},status:409});
 await f.stop(f.api());await f.startAPI();
 assert.deepEqual(proceduralRecordSchema.parse(await f.call(supersedePath,{method:'POST',key:'supersede-memory',body:supersedeInput})),superseded);
 const callsBeforeChangedComparison=f.calls;
 await f.call(extractionPath+'/messages',{method:'POST',status:409,body:{text:'再次比较已经变化的经验。'}});
 assert.equal(f.calls,callsBeforeChangedComparison,'changed comparison must be rejected before another model request');
 await f.call(extractionPath,{method:'DELETE',status:204});
 const replacedRecords=await retrieve();assert.equal(replacedRecords.length,1);assert.equal(replacedRecords[0].id,replacement.id);assert.equal(replacedRecords[0].status,'confirmed');
 await f.call(root+'/'+candidate.id,{method:'POST',key:'delete-replaced-memory',body:{action:'delete',baseVersion:replaced.find(item=>item.id===candidate.id).version}});
 await f.call(root+'/'+replacement.id,{method:'POST',key:'delete-memory',body:{action:'delete',baseVersion:superseded.version}});
 await f.call(root,{method:'POST',key:'create-memory',status:410,body:{content:'PROCEDURAL_REVIEWED_RULE: 核对林舟的原文证据后再整理人物观察。',taskIds:[ids[0]]}});
 await f.call(mergePath,{method:'POST',key:'merge-memory',status:410,body:mergeInput});
 await f.call(supersedePath,{method:'POST',key:'supersede-memory',status:410,body:supersedeInput});
 assert.deepEqual(await retrieve(),[]);
 console.log('PASS: real Go/Pi Worker receipts, duplicate merge, separate review, governed semantic relation suggestion, explicit supersede, independent evidence, scoped retrieval, restart replay, version conflict and deletion fences. Synthetic provider only.');
}finally{await f.close()}
