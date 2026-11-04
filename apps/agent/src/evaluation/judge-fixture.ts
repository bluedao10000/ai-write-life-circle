import {createServer} from 'node:http';
import {completeJudgment,executionConfigSchema} from '../runtime/model-gateway.js';
import {executionContext} from '../runtime/governance/index.js';
import {judgeCase,calibrate,type JudgeCase,type HumanAnnotation} from './judge.js';

export const judgeDatasetVersion='judge-engineering-dev-v1';
/** Local synthetic transport for validating governance and scoring, not model quality. */
export async function runJudgeFixture(cases:JudgeCase[],annotations:HumanAnnotation[],signal:AbortSignal){
 const limits={maxCalls:10,maxTokens:100000,reservePerCall:10000};
 if(cases.length>limits.maxCalls)throw Error('EVAL_MODEL_BUDGET');
 let calls=0,reservedCalls=0,exposure=0;
 const traces:{caseId:string;action:string}[]=[],usage:{caseId:string;inputTokens:number|null;outputTokens:number|null}[]=[];
 const server=createServer(async(request,response)=>{
  for await(const chunk of request){void chunk}
  calls++;
  // The fixture never inspects candidate instructions to select its score.
  const content=JSON.stringify(currentMode==='pointwise'?{mode:'pointwise',rubricVersion:'writing-judge-v1',scores:{adherence:3,evidence:3,clarity:3},rationale:'Synthetic score for engineering validation.'}:{mode:'pairwise',rubricVersion:'writing-judge-v1',winner:'A',rationale:'Synthetic first-position preference.'});
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.end('data: '+JSON.stringify({id:'judge-fixture',object:'chat.completion.chunk',model:'judge-fixture',choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:60}})+'\n\ndata: [DONE]\n\n');
 });
 let currentMode:'pointwise'|'pairwise'='pointwise';
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('EVAL_SERVER');
 const config=executionConfigSchema.parse({Provider:'openai-compatible',BaseURL:`http://127.0.0.1:${address.port}`,APIKey:'',Model:'judge-fixture',ResponseFormat:'json_schema',TokenParameter:'max_tokens',Timeout:10e9,MaxContextBytes:8192,MaxOutputTokens:512,MaxResponseBytes:65536});
 const judgments=[],failures:{caseId:string;code:string}[]=[];
 try{
  for(const value of cases){
   if(signal.aborted){failures.push({caseId:value.caseId,code:'EVAL_CANCELLED'});break}currentMode=value.mode;
   const context=executionContext({executionId:value.caseId,traceId:value.caseId,role:'evaluation.judge',authorizationVersion:1,scopes:[],deadline:Date.now()+10000,signal,budget:{maxTokens:limits.reservePerCall,maxModelCalls:1,maxToolCalls:0},versions:{prompt:'judge-prompt-v1',toolSchema:'none'},recordAudit:record=>traces.push({caseId:value.caseId,action:record.action})});
   try{judgments.push(await judgeCase(value,async request=>{
    const response=await completeJudgment(config,'synthetic-only',context,{authorize:async()=>{signal.throwIfAborted()}},{
     reserve:async()=>{if(reservedCalls>=limits.maxCalls||exposure+limits.reservePerCall>limits.maxTokens)throw Error('EVAL_MODEL_BUDGET');reservedCalls++;exposure+=limits.reservePerCall},
     settle:async reported=>{usage.push({caseId:value.caseId,inputTokens:reported?.inputTokens??null,outputTokens:reported?.outputTokens??null});if(reported)exposure+=reported.inputTokens+reported.outputTokens-limits.reservePerCall},
    },request);
    return response.text;
   }));}catch{failures.push({caseId:value.caseId,code:signal.aborted?'EVAL_CANCELLED':'JUDGE_EXECUTION_FAILED'});if(signal.aborted)break}
  }
  return {datasetVersion:judgeDatasetVersion,mode:'synthetic-judge-engineering',realLLMCalled:false,qualityValidated:false,limits,calls,tokenExposure:exposure,usage,traces,judgments,failures,calibration:failures.length?null:calibrate(judgments,annotations,judgeDatasetVersion)};
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
}
