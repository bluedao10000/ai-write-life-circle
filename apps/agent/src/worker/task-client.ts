import {candidateBytes} from '../runtime/execution-policy.js';
import {createHash} from 'node:crypto';
import {strategy,systemPrompt} from '../agents/review/prompt.js';
import {strategy as knowledgeStrategy,systemPrompt as knowledgePrompt} from '../agents/knowledge/prompt.js';
import {agentTaskClaimResultSchema,agentTaskAcknowledgementSchema,agentTaskEnvelopeSchema,agentWorkerHeartbeatSchema,type AgentTask,type AgentModelResponse} from '@writer-agent/contracts';
import {boundedText} from '../tools/registry.js';
import type {WorkerConfig} from './config.js';
export const executionContracts={knowledge:'sha256:'+createHash('sha256').update(knowledgeStrategy+'knowledge-candidates-v1'+knowledgePrompt+String(candidateBytes['knowledge.extract'])).digest('hex'),review:'sha256:'+createHash('sha256').update(strategy+'review-candidates-v1'+systemPrompt).digest('hex')};
export class TaskClient {
 constructor(readonly config:WorkerConfig,readonly instance:string){}
 async request(path:string,body?:unknown){
  const r=await fetch(this.config.origin+'/internal/v1/agent/tasks/'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+this.config.token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});
  const value=JSON.parse(await boundedText(r,512*1024)) as Record<string,unknown>;
  if(!r.ok)throw Error(typeof value.code==='string'?value.code:'TASK_TRANSPORT_FAILED');return value;
 }
 async check(){const value=await this.request('capabilities');if(value.protocol!=='agent-tasks-v1'||value.configFingerprint!==JSON.stringify(this.config.model))throw Error('AGENT_CONFIG_CHANGED');const contracts=value.contracts as Record<string,string>|undefined;for(const kind of this.config.kinds){if(contracts?.[kind]!==executionContracts[kind as keyof typeof executionContracts])throw Error('AGENT_CONFIG_CHANGED')}}
 async claim(){return agentTaskClaimResultSchema.parse(await this.request('claim',{instance:this.instance,configFingerprint:JSON.stringify(this.config.model),kinds:this.config.kinds,contracts:executionContracts})).task}
 async action(task:AgentTask,action:'started'|'heartbeat'|'complete'|'fail',response:AgentModelResponse={text:'',usage:null},failureCode?:string){
  const body=agentTaskEnvelopeSchema.parse({leaseToken:task.leaseToken,executorEpoch:task.executorEpoch,attempt:task.attempt,kind:task.kind,inputHash:task.inputHash,instance:this.instance,response,...(failureCode?{failureCode}:{})});
  const retry=action==='complete'||action==='fail'?3:1;
  for(let attempt=0;attempt<retry;attempt++){try{return agentTaskAcknowledgementSchema.parse(await this.request(task.taskId+'/'+action,body))}catch(e){if(attempt+1===retry||e instanceof Error&&e.message==='EXECUTOR_FENCED')throw e;await new Promise(r=>setTimeout(r,100))}}
 }
 async report(version:string,active:string[],ready:boolean){return this.request('worker-heartbeat',agentWorkerHeartbeatSchema.parse({instance:this.instance,version,configFingerprint:JSON.stringify(this.config.model),kinds:this.config.kinds,activeTasks:active,ready}))}
}
