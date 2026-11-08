import type {AgentModelResponse, ThinkingModel} from '@writer-agent/contracts';
import {GatewayError,boundedModelFetch,completionUsage,configuredModel} from './model-gateway.js';

const MAX_INPUT_BYTES=64*1024;
const MAX_RESPONSE_BYTES=256*1024;
const MAX_OUTPUT=2048;

// One bounded, tool-free call for author-initiated utility work. Go has already
// authorized the author and reserved points; this function never retries.
export async function completeOnce(model:ThinkingModel,key:string,request:{system:string;input:string;maxOutputTokens:number},signal:AbortSignal):Promise<AgentModelResponse>{
 const output=Math.min(request.maxOutputTokens,model.limits.maxOutputTokens,MAX_OUTPUT);
 if(output<256)throw new GatewayError('LLM_INVALID_CONFIG');
 const {runtime,model:configured}=await configuredModel(model.endpoint,model.model,key,MAX_INPUT_BYTES+20000,output);
 let usage:AgentModelResponse['usage']=null,transportError='';
 try{
  const result=await runtime.completeSimple(configured,{systemPrompt:request.system,messages:[{role:'user',content:request.input,timestamp:Date.now()}]},{
   maxTokens:output,maxRetries:0,timeoutMs:90_000,
   fetch:boundedModelFetch(model.endpoint,MAX_RESPONSE_BYTES,signal,code=>{transportError=code}),
   async onPayload(value){
    const payload=value as Record<string,unknown>;
    delete payload.max_tokens;delete payload.max_completion_tokens;payload.max_tokens=output;
    delete payload.response_format;payload.response_format={type:'json_object'};
    if(Array.isArray(payload.tools)&&payload.tools.length)throw new GatewayError('LLM_TOOL_OUTPUT_FORBIDDEN');
    if(Buffer.byteLength(JSON.stringify(payload))>MAX_INPUT_BYTES)throw new GatewayError('LLM_CONTEXT_OVERFLOW');
    return payload;
   },
   onProviderStreamEvent(value){const reported=completionUsage(value,output);if(reported)usage=reported},
  });
  signal.throwIfAborted();
  const text=result.content.filter(block=>block.type==='text').map(block=>block.text).join('');
  if(result.content.some(block=>block.type==='toolCall'))throw new GatewayError('LLM_TOOL_OUTPUT_FORBIDDEN');
  if(result.stopReason!=='stop')throw new GatewayError(result.stopReason==='length'?'LLM_INCOMPLETE_OUTPUT':'LLM_INVALID_RESPONSE',{text:'',usage});
  return {text,usage};
 }catch(error){
  if(error instanceof GatewayError)throw error;
  throw new GatewayError(signal.aborted?'LLM_TIMEOUT':transportError||'LLM_INVALID_RESPONSE',{text:'',usage});
 }
}
