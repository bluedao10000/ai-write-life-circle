import type {AgentTask} from '@writer-agent/contracts';

export const runtimeVersion='governance-v1';
export const definitions=Object.freeze({
 'evaluation.judge':{version:1,capability:'evaluation',mode:'evaluation',retry:'explicit',output:'judge-v1',tools:'none',modelCalls:1},
 'memory.extract':{version:1,capability:'memory',mode:'durable',retry:'explicit',output:'memory-candidate-v1',tools:'none',modelCalls:'run-budget'},
 'memory.extract.v2':{version:2,capability:'memory',mode:'durable',retry:'explicit',output:'memory-candidate-v2',tools:'none',modelCalls:'run-budget'},
 'memory.extract.v3':{version:3,capability:'memory',mode:'durable',retry:'explicit',output:'memory-candidate-v3',tools:'none',modelCalls:'run-budget'},
 'memory.consolidate':{version:1,capability:'memory',mode:'go-task',retry:'none',output:'memory-candidate-v1',tools:'none',modelCalls:1},
 thinking:{version:1,capability:'thinking',mode:'durable',retry:'explicit',output:'thinking-v1',tools:'scoped',modelCalls:'run-budget'},
 'thinking.autonomy':{version:1,capability:'thinking',mode:'durable',retry:'explicit',output:'thinking-autonomy-v1',tools:'read-only-planned',modelCalls:'run-budget'},
 'creative.plan.planner':{version:1,capability:'creative',mode:'orchestration',retry:'explicit',output:'creative-plan-planner-v1',tools:'none',modelCalls:1},
 'creative.plan.researcher':{version:1,capability:'creative',mode:'orchestration',retry:'explicit',output:'creative-plan-research-v1',tools:'none',modelCalls:1},
 'creative.plan.analyst':{version:1,capability:'creative',mode:'orchestration',retry:'explicit',output:'creative-plan-analysis-v1',tools:'none',modelCalls:1},
 'creative.plan.critic':{version:1,capability:'creative',mode:'orchestration',retry:'explicit',output:'creative-plan-critique-v1',tools:'none',modelCalls:1},
 'creative.plan.coordinator':{version:1,capability:'creative',mode:'orchestration',retry:'explicit',output:'creative-plan-check-candidates-v2',tools:'none',modelCalls:1},
 'review.execute':{version:1,capability:'review',mode:'go-task',retry:'go',output:'review-candidates-v1',tools:'none',modelCalls:1},
 'knowledge.extract':{version:1,capability:'knowledge',mode:'go-task',retry:'go',output:'knowledge-candidates-v1',tools:'none',modelCalls:1},
 'novel.analyze':{version:1,capability:'analysis',mode:'go-task',retry:'go',output:'novel-analysis-candidates-v1',tools:'none',modelCalls:1},
 'creative.organize':{version:1,capability:'creative',mode:'go-task',retry:'go',output:'creative-organize-candidates-v1',tools:'none',modelCalls:1},
 'creative.plan_check':{version:1,capability:'creative',mode:'go-task',retry:'go',output:'creative-plan_check-candidates-v1',tools:'none',modelCalls:1},
} as const);
export type AgentRole=keyof typeof definitions;
export type ExecutionContext=Readonly<{
 executionId:string;traceId:string;role:AgentRole;authorizationVersion:number;
 versions?:Readonly<{prompt:string;toolSchema:string}>;
 budget?:Readonly<{maxTokens:number;maxModelCalls:number;maxToolCalls:number}>;
 recordAudit?:(record:AuditRecord)=>void;
 sessionId?:string;taskId?:string;parentTaskId?:string;modelRequestId?:string;executorEpoch?:number;scopes:readonly string[];deadline:number;signal:AbortSignal;
}>;
export function definition(role:string){
 if(!Object.hasOwn(definitions,role))throw Error('UNSUPPORTED_TASK_KIND');
 return definitions[role as AgentRole];
}
export function executionContext(value:ExecutionContext):ExecutionContext {
 definition(value.role);
 if(!value.executionId||!value.traceId||!Number.isFinite(value.deadline)||!Number.isSafeInteger(value.authorizationVersion)||value.authorizationVersion<0||value.scopes.some(scope=>!scope)||new Set(value.scopes).size!==value.scopes.length)throw Error('AGENT_CONFIG_CHANGED');
 if(value.budget&&(!Number.isSafeInteger(value.budget.maxTokens)||value.budget.maxTokens<1||!Number.isSafeInteger(value.budget.maxModelCalls)||value.budget.maxModelCalls<1||!Number.isSafeInteger(value.budget.maxToolCalls)||value.budget.maxToolCalls<0))throw Error('AGENT_CONFIG_CHANGED');
 return Object.freeze({...value,...(value.budget?{budget:Object.freeze({...value.budget})}:{}),...(value.versions?{versions:Object.freeze({...value.versions})}:{}),scopes:Object.freeze([...value.scopes])});
}
export function workerContext(task:AgentTask,signal:AbortSignal,options?:{role?:AgentRole;parentTaskId?:string;maxModelCalls?:number;maxTokens?:number}){
 const role=options?.role??task.kind as AgentRole;
 const parent=options?.parentTaskId;
 return executionContext({executionId:parent?`${task.taskId}:${role}`:task.taskId,traceId:task.taskId,taskId:task.taskId,...(parent?{parentTaskId:parent}:{}),role,authorizationVersion:typeof task.consent.authorizationVersion==='number'?task.consent.authorizationVersion:0,executorEpoch:task.executorEpoch,scopes:[],versions:{prompt:task.strategyVersion,toolSchema:task.outputSchemaVersion},budget:{maxTokens:options?.maxTokens??task.reservedTokens,maxModelCalls:options?.maxModelCalls??1,maxToolCalls:0},deadline:Date.parse(task.deadline),signal});
}
/** Derive a delegated execution without creating a second task or budget authority. */
export function childExecutionContext(parent:ExecutionContext,child:ExecutionContext):ExecutionContext {
 const value=executionContext(child),within=(values:readonly string[],allowed:readonly string[])=>values.every(item=>allowed.includes(item));
 if(!parent.taskId||value.taskId!==parent.taskId||value.parentTaskId!==parent.taskId||value.traceId!==parent.traceId||value.executionId===parent.executionId||value.authorizationVersion!==parent.authorizationVersion||value.executorEpoch!==parent.executorEpoch||value.deadline>parent.deadline||!within(value.scopes,parent.scopes)||!parent.budget||!value.budget||value.budget.maxTokens>parent.budget.maxTokens||value.budget.maxModelCalls>parent.budget.maxModelCalls||value.budget.maxToolCalls>parent.budget.maxToolCalls)throw Error('AGENT_CONFIG_CHANGED');
 return value;
}
export function assertCurrent(context:ExecutionContext){
 context.signal.throwIfAborted();
 if(Date.now()>=context.deadline)throw Error('DURATION_EXCEEDED');
}
export type AuditAction='authorized'|'denied'|'reserved'|'model_started'|'model_finished'|'tool_started'|'tool_finished'|'failed';
export type ToolAuditDetails={toolName?:string;durationMs?:number};
export type AuditRecord=ToolAuditDetails&{action:AuditAction;timestamp:string;modelRequestId?:string};
const counts:Partial<Record<`${AgentRole}:${AuditAction}`,number>>={};
/** Only fixed metadata enters logs; payloads, credentials and arbitrary errors are excluded. */
export function audit(context:ExecutionContext,action:AuditAction,details:ToolAuditDetails={}){
 const timing={...(details.toolName?{toolName:details.toolName}:{}),...(typeof details.durationMs==='number'&&Number.isFinite(details.durationMs)&&details.durationMs>=0?{durationMs:details.durationMs}:{})};
 context.recordAudit?.({...timing,action,timestamp:new Date().toISOString(),...(context.modelRequestId?{modelRequestId:context.modelRequestId}:{})});
 const key=`${context.role}:${action}` as const;counts[key]=(counts[key]??0)+1;
 console.log(JSON.stringify({event:'agent_governance',...timing,runtimeVersion,definitionVersion:definition(context.role).version,versions:context.versions,executionId:context.executionId,traceId:context.traceId,taskId:context.taskId,parentTaskId:context.parentTaskId,modelRequestId:context.modelRequestId,executorEpoch:context.executorEpoch,sessionId:context.sessionId,role:context.role,authorizationVersion:context.authorizationVersion,action,timestamp:new Date().toISOString()}));
}
export const governanceMetrics=()=>({...counts});
export interface AuthorizationManager {authorize():Promise<void>}
/** Adapter to the existing Durable checkpoint or Go started receipt, never a second ledger. */
export interface BudgetManager {reserve():Promise<void>}
export class ModelRequestGate {
 private ready=false;
 private preparing=false;
 private sent=false;
 private terminal:'finished'|'failed'|undefined;
 constructor(readonly context:ExecutionContext,readonly authorization:AuthorizationManager){}
 async prepare(budget:BudgetManager){
  if(this.preparing||this.ready||this.sent)throw Error('MODEL_REQUEST_REPLAY');
  this.preparing=true;
  try{assertCurrent(this.context)}catch(error){audit(this.context,'failed');throw error}
  try{await this.authorization.authorize();assertCurrent(this.context)}
  catch(error){audit(this.context,this.context.signal.aborted||Date.now()>=this.context.deadline?'failed':'denied');throw error}
  audit(this.context,'authorized');
  try{await budget.reserve();assertCurrent(this.context);audit(this.context,'reserved');this.ready=true}
  catch(error){audit(this.context,'failed');throw error}
 }
 transport(fetcher:typeof fetch):typeof fetch {
  return async(request,options)=>{
   assertCurrent(this.context);
   if(!this.ready||this.sent)throw Error('MODEL_RESERVATION_REQUIRED');
   const deadline=AbortSignal.timeout(Math.min(2_147_483_647,Math.max(1,Math.ceil(this.context.deadline-Date.now()))));
   const requestSignal=options?.signal??(request instanceof Request?request.signal:undefined);
   const signal=AbortSignal.any([this.context.signal,deadline,...(requestSignal?[requestSignal]:[])]);
   signal.throwIfAborted();
   this.sent=true;audit(this.context,'model_started');
   return fetcher(request,{...options,signal});
  };
 }
 wasSent(){return this.sent}
 finished(){
  if(!this.sent||this.terminal)return;
  this.terminal='finished';
  audit(this.context,'model_finished');
 }
 failed(){
  if((!this.ready&&!this.sent)||this.terminal)return;
  this.terminal='failed';
  audit(this.context,'failed');
 }
}
