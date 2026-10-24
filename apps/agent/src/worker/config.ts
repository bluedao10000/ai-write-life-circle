import { readFileSync } from "node:fs";
import { credential,privateOrigin } from "../config.js";
import { executionConfigSchema } from "../runtime/model-gateway.js";
export function loadWorkerConfig(env:NodeJS.ProcessEnv=process.env){
 const value=(suffix:string,fallback?:string)=>env['WRITER_AGENT_PI_WORKER_LLM_'+suffix]??env['WRITER_AGENT_LLM_'+suffix]??fallback;
 const key=value('API_KEY',"")!,base=value('BASE_URL','https://api.deepseek.com')!;
 const url=new URL(base);
 if(url.username||url.password||url.search||url.hash||(url.protocol!=="https:"&&!(env.WRITER_AGENT_PI_WORKER_FIXTURE==="1"&&url.protocol==="http:"&&url.hostname==="127.0.0.1")))throw Error("INVALID_MODEL_ENDPOINT");
 if(!key)throw Error("MODEL_KEY_REQUIRED");
 const deep=['https://api.deepseek.com','https://api.deepseek.com/v1'].includes(base.replace(/\/+$/,""));
 const model=executionConfigSchema.parse({Provider:value('PROVIDER','openai-compatible'),BaseURL:base,APIKey:"",Model:value('MODEL',deep?'deepseek-flash':undefined),ResponseFormat:value('RESPONSE_FORMAT',deep?'json_object':'none'),TokenParameter:value('TOKEN_PARAMETER',deep?'max_tokens':'max_completion_tokens'),Timeout:Number(value('TIMEOUT_SECONDS',deep?'180':'60'))*1e9,MaxContextBytes:Number(env.WRITER_AGENT_PI_WORKER_MAX_CONTEXT_BYTES??env.WRITER_AGENT_LLM_MAX_CONTEXT_BYTES??env.WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS??65536),MaxOutputTokens:Number(value('MAX_OUTPUT_TOKENS',deep?'131072':'2048')),MaxResponseBytes:1024*1024});
 const slots=Number(env.WRITER_AGENT_PI_WORKER_MAX_CONCURRENT??2);
 if(!Number.isInteger(slots)||slots<1||slots>2)throw Error("INVALID_WORKER_CONCURRENCY");
 let version='development';try{version=(JSON.parse(readFileSync(new URL('../../release.json',import.meta.url),'utf8')) as {revision:string}).revision}catch{version=env.WRITER_AGENT_PI_WORKER_VERSION??version}
 return {origin:privateOrigin(env.WRITER_AGENT_TASK_ORIGIN??'http://127.0.0.1:8792'),token:credential(env.WRITER_AGENT_TASK_SERVICE_TOKEN_FILE??''),key,model,slots,version,kinds:['review','knowledge'] as ('review'|'knowledge')[]};
}
export type WorkerConfig=ReturnType<typeof loadWorkerConfig>;
