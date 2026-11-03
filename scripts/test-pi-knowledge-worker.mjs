import {importSyntheticEpub} from './lib/epub-bulk-fixture.mjs';
import assert from 'node:assert/strict';
import {createPiWorkerFixture,until,sleep} from './lib/pi-worker-fixture.mjs';
const sizes=process.argv.includes('--quick')?[10]:[10,100,500];
for(const size of sizes){
 const f=await createPiWorkerFixture();let thinkingCalls=0;
 try{
  const book=await importSyntheticEpub(f,size);
  await f.call(`/v1/studio/books/${book.bookId}/creative/settings/pause`,{method:'POST',body:{}});
  await fetch(f.origin+'/control',{method:'POST',body:JSON.stringify({mode:'knowledge-empty'})});
  const root=`/v1/studio/books/${book.bookId}/knowledge`;
  const view=()=>f.call(root);const progress=async()=>(await f.call('/v1/agent-runtime')).executors.knowledge.tasks;const mutate=async(action,extra={})=>f.call(root+'/'+action,{method:'POST',body:{baseVersion:(await view()).version,...extra}});
  const page=await view();assert.equal(page.settings.enabled,true);await mutate('enable',{consent:true,model:page.model,dailyTokenBudget:100000000,dailyJobBudget:1});
  const node=f.start('pi-worker');f.start('pi');
  await until(()=>{if(node.exitCode!==null)throw Error(node.output);return node.output.includes('worker_started')},'Pi worker startup',30000).catch(error=>{throw Error(`${error.message} (${size} chapters)\n${node.output}\n${f.api().output}`)});
  await until(async()=>{return (await progress()).completed===1},'first budgeted chapter',30000);
  await sleep(1500);assert.equal(f.calls,1,'daily job budget is authoritative');
  await mutate('pause');await sleep(1200);assert.equal(f.calls,1,'paused queue must not execute');
  await mutate('enable',{consent:true,model:page.model,dailyTokenBudget:100000000,dailyJobBudget:1000});
  if(size===500){const base=`/v1/studio/books/${book.bookId}/thinking`;const model=await f.call(base+'/capabilities');const session=await f.call(base+'/sessions',{method:'POST',status:201,body:{consent:true,model,scopes:['chapters']}});await f.call(base+'/sessions/'+session.sessionId+'/messages',{method:'POST',status:202,body:{text:'合成测试：简短回应，不读取正文。'}});await until(async()=>{const s=await f.call(base+'/sessions/'+session.sessionId);return s.messages.some(m=>m.role==='assistant'&&m.text.includes('合成思考回复'))},'Thinking during 500-chapter backfill');thinkingCalls=1}
  const deadline=Date.now()+900000;
  while(true){const v=await progress();if(v.completed===size)break;if(v.failed)throw Error(JSON.stringify(v));if(Date.now()>deadline)throw Error(`Bulk timeout ${size}: ${v.completed}`);await sleep(500)}
  const inputs=f.requests.map(r=>{try{return JSON.parse(r.messages.find(m=>m.role==='user').content)}catch{return null}}).filter(r=>r?.chapterId);
  assert.equal(inputs.length,size);assert.deepEqual(inputs.map(r=>r.chapterId),Array.from({length:size},(_,i)=>`CH-${String(i+1).padStart(6,'0')}`),'spine/global chapter order and no duplicates');
  for(let i=0;i<inputs.length;i++)assert.ok(inputs[i].targetMarkdown.includes(`合成原文第 ${i+1} 章。`),'EPUB spine order and saved original text');
  await sleep(700);assert.equal(f.calls,size+thinkingCalls,'same Revision cannot enqueue twice');
  const status=await f.call('/v1/agent-runtime');for(const kind of ['review','knowledge','creative'])assert.equal(status.executors[kind].executorOwner,'pi');
  f.switchOwner('knowledge','disabled');const pausedCalls=f.calls;await mutate('rebuild',{chapterId:inputs[0].chapterId});await sleep(1200);assert.equal(f.calls,pausedCalls,'disabled Knowledge must remain queued');
  f.switchOwner('knowledge','pi');await until(()=>f.calls===size+1+thinkingCalls,'Pi resume executes rebuilt chapter',30000);await until(async()=>(await f.call(root+'/jobs')).items.some(j=>j.chapterId===inputs[0].chapterId&&j.status==='completed'),'Pi resume domain commit',30000);
  console.log(`PASS: ${size} EPUB chapters imported and analyzed in spine order via Pi; job budget, pause/resume, no duplicates, disabled/resume rebuild. Three processes, synthetic HTTP only.`);
 }finally{await f.close()}
}
