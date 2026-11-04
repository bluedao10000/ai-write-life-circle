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
  constructor(readonly config:ExecutionConfig,readonly key:string){}
  validate(task:AgentTask){
    const limit=task.request.outputLimit;
    if(limit!==undefined && (task.kind!=='review.execute'||!Number.isInteger(limit)||limit<128||limit>32768))throw new GatewayError('AGENT_CONFIG_CHANGED');
    if(task.configFingerprint!==executionFingerprint(this.config)||modelIdentity(task.model)!==executionFingerprint(this.config))throw new GatewayError("AGENT_CONFIG_CHANGED");
  }
  async execute(task:AgentTask,signal:AbortSignal):Promise<AgentModelResponse>{
    this.validate(task);
    const output=Math.min(task.request.outputLimit??this.config.MaxOutputTokens,this.config.MaxOutputTokens);
    const cfg=this.config,deadline=AbortSignal.timeout(Math.max(1,Math.min(cfg.Timeout/1e6,Date.parse(task.deadline)-Date.now()))),abort=AbortSignal.any([signal,deadline]);
    const {runtime,model}=await configuredModel(cfg.BaseURL,cfg.Model,this.key,cfg.MaxContextBytes+20000,output);
    let usage:AgentModelResponse['usage']=null,transportError="";
    try {
      const result=await runtime.completeSimple(model,{systemPrompt:task.request.system,messages:[{role:"user",content:task.request.input,timestamp:Date.now()}]},{
        headers:{'X-Client-Request-Id':task.taskId},maxTokens:output,signal:abort,maxRetries:0,timeoutMs:cfg.Timeout/1e6,
        fetch:boundedModelFetch(cfg.BaseURL,cfg.MaxResponseBytes,abort,code=>{transportError=code==="LLM_CONTEXT_OVERFLOW"?"LLM_HTTP_ERROR":code}),
        onPayload(value){
          const payload=value as Record<string,unknown>;
          // Preserve the author-approved structured format and exact Token parameter.
          delete payload.max_tokens;delete payload.max_completion_tokens;payload[cfg.TokenParameter]=output;
          delete payload.response_format;
          if(cfg.ResponseFormat==="json_object")payload.response_format={type:"json_object"};
          if(cfg.ResponseFormat==="json_schema")payload.response_format={type:"json_schema",json_schema:{name:task.request.schemaName||"writing_review",strict:true,schema:task.request.schema}};
          if(Array.isArray(payload.tools)&&payload.tools.length)throw new GatewayError("LLM_TOOL_OUTPUT_FORBIDDEN");
          return payload;
        },
        onProviderStreamEvent(value){
          const reported=completionUsage(value,output);
          if(reported)usage=reported;
        },
      });
      const text=result.content.filter(b=>b.type==="text").map(b=>b.text).join("");
      const response={text,usage};
      if(abort.aborted)throw new GatewayError(deadline.aborted?"LLM_TIMEOUT":"REVIEW_INTERRUPTED",response);
      if(transportError)throw new GatewayError(transportError,response);
      if(result.content.some(b=>b.type==="toolCall"))throw new GatewayError("LLM_TOOL_OUTPUT_FORBIDDEN",response);
      if(result.stopReason!=="stop")throw new GatewayError(result.stopReason==="length"?"LLM_INCOMPLETE_OUTPUT":"LLM_INVALID_RESPONSE",response);
      if(Buffer.byteLength(text)>candidateBytes[task.kind])throw new GatewayError("LLM_RESPONSE_TOO_LARGE",{text:"",usage});
      return response;
    }catch(e){
      if(e instanceof GatewayError)throw e;
      throw new GatewayError(deadline.aborted?"LLM_TIMEOUT":signal.aborted?"REVIEW_INTERRUPTED":transportError||"LLM_INVALID_RESPONSE",{text:"",usage});
    }
  }
}
