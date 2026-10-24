/** Same-machine baseline, sequential requests, no speed target or correctness shortcuts. */
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir,platform,arch,cpus} from 'node:os'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('..',import.meta.url))
const temp=await mkdtemp(join(tmpdir(),'writer-api-bench-'))
const harness=join(temp,'harness');await mkdir(join(harness,'manuscript'),{recursive:true})
await writeFile(join(harness,'manuscript/CH-001.md'),'# Benchmark fixture\nID: CH-001\n\n'+('Benchmark data 😀.\n\n'.repeat(100)))
const count=30
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(p*a.length))]
const summary=a=>({medianMs:+percentile(a,.5).toFixed(3),p95Ms:+percentile(a,.95).toFixed(3)})
const processes=[]
async function start(state){const started=performance.now();const entry=[join(root,'apps/api-go/dist/writer-agent-api'),[]];const child=spawn(...entry,{cwd:root,env:{...process.env,NODE_ENV:'development',WRITER_AGENT_ENV:'development',WRITER_AGENT_API_PORT:'0',WRITER_AGENT_PROJECT_ID:'perf',WRITER_AGENT_HARNESS_ROOT:harness,WRITER_AGENT_STATE_DIR:state},stdio:['ignore','pipe','pipe']});processes.push(child);const base=await new Promise((res,rej)=>{let output='';const timer=setTimeout(()=>rej(new Error(output)),15000);child.stdout.on('data',c=>{output+=c;const match=output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);res(match[1])}});child.stderr.on('data',c=>output+=c);child.on('error',rej);child.once('exit',code=>{clearTimeout(timer);rej(new Error(`startup ${code}: ${output}`))})});return{child,base,startMs:performance.now()-started}}
async function stop(child){if(child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done}
async function json(base,path,method='GET',body,key){const response=await fetch(base+'/v1/projects/perf'+path,{method,headers:{'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()}}
const results={}
try{const kind='go';{const starts=[];for(let i=0;i<3;i++){const proc=await start(join(temp,kind+'-cold-'+i));starts.push(proc.startMs);await stop(proc.child)}const {child,base}=await start(join(temp,kind+'-state'));await json(base,'/notes','POST',{content:'Benchmark note'},'note')
 const latency={};for(const [name,path] of Object.entries({chapterList:'/chapters',chapterDetail:'/chapters/CH-001',notes:'/notes'})){for(let i=0;i<5;i++)await json(base,path);const times=[];for(let i=0;i<count;i++){const at=performance.now();assert.equal((await json(base,path)).status,200);times.push(performance.now()-at)}latency[name]=summary(times)}
 let head=(await json(base,'/chapters/CH-001')).body.headRevision.revisionId;const times=[];for(let i=0;i<count;i++){const at=performance.now();const response=await json(base,'/chapters/CH-001/revisions','POST',{baseRevisionId:head,markdown:'Benchmark draft '+i},'write-'+i);assert.equal(response.status,201);head=response.body.revisionId;times.push(performance.now()-at)}latency.save=summary(times)
 const races=await Promise.all(Array.from({length:8},(_,i)=>json(base,'/chapters/CH-001/revisions','POST',{baseRevisionId:head,markdown:'Concurrent '+i},'parallel-'+i)));assert.equal(races.filter(r=>r.status===201).length,1);assert.equal(races.filter(r=>r.status===409).length,7)
 const rss=Number(spawnSync('ps',['-o','rss=','-p',String(child.pid)],{encoding:'utf8'}).stdout.trim())*1024
 results[kind]={coldProcessStart:summary(starts),rssMiB:+(rss/1024/1024).toFixed(2),latency,concurrency:{requests:8,created:1,conflicts:7}};await stop(child)}
 const report={measuredAt:new Date().toISOString(),environment:{platform:platform(),arch:arch(),cpu:cpus()[0].model,node:process.version,go:spawnSync('go',['version'],{cwd:join(root,'apps/api-go'),encoding:'utf8'}).stdout.trim()},method:{requestsPerOperation:count,startSamples:3,concurrencyForLatency:1,notes:'Fresh processes, warm OS filesystem cache possible; loopback HTTP, same fixture and filesystem. Go fsyncs data/audit before acknowledgement. RSS is a post-workload sample, not peak memory.'},results}
 console.log(JSON.stringify(report,null,2));if(process.argv.includes('--write-report'))await writeFile(join(root,'apps/api-go/benchmark-report.json'),JSON.stringify(report,null,2)+'\n')
}finally{for(const child of processes)await stop(child);await rm(temp,{recursive:true,force:true})}
