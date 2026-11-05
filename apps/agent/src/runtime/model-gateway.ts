import {ModelRequestGate,workerContext,definition} from './governance/runtime.js';
import type {ExecutionContext,AuthorizationManager,BudgetManager,AgentRole} from './governance/runtime.js';
import {modelIdentity} from "./fingerprint.js";
import {candidateBytes} from "./execution-policy.js";
import { createModels, createProvider, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { z } from "zod";
import type { AgentTask, AgentModelResponse } from "@writer-agent/contracts";

// The same adapter/credential isolation is used by sessions and bounded workflows.
export async function configuredModel(endpoint: string, id: string, key: string, input: number, output: number) {
  const runtime = createModels({credentials:new InMemoryCredentialStore()});
  const model:Model<"openai-completions">={id,name:id,api:"openai-completions",provider:"story2u",baseUrl:endpoint,reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:input,maxTokens:output};
  runtime.setProvider(createProvider({
    id:"story2u",name:"Story2u configured provider",baseUrl:endpoint,models:[model],
    auth:{apiKey:{name:"Story2u API key",resolve:async()=>({auth:{apiKey:key}})}},
    api:openAICompletionsApi(),
  }));
  return {runtime,model};
}
export class GatewayError extends Error {
  constructor(readonly code:string,readonly response:AgentModelResponse={text:"",usage:null}){super(code)}
}
export type ModelStep={
  role:AgentRole;
  system:string;
  input:string;
  schemaName:string;
  schema:Record<string,unknown>;
  maxTokens:number;
  maxOutputTokens:number;
  maxModelCalls:number;
  callIndex:number;
  parentTaskId?:string;
};
export function boundedModelFetch(endpoint:string,maxBytes:number,signal:AbortSignal,onError?:(code:string,status?:number)=>void):typeof fetch {
  return async(request,init)=>{
    const url=new URL(typeof request==="string"?request:request instanceof URL?request.href:request.url);
    const base=new URL(endpoint);
    if(url.origin!==base.origin||url.pathname!==base.pathname.replace(/\/$/,"")+"/chat/completions")throw new GatewayError("LLM_INVALID_CONFIG");
    const requestSignal=init?.signal??(request instanceof Request?request.signal:undefined);
    const abort=requestSignal?AbortSignal.any([signal,requestSignal]):signal;
    let response:Response;
    try{response=await fetch(request,{...init,redirect:"error",signal:abort})}catch(e){onError?.("LLM_NETWORK_ERROR");throw e}
    if(!response.ok)onError?.("LLM_HTTP_ERROR",response.status);
    if(response.status===400 && response.body){
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>Math.min(maxBytes,16384))throw new GatewayError("LLM_RESPONSE_TOO_LARGE");chunks.push(part.value)}}finally{await reader.cancel()}
      const text=Buffer.concat(chunks).toString("utf8");
      if(/context_length_exceeded|maximum context length|context window exceeded/i.test(text))onError?.("LLM_CONTEXT_OVERFLOW",400);
      response=new Response(text,{status:response.status,statusText:response.statusText,headers:response.headers});
    }
    if(!response.body)return response;
    const reader=response.body.getReader();let count=0;
    const body=new ReadableStream<Uint8Array>({async pull(controller){try{const part=await reader.read();if(part.done){controller.close();return}count+=part.value.byteLength;if(count>maxBytes){onError?.("LLM_RESPONSE_TOO_LARGE");await reader.cancel();throw new GatewayError("LLM_RESPONSE_TOO_LARGE")}controller.enqueue(part.value)}catch(e){controller.error(e)}},cancel:()=>reader.cancel()});
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
export const executionConfigSchema=z.object({Provider:z.literal("openai-compatible"),BaseURL:z.string().url(),APIKey:z.literal(""),Model:z.string().min(1),ResponseFormat:z.enum(["none","json_object","json_schema"]),TokenParameter:z.enum(["max_tokens","max_completion_tokens"]),Timeout:z.number().int().positive().max(180_000_000_000),MaxContextBytes:z.number().int().min(2048).max(256*1024),MaxOutputTokens:z.number().int().min(128).max(131072),MaxResponseBytes:z.number().int().min(1024).max(2*1024*1024)}).strict();
export type ExecutionConfig=z.infer<typeof executionConfigSchema>;
export function executionFingerprint(config: ExecutionConfig): string {
  const url = new URL(config.BaseURL);
  const path = config.BaseURL.slice(config.BaseURL.indexOf("://") + 3).includes("/") ? url.pathname : "";
  return modelIdentity({provider: config.Provider, model: config.Model, endpoint: url.origin + path});
}

