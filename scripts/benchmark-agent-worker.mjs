import assert from 'node:assert/strict';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {cpus,platform,arch} from 'node:os';
import {createPiWorkerFixture,until} from './lib/pi-worker-fixture.mjs';
import {importSyntheticEpub} from './lib/epub-bulk-fixture.mjs';
import {runtimeVersion} from '../apps/agent/dist/runtime/governance/runtime.js';
import {percentile} from '../apps/agent/dist/evaluation/metrics.js';

const booksPerRun=2,chaptersPerBook=6,rounds=3,tasksPerRun=booksPerRun*chaptersPerBook;
async function measure(workers,round){
 const f=await createPiWorkerFixture({modelBudget:{maxModelCalls:tasksPerRun,maxTokens:tasksPerRun*40000},executionEnv:{WRITER_AGENT_PI_WORKER_MAX_CONCURRENT:'1'}});
 try{
  await fetch(f.origin+'/control',{method:'POST',body:JSON.stringify({mode:'knowledge-empty'})});
  const books=[];
  for(let i=0;i<booksPerRun;i++){
   const book=await importSyntheticEpub(f,chaptersPerBook),base='/v1/studio/books/'+book.bookId;
   await f.call(base+'/creative/settings/pause',{method:'POST',body:{}});
   const view=await f.call(base+'/knowledge');
   await f.call(base+'/knowledge/pause',{method:'POST',body:{baseVersion:view.version}});
   books.push({book,base});
  }
  const processes=Array.from({length:workers},()=>f.start('pi-worker'));
  await until(()=>processes.every(child=>{if(child.exitCode!==null)throw Error('Worker exited before benchmark');return child.output.includes('worker_started')}),'worker startup');
  assert.equal(f.calls,0,'paused setup must not execute models');
  const start=performance.now(),startedAt=Date.now();
  for(const {base} of books){
   const view=await f.call(base+'/knowledge');
   await f.call(base+'/knowledge/enable',{method:'POST',body:{baseVersion:view.version,consent:true,model:view.model,dailyTokenBudget:tasksPerRun*40000,dailyJobBudget:chaptersPerBook}});
  }
  const completed=await until(async()=>{
   const result=[];
   for(const {base,book} of books){
    const jobs=(await f.call(base+'/knowledge/jobs')).items;
    assert(!jobs.some(job=>job.status==='failed'),'benchmark task failed');
    const receipts=(await f.call(base+'/procedural-memory/evidence')).items;
    if(jobs.filter(job=>job.status==='completed').length!==chaptersPerBook||receipts.length!==chaptersPerBook)return false;
    result.push({book,base,jobs,receipts});
   }
   return result;
  },'all domain completions and task receipts',120000);
  const elapsedMs=performance.now()-start;
  const jobs=completed.flatMap(item=>item.jobs),receipts=completed.flatMap(item=>item.receipts);
  assert.equal(jobs.length,tasksPerRun);assert.equal(f.calls,tasksPerRun,'one provider call per completed task');
  assert.equal(new Set(receipts.map(item=>item.taskId)).size,tasksPerRun,'unique task receipts');
  for(const {book,jobs,base} of completed){
   assert.deepEqual(jobs.map(job=>job.chapterId).sort(),book.chapters.map(chapter=>chapter.chapterId).sort(),'all expected chapters exactly once');
   assert.equal((await f.call(base+'/creative/assets')).total,0,'benchmark must not create Canon');
  }
  assert(jobs.every(job=>job.usage&&!job.usageIncomplete),'usage must be measured');
  const completionLatencyMs=receipts.map(receipt=>Date.parse(receipt.completedAt)-startedAt);
  assert(completionLatencyMs.every(ms=>Number.isFinite(ms)&&ms>=0),'valid completion timestamps');
  const inputTokens=jobs.reduce((sum,job)=>sum+job.usage.inputTokens,0),outputTokens=jobs.reduce((sum,job)=>sum+job.usage.outputTokens,0);
  return {round,workers,slotsPerWorker:1,completedTasks:jobs.length,modelCalls:f.calls,extraModelCalls:f.calls-jobs.length,inputTokens,outputTokens,chargedTokens:inputTokens+outputTokens,elapsedMs,tasksPerSecond:jobs.length/(elapsedMs/1000),completionLatencyMs,completionP50Ms:percentile(completionLatencyMs,.5),completionP95Ms:percentile(completionLatencyMs,.95),strategyVersions:[...new Set(jobs.map(job=>job.strategyVersion))]};
 }finally{await f.close()}
}
const results=[];
for(let round=1;round<=rounds;round++){
 // Alternate ordering to avoid assigning all earlier runs to one configuration.
 for(const workers of round%2?[1,2]:[2,1]){
  const result=await measure(workers,round);results.push(result);
  console.log(JSON.stringify({round,workers,completedTasks:result.completedTasks,elapsedMs:Math.round(result.elapsedMs),extraModelCalls:result.extraModelCalls}));
 }
}
const configurations=[1,2].map(workers=>{
 const samples=results.filter(result=>result.workers===workers),tasks=samples.reduce((n,r)=>n+r.completedTasks,0),elapsedMs=samples.reduce((n,r)=>n+r.elapsedMs,0),latencies=samples.flatMap(result=>result.completionLatencyMs);
 return {workers,slotsPerWorker:1,runs:samples.length,completedTasks:tasks,tasksPerSecond:tasks/(elapsedMs/1000),completionP50Ms:percentile(latencies,.5),completionP95Ms:percentile(latencies,.95),modelCalls:samples.reduce((n,r)=>n+r.modelCalls,0),extraModelCalls:samples.reduce((n,r)=>n+r.extraModelCalls,0),chargedTokens:samples.reduce((n,r)=>n+r.chargedTokens,0)};
});
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const report={schemaVersion:1,runtimeVersion,benchmarkVersion:'worker-throughput-v1',at:new Date().toISOString(),commit:git('rev-parse','HEAD'),dirty:git('status','--porcelain').split('\n').some(line=>line&&!line.endsWith('artifacts/')),environment:{node:process.version,go:execFileSync('go',['version'],{cwd:new URL('../apps/api-go/',import.meta.url),encoding:'utf8'}).trim(),platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCPUs:cpus().length},workload:{booksPerRun,chaptersPerBook,rounds,provider:'local-synthetic-http',providerMode:'knowledge-empty',realLLMCalled:false,qualityValidated:false,completionLatency:'Go task receipt completedAt minus batch enable start; includes queueing',elapsed:'batch enable start through observation of all Go task receipts; excludes import and worker startup'},configurations,results};
const directory=new URL('../.local/benchmarks/',import.meta.url),output=new URL('agent-worker.json',directory);
await mkdir(directory,{recursive:true});await writeFile(new URL('agent-worker.json.tmp',directory),JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(new URL('agent-worker.json.tmp',directory),output);
console.log(JSON.stringify({report:output.pathname,configurations}));
