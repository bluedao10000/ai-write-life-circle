// Four real processes, isolated synthetic files, loopback HTTP; no production credentials.
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {createServer as httpServer} from 'node:http';
import {writeFile,readFile,rename,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {createReviewFixture,cases} from './review-fixture.mjs';
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(fn,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(40)}throw Error('Timeout: '+label)}
async function free(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
export async function createPiWorkerFixture({chapters=0,executionEnv={}}={}){
 const data=await createReviewFixture();
 if(chapters){await rm(join(data.harness,'manuscript'),{recursive:true});await mkdir(join(data.harness,'manuscript'));for(let i=1;i<=chapters;i++)await writeFile(join(data.harness,'manuscript',`CH-${String(i).padStart(6,'0')}.md`),`# 合成章节 ${i}\nID: CH-${String(i).padStart(6,'0')}\norder: ${i}\n\n合成原文第 ${i} 章。\n`);await fetch(data.origin+'/control',{method:'POST',body:JSON.stringify({mode:'knowledge-empty'})})}
 const taskPort=await free(),piPort=await free(),toolPort=await free();const keys={};for(const name of ['bearer','task','rpc','capability']){keys[name]=randomBytes(32).toString('hex');await writeFile(join(data.directory,name),keys[name],{mode:0o600})}
 const safeEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('WRITER_AGENT_')));
 const baseEnv={...safeEnv,WRITER_AGENT_ENV:'production',WRITER_AGENT_AUTH_MODE:'bearer',WRITER_AGENT_AUTHOR_ID:'fixture-author',WRITER_AGENT_PROJECT_ID:'review-fixture',WRITER_AGENT_API_HOST:'127.0.0.1',WRITER_AGENT_API_PORT:'0',WRITER_AGENT_AUTH_TOKEN_FILE:join(data.directory,'bearer'),WRITER_AGENT_HARNESS_ROOT:data.harness,WRITER_AGENT_STATE_DIR:data.state,
 WRITER_AGENT_LLM_PROVIDER:'openai-compatible',WRITER_AGENT_LLM_BASE_URL:data.origin+'/v1',WRITER_AGENT_LLM_MODEL:'deterministic-test-only',WRITER_AGENT_LLM_API_KEY:'',WRITER_AGENT_LLM_RESPONSE_FORMAT:'none',WRITER_AGENT_LLM_TOKEN_PARAMETER:'max_completion_tokens',WRITER_AGENT_LLM_TIMEOUT_SECONDS:'2',WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS:'2048',WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS:'12000',
 WRITER_AGENT_TASK_INTERNAL_PORT:String(taskPort),WRITER_AGENT_TASK_SERVICE_TOKEN_FILE:join(data.directory,'task'),
 WRITER_AGENT_PI_ORIGIN:`http://127.0.0.1:${piPort}`,WRITER_AGENT_PI_PORT:String(piPort),WRITER_AGENT_PI_INTERNAL_PORT:String(toolPort),WRITER_AGENT_PI_STORY_ORIGIN:`http://127.0.0.1:${toolPort}`,WRITER_AGENT_PI_SERVICE_TOKEN_FILE:join(data.directory,'rpc'),WRITER_AGENT_PI_CAPABILITY_KEY_FILE:join(data.directory,'capability'),WRITER_AGENT_PI_STATE_DIR:join(data.directory,'thinking-state'),WRITER_AGENT_PI_LLM_BASE_URL:data.origin+'/v1',WRITER_AGENT_PI_LLM_MODEL:'deterministic-test-only',WRITER_AGENT_PI_LLM_PROVIDER:'fixture',WRITER_AGENT_PI_LLM_API_KEY:'synthetic-only',WRITER_AGENT_PI_FIXTURE:'1',WRITER_AGENT_PI_MAX_DURATION_MS:'5000',
 WRITER_AGENT_TASK_ORIGIN:`http://127.0.0.1:${taskPort}`,WRITER_AGENT_PI_WORKER_FIXTURE:'1',WRITER_AGENT_PI_WORKER_VERSION:'synthetic-worker'};
 let dropped=0,dropNext=false;
 const proxy=httpServer(async(req,res)=>{try{const chunks=[];for await(const b of req)chunks.push(b);const response=await fetch(`http://127.0.0.1:${taskPort}`+req.url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});const body=Buffer.from(await response.arrayBuffer());if(dropNext&&req.url.endsWith('/complete')&&response.ok){dropNext=false;dropped++;res.destroy();return}res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body)}catch{res.writeHead(502);res.end()}});
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));baseEnv.WRITER_AGENT_TASK_ORIGIN=`http://127.0.0.1:${proxy.address().port}`;
 Object.assign(baseEnv,executionEnv);
 const processes=new Set();let api,origin;
 function start(kind,overrides={}){
  let command,args,env={...baseEnv,...overrides};
  if(kind==='pi'||kind==='pi-worker'){command=process.execPath;args=[new URL(kind==='pi'?'../../apps/agent/dist/main.js':'../../apps/agent/dist/worker/main.js',import.meta.url).pathname];env.WRITER_AGENT_LLM_API_KEY='synthetic-only';if(kind==='pi-worker'){delete env.WRITER_AGENT_STATE_DIR;delete env.WRITER_AGENT_HARNESS_ROOT}}
  else{command=new URL(`../../apps/api-go/dist/writer-agent-${kind}`,import.meta.url).pathname;args=[]}
  const p=spawn(command,args,{env,stdio:['ignore','pipe','pipe']});p.output='';p.stdout.on('data',b=>{p.output+=b});p.stderr.on('data',b=>{p.output+=b});processes.add(p);return p;
 }
 async function stop(p,signal='SIGTERM'){if(!p||p.exitCode!==null||p.signalCode!==null)return;const ended=new Promise(r=>p.once('exit',r));p.kill(signal);const timer=setTimeout(()=>p.kill('SIGKILL'),6000);await ended;clearTimeout(timer);processes.delete(p)}
 async function startAPI(){api=start('api');origin=await until(()=>{if(api.exitCode!==null)throw Error(api.output);return api.output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]},'API listening')}
 async function call(path,{method='GET',body,status=200,key=crypto.randomUUID()}={}){const r=await fetch(origin+path,{method,headers:{authorization:'Bearer '+keys.bearer,...(body instanceof FormData?{}:{'content-type':'application/json'}),'idempotency-key':key},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});const value=r.status===204?null:await r.json();assert.equal(r.status,status,JSON.stringify(value));return value}
 const project='/v1/projects/review-fixture';
 async function enqueue(){const c=await call(project+'/chapters/CH-008');const input={revisionId:c.headRevision.revisionId,contentHash:c.headRevision.contentHash,reviewTypes:['character_consistency']};const plan=await call(project+'/chapters/CH-008/review-preview',{method:'POST',body:input});return call(project+'/chapters/CH-008/reviews',{method:'POST',status:202,body:{...input,consent:{confirmed:true,planHash:plan.planHash}}})}
 const get=id=>call(project+'/reviews/'+id);
 async function complete(id){return until(async()=>{const r=await get(id);if(r.status==='failed')throw Error(r.failureCode);return r.status==='completed'&&r},'review completion')}
 function switchOwner(kind,owner){const r=spawnSync(new URL('../../apps/api-go/dist/writer-agent-control',import.meta.url).pathname,['--state',data.state,'--kind',kind,'--owner',owner,'--wait','25s'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr)}
 async function expire(id){
  const runPath=join(data.state,'review-runs',Buffer.from('review-fixture').toString('base64url')+'.json'),policyPath=join(data.state,'agent-runtime/executors-v1.json'),tasksPath=join(data.state,'agent-runtime/tasks-v1.json');
  const state=JSON.parse(await readFile(runPath,'utf8')),lease=state.runs[id].lease,past=new Date(Date.now()-1000).toISOString();state.runs[id].deadlineAt=past;
  const policy=JSON.parse(await readFile(policyPath,'utf8'));if(policy.kinds.review.leases[lease])policy.kinds.review.leases[lease].deadline=past;
  const tasks=JSON.parse(await readFile(tasksPath,'utf8'));for(const r of Object.values(tasks.tasks))if(r.task.leaseToken===lease)r.task.deadline=past;
  for(const [path,value]of [[runPath,state],[policyPath,policy],[tasksPath,tasks]]){await writeFile(path+'.fixture',JSON.stringify(value));await rename(path+'.fixture',path)}
 }
 async function expireKnowledge(book){
 const jobsPath=join(data.state,'knowledge',Buffer.from(book).toString('base64url'),'index-v1.json');
 const policyPath=join(data.state,'agent-runtime/executors-v1.json'),tasksPath=join(data.state,'agent-runtime/tasks-v1.json');
 const state=JSON.parse(await readFile(jobsPath,'utf8')),past=new Date(Date.now()-1000).toISOString();
 const policy=JSON.parse(await readFile(policyPath,'utf8')),tasks=JSON.parse(await readFile(tasksPath,'utf8'));
 for(const job of state.jobs)if(job.lease){job.deadline=past;if(policy.kinds.knowledge.leases[job.lease])policy.kinds.knowledge.leases[job.lease].deadline=past;for(const r of Object.values(tasks.tasks))if(r.task.leaseToken===job.lease)r.task.deadline=past}
 for(const [path,value]of [[jobsPath,state],[policyPath,policy],[tasksPath,tasks]]){await writeFile(path+'.fixture',JSON.stringify(value));await rename(path+'.fixture',path)}
 }
 try{await startAPI();return{...data,get calls(){return data.calls},cases,env:baseEnv,keys,start,stop,startAPI,call,enqueue,get,complete,switchOwner,expire,expireKnowledge,async rollBudgetDay(book){const path=join(data.state,'knowledge',Buffer.from(book).toString('base64url'),'index-v1.json');const value=JSON.parse(await readFile(path,'utf8'));assert.ok(!value.jobs.some(j=>j.status==='running'));value.budgetDay='2000-01-01';value.budgetTokens=1000000;value.budgetAttempts=20;await writeFile(path+'.fixture',JSON.stringify(value));await rename(path+'.fixture',path)},dropCompletion(){dropNext=true},get dropped(){return dropped},api:()=>api,taskOrigin:`http://127.0.0.1:${taskPort}`,async close(){for(const p of processes){p.kill('SIGCONT');await stop(p)}await new Promise(r=>proxy.close(r));await data.close()}}}catch(e){for(const p of processes)await stop(p);await data.close();throw e}
}