// prompt_tokens includes cached input. Optional inconsistent cache details never
// earn a discount; missing/invalid total usage remains unknown.
export function completionUsage(value:unknown,maxOutput:number):AgentModelResponse['usage'] {
  const raw=(value as {usage?:{prompt_tokens?:number;completion_tokens?:number;prompt_cache_hit_tokens?:number;prompt_tokens_details?:{cached_tokens?:number}}})?.usage;
  if(!raw||!Number.isInteger(raw.prompt_tokens)||!Number.isInteger(raw.completion_tokens)||raw.prompt_tokens!<0||raw.prompt_tokens!>1000000||raw.completion_tokens!<0||raw.completion_tokens!>maxOutput)return null;
  const hit=raw.prompt_cache_hit_tokens,details=raw.prompt_tokens_details?.cached_tokens;
  const cached=hit??details??0;
  const valid=Number.isInteger(cached)&&cached>=0&&cached<=raw.prompt_tokens!&&(hit===undefined||details===undefined||hit===details);
  return {inputTokens:raw.prompt_tokens!,outputTokens:raw.completion_tokens!,cachedInputTokens:valid?cached:0};
}
export class ModelGateway {
  constructor(readonly config:ExecutionConfig,readonly key:string,readonly admission:(task:AgentTask,step?:ModelStep)=>Promise<void>=async()=>{throw Error('MODEL_RESERVATION_REQUIRED')}){}
  validate(task:AgentTask){
    const output=task.kind==='creative.plan_check'&&task.strategyVersion==='creative-plan-check-readonly-v1'?'creative-plan-check-candidates-v2':definition(task.kind).output;
    if(output!==task.outputSchemaVersion)throw new GatewayError('AGENT_CONFIG_CHANGED');
    const limit=task.request.outputLimit;
    if(limit!==undefined && (task.kind!=='review.execute'||!Number.isInteger(limit)||limit<128||limit>32768))throw new GatewayError('AGENT_CONFIG_CHANGED');
    if(task.configFingerprint!==executionFingerprint(this.config)||modelIdentity(task.model)!==executionFingerprint(this.config))throw new GatewayError("AGENT_CONFIG_CHANGED");
  }
  async execute(task:AgentTask,signal:AbortSignal):Promise<AgentModelResponse>{
    const response=await this.executeStep(task,signal,{role:task.kind,system:task.request.system,input:task.request.input,schemaName:task.request.schemaName||"writing_review",schema:task.request.schema,maxTokens:task.reservedTokens,maxOutputTokens:Math.min(task.request.outputLimit??this.config.MaxOutputTokens,this.config.MaxOutputTokens),maxModelCalls:1,callIndex:1});
    return {text:response.text,usage:response.usage};
  }
  async executeStep(task:AgentTask,signal:AbortSignal,step:ModelStep):Promise<AgentModelResponse>{
    this.validate(task);
    const role=definition(step.role);
    const output=step.maxOutputTokens;
    const orchestration=!!step.parentTaskId;
    if(role.tools!=='none'||(orchestration&&(task.kind!=='creative.plan_check'||role.capability!=='creative'||role.mode!=='orchestration'))||output<128||output>this.config.MaxOutputTokens||!Number.isSafeInteger(step.maxTokens)||step.maxTokens<1||step.maxTokens>task.reservedTokens||!Number.isSafeInteger(step.maxModelCalls)||step.maxModelCalls<1||step.maxModelCalls>5||!Number.isSafeInteger(step.callIndex)||step.callIndex<1||step.callIndex>step.maxModelCalls)throw new GatewayError('AGENT_CONFIG_CHANGED');
    const cfg=this.config,deadline=AbortSignal.timeout(Math.max(1,Math.min(cfg.Timeout/1e6,Date.parse(task.deadline)-Date.now()))),abort=AbortSignal.any([signal,deadline]);
    const {runtime,model}=await configuredModel(cfg.BaseURL,cfg.Model,this.key,cfg.MaxContextBytes+20000,output);
    const thisAdmission=()=>this.admission(task,step);
    const gate=new ModelRequestGate({...workerContext(task,abort,{role:step.role,parentTaskId:step.parentTaskId,maxModelCalls:step.maxModelCalls,maxTokens:step.maxTokens}),modelRequestId:`${task.taskId}:${step.role}:${step.callIndex}`},{authorize:async()=>{this.validate(task)}});
    let usage:AgentModelResponse['usage']=null,transportError="";
    try {
      const result=await runtime.completeSimple(model,{systemPrompt:step.system,messages:[{role:"user",content:step.input,timestamp:Date.now()}]},{
        headers:{'X-Client-Request-Id':task.taskId},maxTokens:output,signal:abort,maxRetries:0,timeoutMs:cfg.Timeout/1e6,
        fetch:gate.transport(boundedModelFetch(cfg.BaseURL,cfg.MaxResponseBytes,abort,code=>{transportError=code==="LLM_CONTEXT_OVERFLOW"?"LLM_HTTP_ERROR":code})),
        async onPayload(value){
          const payload=value as Record<string,unknown>;
          // Preserve the author-approved structured format and exact Token parameter.
          delete payload.max_tokens;delete payload.max_completion_tokens;payload[cfg.TokenParameter]=output;
          delete payload.response_format;
          if(cfg.ResponseFormat==="json_object")payload.response_format={type:"json_object"};
          if(cfg.ResponseFormat==="json_schema")payload.response_format={type:"json_schema",json_schema:{name:step.schemaName,strict:true,schema:step.schema}};
          if(Array.isArray(payload.tools)&&payload.tools.length)throw new GatewayError("LLM_TOOL_OUTPUT_FORBIDDEN");
          if(Buffer.byteLength(JSON.stringify(payload))>cfg.MaxContextBytes)throw new GatewayError("LLM_CONTEXT_OVERFLOW");
          await gate.prepare({reserve:()=>thisAdmission()});
          return payload;
        },
        onProviderStreamEvent(value){
          const reported=completionUsage(value,output);
          if(reported)usage=reported;
        },
      });
      const text=result.content.filter(b=>b.type==="text").map(b=>b.text).join("");
      const response={text,usage,modelCalls:1};
      if(abort.aborted)throw new GatewayError(deadline.aborted?"LLM_TIMEOUT":"REVIEW_INTERRUPTED",response);
      if(transportError)throw new GatewayError(transportError,response);
      if(result.content.some(b=>b.type==="toolCall"))throw new GatewayError("LLM_TOOL_OUTPUT_FORBIDDEN",response);
      if(result.stopReason!=="stop")throw new GatewayError(result.stopReason==="length"?"LLM_INCOMPLETE_OUTPUT":"LLM_INVALID_RESPONSE",response);
      if(Buffer.byteLength(text)>candidateBytes[task.kind])throw new GatewayError("LLM_RESPONSE_TOO_LARGE",{text:"",usage,modelCalls:1});
      gate.finished();
      return response;
    }catch(e){
      gate.failed();
      if(e instanceof GatewayError)throw new GatewayError(e.code,gate.wasSent()&&e.response.modelCalls===undefined?{...e.response,modelCalls:1}:e.response);
      throw new GatewayError(deadline.aborted?"LLM_TIMEOUT":signal.aborted?"REVIEW_INTERRUPTED":transportError||"LLM_INVALID_RESPONSE",{text:"",usage,...(gate.wasSent()?{modelCalls:1}:{})});
    }
  }
}

