import {GatewayError,completeJudgment,executionConfigSchema,type ExecutionConfig} from '../runtime/model-gateway.js';
import {executionContext} from '../runtime/governance/index.js';
import {judgeCase,judgeRubric,calibrate,type HumanAnnotation} from './judge.js';
import type {JudgeDataset} from './judge-dataset.js';

export type LiveJudgeBudget=Readonly<{maxCalls:number;maxReservedTokens:number;reservePerCall:number}>;
export type LiveJudgeSettings=Readonly<{key:string;config:ExecutionConfig;localSynthetic:boolean}>;
export type JudgeCliOptions=Readonly<{annotationsPath?:string;split:'dev'|'held-out';live:boolean;confirmedBudget?:number}>;

export function parseJudgeArguments(raw:string[]):JudgeCliOptions{
 const args=raw.filter(arg=>arg!=='--');
 let annotationsPath:string|undefined,split:'dev'|'held-out'='dev',live=false,confirmedFixtures=false,confirmedBudget:number|undefined;
 for(const arg of args){
  if(arg.startsWith('--annotations=')&&annotationsPath===undefined)annotationsPath=arg.slice('--annotations='.length);
  else if(arg.startsWith('--split=')&&['dev','held-out'].includes(arg.slice(8)))split=arg.slice(8) as 'dev'|'held-out';
  else if(arg==='--live'&&!live)live=true;
  else if(arg==='--confirm-fixtures'&&!confirmedFixtures)confirmedFixtures=true;
  else if(arg.startsWith('--confirm-budget=')&&confirmedBudget===undefined)confirmedBudget=Number(arg.slice('--confirm-budget='.length));
  else throw Error('Only --split, --annotations, --live, --confirm-fixtures and --confirm-budget=<tokens> are supported');
 }
 if(live&&!confirmedFixtures)throw Error('Live Judge requires --confirm-fixtures; only synthetic cases may be sent');
 if(live&&confirmedBudget===undefined)throw Error('Live Judge requires --confirm-budget=<maximum reserved tokens>');
 if(!live&&(confirmedFixtures||confirmedBudget!==undefined))throw Error('Live Judge confirmations are only valid with --live');
 return Object.freeze({...(annotationsPath?{annotationsPath}:{}),split,live,...(confirmedBudget===undefined?{}:{confirmedBudget})});
}

export function liveJudgeSettings(env:NodeJS.ProcessEnv=process.env):LiveJudgeSettings{
 const key=(env.WRITER_AGENT_LLM_API_KEY??'').trim();
 if(!key)throw Error('LIVE_JUDGE_MODEL_KEY_REQUIRED');
 const endpoint=env.WRITER_AGENT_LLM_BASE_URL??'https://api.deepseek.com';
 const url=new URL(endpoint);
 if(url.username||url.password||url.search||url.hash)throw Error('INVALID_LIVE_JUDGE_ENDPOINT');
 const localSynthetic=env.WRITER_AGENT_PI_FIXTURE==='1'&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!localSynthetic)throw Error('LIVE_JUDGE_HTTPS_REQUIRED');
 const output=Number(env.WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS??1024);
 if(!Number.isSafeInteger(output)||output<128||output>2048)throw Error('INVALID_LIVE_JUDGE_OUTPUT');
 const responseFormat=env.WRITER_AGENT_LLM_RESPONSE_FORMAT??'json_object';
 const tokenParameter=env.WRITER_AGENT_LLM_TOKEN_PARAMETER??'max_tokens';
 const config=executionConfigSchema.parse({
  Provider:'openai-compatible',
  BaseURL:url.href.replace(/\/$/,''),
  APIKey:'',
  Model:env.WRITER_AGENT_LLM_MODEL??'deepseek-flash',
  ResponseFormat:responseFormat,
  TokenParameter:tokenParameter,
  Timeout:120_000_000_000,
  MaxContextBytes:64*1024,
  MaxOutputTokens:output,
  MaxResponseBytes:128*1024,
 });
 return {key,config,localSynthetic};
}

