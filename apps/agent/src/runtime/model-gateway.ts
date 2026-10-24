import {candidateBytes} from "./execution-policy.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AgentTask, AgentModelResponse } from "@writer-agent/contracts";

// The same adapter/credential isolation is used by sessions and bounded workflows.
export async function configuredModel(endpoint: string, id: string, key: string, input: number, output: number) {
  const runtime = await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  runtime.registerProvider("story2u",{name:"Story2u configured provider",baseUrl:endpoint,api:"openai-completions",models:[{id,name:id,reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:input,maxTokens:output}]});
  await runtime.setRuntimeApiKey("story2u",key);
  const model=runtime.getModel("story2u",id);
  if(!model)throw Error("MODEL_UNAVAILABLE");
  return {runtime,model};
}
export class GatewayError extends Error {
  constructor(readonly code:string,readonly response:AgentModelResponse={text:"",usage:null}){super(code)}
}
export function boundedModelFetch(endpoint:string,maxBytes:number,signal:AbortSignal,onError?:(code:string)=>void):typeof fetch {
  return async(request,init)=>{
    const url=new URL(typeof request==="string"?request:request instanceof URL?request.href:request.url);
    const base=new URL(endpoint);
    if(url.origin!==base.origin||url.pathname!==base.pathname.replace(/\/$/,"")+"/chat/completions")throw new GatewayError("LLM_INVALID_CONFIG");
    let response:Response;
    try{response=await fetch(request,{...init,redirect:"error",signal})}catch(e){onError?.("LLM_NETWORK_ERROR");throw e}
    if(!response.ok)onError?.("LLM_HTTP_ERROR");
    if(!response.body)return response;
    const reader=response.body.getReader();let count=0;
    const body=new ReadableStream<Uint8Array>({async pull(controller){try{const part=await reader.read();if(part.done){controller.close();return}count+=part.value.byteLength;if(count>maxBytes){onError?.("LLM_RESPONSE_TOO_LARGE");await reader.cancel();throw new GatewayError("LLM_RESPONSE_TOO_LARGE")}controller.enqueue(part.value)}catch(e){controller.error(e)}},cancel:()=>reader.cancel()});
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
export const executionConfigSchema=z.object({Provider:z.literal("openai-compatible"),BaseURL:z.string().url(),APIKey:z.literal(""),Model:z.string().min(1),ResponseFormat:z.enum(["none","json_object","json_schema"]),TokenParameter:z.enum(["max_tokens","max_completion_tokens"]),Timeout:z.number().int().positive().max(180_000_000_000),MaxContextBytes:z.number().int().min(2048).max(256*1024),MaxOutputTokens:z.number().int().min(128).max(131072),MaxResponseBytes:z.number().int().min(1024).max(2*1024*1024)}).strict();
export type ExecutionConfig=z.infer<typeof executionConfigSchema>;
export class ModelGateway {
  constructor(readonly config:ExecutionConfig,readonly key:string){}
  validate(task:AgentTask){
    const received=executionConfigSchema.parse(JSON.parse(task.configFingerprint));
    if(JSON.stringify(received)!==JSON.stringify(this.config)||task.model.provider!==this.config.Provider||task.model.model!==this.config.Model||task.model.endpoint!==this.config.BaseURL)throw new GatewayError("AGENT_CONFIG_CHANGED");
  }
  async execute(task:AgentTask,signal:AbortSignal):Promise<AgentModelResponse>{
    this.validate(task);
    const cfg=this.config,deadline=AbortSignal.timeout(Math.max(1,Math.min(cfg.Timeout/1e6,Date.parse(task.deadline)-Date.now()))),abort=AbortSignal.any([signal,deadline]);
    const {runtime,model}=await configuredModel(cfg.BaseURL,cfg.Model,this.key,cfg.MaxContextBytes+20000,cfg.MaxOutputTokens);
    let usage:AgentModelResponse['usage']=null,transportError="";
    try {
      const result=await runtime.completeSimple(model,{systemPrompt:task.request.system,messages:[{role:"user",content:task.request.input,timestamp:Date.now()}]},{
        headers:{'X-Client-Request-Id':task.taskId},maxTokens:cfg.MaxOutputTokens,signal:abort,maxRetries:0,timeoutMs:cfg.Timeout/1e6,
        fetch:boundedModelFetch(cfg.BaseURL,cfg.MaxResponseBytes,abort,code=>{transportError=code}),
        onPayload(value){
          const payload=value as Record<string,unknown>;
          // Preserve the author-approved structured format and exact Token parameter.
          delete payload.max_tokens;delete payload.max_completion_tokens;payload[cfg.TokenParameter]=cfg.MaxOutputTokens;
          delete payload.response_format;
          if(cfg.ResponseFormat==="json_object")payload.response_format={type:"json_object"};
          if(cfg.ResponseFormat==="json_schema")payload.response_format={type:"json_schema",json_schema:{name:task.request.schemaName||"writing_review",strict:true,schema:task.request.schema}};
          if(Array.isArray(payload.tools)&&payload.tools.length)throw new GatewayError("LLM_TOOL_OUTPUT_FORBIDDEN");
          return payload;
        },
        onProviderStreamEvent(value){
          const raw=(value as {usage?:{prompt_tokens?:number;completion_tokens?:number}}).usage;
          if(raw&&Number.isInteger(raw.prompt_tokens)&&Number.isInteger(raw.completion_tokens)&&raw.prompt_tokens!>=0&&raw.prompt_tokens!<=1000000&&raw.completion_tokens!>=0&&raw.completion_tokens!<=cfg.MaxOutputTokens)usage={inputTokens:raw.prompt_tokens!,outputTokens:raw.completion_tokens!};
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
