// Explicit, bounded real-model evaluation using only disposable synthetic material.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createPiWorkerFixture,sleep} from './lib/pi-worker-fixture.mjs';
import {loadWorkerConfig} from '../apps/agent/dist/worker/config.js';
import {TaskClient} from '../apps/agent/dist/worker/task-client.js';
import {ModelGateway,GatewayError} from '../apps/agent/dist/runtime/model-gateway.js';
import {validateTask,executeTask} from '../apps/agent/dist/worker/dispatcher.js';
import {authorize,reserve,maxCalls,maxReservedTokens} from './lib/pi-eval-policy.mjs';
const kind=process.argv.includes('--knowledge')?'knowledge':'review';
const {key,endpoint}=authorize(process.argv,process.env);
const executionEnv={WRITER_AGENT_LLM_BASE_URL:endpoint,WRITER_AGENT_LLM_MODEL:process.env.WRITER_AGENT_LLM_MODEL??'deepseek-flash',WRITER_AGENT_LLM_RESPONSE_FORMAT:process.env.WRITER_AGENT_LLM_RESPONSE_FORMAT??'json_object',WRITER_AGENT_LLM_TOKEN_PARAMETER:process.env.WRITER_AGENT_LLM_TOKEN_PARAMETER??'max_tokens',WRITER_AGENT_LLM_TIMEOUT_SECONDS:'180',WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS:'2048'};
const f=await createPiWorkerFixture({executionEnv});const budget={calls:0,reserved:0};const results=[];
try{
 f.switchOwner(kind,'pi');
 const cfg=loadWorkerConfig({...f.env,WRITER_AGENT_LLM_API_KEY:key});const client=new TaskClient(cfg,crypto.randomUUID()),gateway=new ModelGateway(cfg.model,key);await client.check();
 let reviewRun;
 if(kind==='review')reviewRun=await f.enqueue();else{const root='/v1/studio/books/review-fixture/knowledge';const v=await f.call(root);await f.call(root+'/enable',{method:'POST',body:{baseVersion:v.version,consent:true,model:v.model,dailyTokenBudget:100000,dailyJobBudget:2}})}
 // Hard limits: <=2 calls, <=100,000 conservative reserved tokens; one call per claimed task.
 while(budget.calls<maxCalls){
  let task;const untilAt=Date.now()+10000;while(Date.now()<untilAt&&!task){task=await client.claim();if(!task)await sleep(200)}if(!task)break;
  validateTask(task,gateway);if(budget.reserved+task.reservedTokens>maxReservedTokens)throw Error('Synthetic Eval token cap reached before model send');
  reserve(budget,task.reservedTokens);await client.action(task,'started');
  let response;try{response=await executeTask(task,gateway,AbortSignal.timeout(180000));await client.action(task,'complete',response);results.push({taskId:task.taskId,kind:task.kind,response})}catch(e){const code=e instanceof GatewayError?e.code:'LLM_INVALID_OUTPUT';await client.action(task,'fail',e instanceof GatewayError?e.response:{text:'',usage:null},code);results.push({taskId:task.taskId,kind:task.kind,failureCode:code})}
  if(kind==='review')break;
 }
 assert.ok(budget.calls>0,'No authorized synthetic task executed');
 for(const result of results){if(kind==='review'){const r=await f.get(reviewRun.runId);result.domainStatus=r.status;result.domainFailureCode=r.failureCode;result.rejectedCount=r.rejectedCount}else{const jobs=await f.call('/v1/studio/books/review-fixture/knowledge/jobs');result.domainJobs=jobs.items.map(j=>({chapterId:j.chapterId,status:j.status,failureCode:j.failureCode}))}}
 const report={mode:'real-model-synthetic-pi-eval',model:cfg.model.Model,endpoint:cfg.model.BaseURL,calls:budget.calls,reservedTokens:budget.reserved,maxCalls,maxReservedTokens,qualityValidated:false,results};
 const output=process.env.WRITER_AGENT_PI_EVAL_OUTPUT;if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({...report,results:results.map(r=>({taskId:r.taskId,kind:r.kind,failureCode:r.failureCode,domainStatus:r.domainStatus,domainFailureCode:r.domainFailureCode,domainJobs:r.domainJobs,rejectedCount:r.rejectedCount,usage:r.response?.usage}))},null,2));
}finally{await f.close()}