/** No-tool evaluation calls use the same Pi provider, transport and reservation gate. */
export async function completeJudgment(config:ExecutionConfig,key:string,context:ExecutionContext,authority:AuthorizationManager,budget:BudgetManager & {settle(usage:AgentModelResponse['usage']):Promise<void>},request:{system:string;input:string;schema:Record<string,unknown>}):Promise<AgentModelResponse>{
 const cfg=executionConfigSchema.parse(config);
 if(context.role!=='evaluation.judge'||context.scopes.length||!context.budget||context.budget.maxModelCalls!==1||context.budget.maxToolCalls!==0)throw new GatewayError('AGENT_CONFIG_CHANGED');
 const timeout=AbortSignal.timeout(Math.max(1,Math.min(cfg.Timeout/1e6,context.deadline-Date.now())));
 const signal=AbortSignal.any([context.signal,timeout]);
 const gate=new ModelRequestGate({...context,signal},authority);
 const {runtime,model}=await configuredModel(cfg.BaseURL,cfg.Model,key,cfg.MaxContextBytes+20000,cfg.MaxOutputTokens);
 let usage:AgentModelResponse['usage']=null,reserved=false,transportError='';
 try{
  const result=await runtime.completeSimple(model,{systemPrompt:request.system,messages:[{role:'user',content:request.input,timestamp:Date.now()}]},{signal,maxTokens:cfg.MaxOutputTokens,maxRetries:0,timeoutMs:cfg.Timeout/1e6,
   fetch:gate.transport(boundedModelFetch(cfg.BaseURL,cfg.MaxResponseBytes,signal,code=>{transportError=code})),
   async onPayload(value){
    const payload=value as Record<string,unknown>;
    delete payload.max_tokens;delete payload.max_completion_tokens;payload[cfg.TokenParameter]=cfg.MaxOutputTokens;
    payload.response_format={type:'json_schema',json_schema:{name:'agent_judgment',strict:true,schema:request.schema}};
    if(Array.isArray(payload.tools)&&payload.tools.length)throw new GatewayError('LLM_TOOL_OUTPUT_FORBIDDEN');
    const bytes=Buffer.byteLength(JSON.stringify(payload));
    if(bytes>cfg.MaxContextBytes||bytes+cfg.MaxOutputTokens>context.budget!.maxTokens)throw new GatewayError('LLM_CONTEXT_OVERFLOW');
    await gate.prepare({reserve:async()=>{await budget.reserve();reserved=true}});return payload;
   },
   onProviderStreamEvent(value){const reported=completionUsage(value,cfg.MaxOutputTokens);if(reported)usage=reported},
  });
  signal.throwIfAborted();
  const response:AgentModelResponse={text:result.content.filter(b=>b.type==='text').map(b=>b.text).join(''),usage};
  if(response.usage&&response.usage.inputTokens+response.usage.outputTokens>context.budget.maxTokens)throw new GatewayError('LLM_BUDGET_EXCEEDED',response);
  if(transportError)throw new GatewayError(transportError,response);
  if(result.content.some(b=>b.type==='toolCall'))throw new GatewayError('LLM_TOOL_OUTPUT_FORBIDDEN',response);
  if(result.stopReason!=='stop')throw new GatewayError('LLM_INCOMPLETE_OUTPUT',response);
  gate.finished();return response;
 }catch(error){
  gate.failed();
  if(error instanceof GatewayError)throw error;
  throw new GatewayError(signal.aborted?'LLM_TIMEOUT':transportError||'LLM_INVALID_RESPONSE',{text:'',usage});
 }finally{if(reserved)await budget.settle(usage)}
}