export function liveJudgeBudget(maxCalls:number,maxReservedTokens:number):LiveJudgeBudget{
 if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>20)throw Error('INVALID_LIVE_JUDGE_CALL_BUDGET');
 if(!Number.isSafeInteger(maxReservedTokens)||maxReservedTokens<maxCalls*128||maxReservedTokens>2_000_000)throw Error('INVALID_LIVE_JUDGE_TOKEN_BUDGET');
 return Object.freeze({maxCalls,maxReservedTokens,reservePerCall:Math.floor(maxReservedTokens/maxCalls)});
}

/**
 * Runs the same strict Judge contract against an explicitly configured model.
 * Every request reserves from this run's hard cap before its provider send.
 * Unknown usage keeps the full reservation; no failed case is retried.
 */
export async function runJudgeLive(
 dataset:JudgeDataset,
 annotations:HumanAnnotation[],
 signal:AbortSignal,
 settings:LiveJudgeSettings,
 budget:LiveJudgeBudget,
 options?:{deadlineMs?:number},
){
 if(dataset.cases.length>budget.maxCalls)throw Error('LIVE_JUDGE_CALL_BUDGET');
 if(budget.reservePerCall<settings.config.MaxOutputTokens)throw Error('LIVE_JUDGE_RESERVATION_TOO_SMALL');
 const deadlineMs=options?.deadlineMs??120_000;
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<100||deadlineMs>300_000)throw Error('INVALID_LIVE_JUDGE_DEADLINE');
 let reservedCalls=0,exposure=0;
 const traces:{caseId:string;action:string}[]=[],usage:{caseId:string;inputTokens:number|null;outputTokens:number|null}[]=[],judgments=[] as Awaited<ReturnType<typeof judgeCase>>[],failures:{caseId:string;code:string}[]=[];
 for(const value of dataset.cases){
  if(signal.aborted){failures.push({caseId:value.caseId,code:'EVAL_CANCELLED'});break}
  if(reservedCalls>=budget.maxCalls){failures.push({caseId:value.caseId,code:'LIVE_JUDGE_CALL_BUDGET'});break}
  const context=executionContext({
   executionId:value.caseId,
   traceId:value.caseId,
   role:'evaluation.judge',
   authorizationVersion:1,
   scopes:[],
   deadline:Date.now()+deadlineMs,
   signal,
   budget:{maxTokens:budget.reservePerCall,maxModelCalls:1,maxToolCalls:0},
   versions:{prompt:judgeRubric.promptVersion,toolSchema:'none'},
   recordAudit:record=>traces.push({caseId:value.caseId,action:record.action}),
  });
  try{
   judgments.push(await judgeCase(value,async request=>{
    const response=await completeJudgment(settings.config,settings.key,context,{authorize:async()=>signal.throwIfAborted()},{
     reserve:async()=>{
      if(reservedCalls>=budget.maxCalls||exposure+budget.reservePerCall>budget.maxReservedTokens)throw new GatewayError('LIVE_JUDGE_BUDGET');
      reservedCalls++;
      exposure+=budget.reservePerCall;
     },
     settle:async reported=>{
      const measured=reported?reported.inputTokens+reported.outputTokens:null;
      usage.push({caseId:value.caseId,inputTokens:reported?.inputTokens??null,outputTokens:reported?.outputTokens??null});
      exposure+=measured===null?0:measured-budget.reservePerCall;
     },
    },request);
    return response.text;
   }));
  }catch(error){
   const code=error instanceof GatewayError?error.code:signal.aborted?'EVAL_CANCELLED':'JUDGE_EXECUTION_FAILED';
   failures.push({caseId:value.caseId,code});
   break;
  }
 }
 const calibration=failures.length?null:calibrate(judgments,annotations,dataset.version);
 return {
  dataset,
  mode:settings.localSynthetic?'local-http-live-judge':'real-model-judge',
  realLLMCalled:!settings.localSynthetic,
  qualityValidated:false,
  model:settings.config.Model,
  provider:settings.config.Provider,
  budget,
  reservedCalls,
  calls:traces.filter(record=>record.action==='model_started').length,
  tokenExposure:exposure,
  usage,
  traces,
  judgments,
  failures,
  calibration,
 } as const;
}
