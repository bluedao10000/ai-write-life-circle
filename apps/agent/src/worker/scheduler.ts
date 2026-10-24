import {randomUUID} from 'node:crypto';
import type {AgentTask} from '@writer-agent/contracts';
import {ModelGateway,GatewayError} from '../runtime/model-gateway.js';
import type {WorkerConfig} from './config.js';
import {TaskClient} from './task-client.js';
import {validateTask,executeTask} from './dispatcher.js';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export class Scheduler {
 readonly active=new Map<string,{abort:AbortController;done:Promise<void>}>();
 private incompatible=false;
 readonly instance=randomUUID();readonly client:TaskClient;readonly gateway:ModelGateway;
 constructor(readonly config:WorkerConfig){this.client=new TaskClient(config,this.instance);this.gateway=new ModelGateway(config.model,config.key)}
 private log(event:string,task?:AgentTask,code?:string){console.log(JSON.stringify({event,taskId:task?.taskId,kind:task?.kind,code}))}
 private async process(task:AgentTask,abort:AbortController){
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  try{
   validateTask(task,this.gateway);
   await this.client.action(task,'started');
   heartbeat=setInterval(()=>{void this.client.action(task,'heartbeat').catch(()=>abort.abort())},1000);
   const response=await executeTask(task,this.gateway,abort.signal);
   await this.client.action(task,'complete',response);
   this.log('task_completed',task);
  }catch(e){
   if(e instanceof Error&&e.message==='AGENT_CONFIG_CHANGED'){this.incompatible=true;this.log('executor_incompatible',task,'AGENT_CONFIG_CHANGED');return}
   let code=e instanceof GatewayError?e.code:(e instanceof Error&&e.message==='UNSUPPORTED_TASK_KIND'?'LLM_INVALID_OUTPUT':'REVIEW_INTERRUPTED');
   if(task.kind==='knowledge.extract'&&code==='REVIEW_INTERRUPTED')code='KNOWLEDGE_INTERRUPTED';
   try{await this.client.action(task,'fail',e instanceof GatewayError?e.response:{text:'',usage:null},code)}catch{/* Fenced/expired outcomes remain Go-owned; never call the model again here. */}
   this.log('task_stopped',task,code);
  }finally{clearInterval(heartbeat)}
 }
 async run(signal:AbortSignal){
  await this.client.check();
  await this.client.report(this.config.version,[],true);
  this.log('worker_started');
  const status=setInterval(()=>{void this.client.report(this.config.version,[...this.active.keys()],!signal.aborted&&!this.incompatible).catch(()=>{for(const a of this.active.values())a.abort.abort()})},1000);
  const cancel=()=>{for(const a of this.active.values())a.abort.abort()};signal.addEventListener('abort',cancel,{once:true});
  try{
   while(!signal.aborted&&!this.incompatible){
    if(this.active.size<this.config.slots){
     try{const task=await this.client.claim();if(task){const abort=new AbortController();const done=Promise.resolve().then(()=>this.process(task,abort)).finally(()=>this.active.delete(task.taskId));this.active.set(task.taskId,{abort,done});continue}}catch(e){if(e instanceof Error&&e.message==='AGENT_CONFIG_CHANGED'){this.incompatible=true;this.log('executor_incompatible',undefined,'AGENT_CONFIG_CHANGED')}else this.log('claim_deferred')}
    }
    await pause(200);
   }
  }finally{
   clearInterval(status);cancel();signal.removeEventListener('abort',cancel);
   await Promise.race([Promise.allSettled([...this.active.values()].map(v=>v.done)),pause(5000)]);
   await this.client.report(this.config.version,[],false).catch(()=>{});this.log('worker_stopped');
  }
  if(this.incompatible)throw Error('AGENT_CONFIG_CHANGED');
 }
}
