import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {judgeCase,calibrate,type JudgeCase,type HumanAnnotation} from '../src/evaluation/judge.js';
import {assertIndependentJudgeDatasets,loadJudgeDataset,parseJudgeDataset,type JudgeDataset} from '../src/evaluation/judge-dataset.js';
import {runJudgeFixture} from '../src/evaluation/judge-fixture.js';
import {completeJudgment,executionConfigSchema} from '../src/runtime/model-gateway.js';
import {executionContext} from '../src/runtime/governance/index.js';
const fixture=(name:string)=>fileURLToPath(new URL(`../src/evaluation/fixtures/${name}.json`,import.meta.url));
const dev=loadJudgeDataset(fixture('judge-dev')),held=loadJudgeDataset(fixture('judge-held-out')),cases=dev.cases;
const point={mode:'pointwise',rubricVersion:'writing-judge-v1',scores:{adherence:4,evidence:4,clarity:4},rationale:'Synthetic test rationale'};

test('Judge datasets use separate versions, splits and case content',()=>{
 assertIndependentJudgeDatasets(dev,held);
 assert.deepEqual([...new Set(held.cases.map(value=>value.mode))].sort(),['pairwise','pointwise']);
 const copied=structuredClone(dev.cases[0]!);copied.caseId='held-copy';
 assert.throws(()=>assertIndependentJudgeDatasets(dev,{...held,version:'judge-copy-v1',cases:[copied]} as JudgeDataset),/CONTAMINATION/);
 assert.throws(()=>assertIndependentJudgeDatasets(dev,{...held,version:dev.version} as JudgeDataset),/INVALID/);
 assert.throws(()=>parseJudgeDataset({...dev,cases:[dev.cases[0]!,{...dev.cases[0]!,request:'different request'}]}),/DUPLICATE/);
});

test('Judge validates rubric and scores; high scores cannot override deterministic denial',async()=>{
 const denied=await judgeCase(cases[1]!,async()=>JSON.stringify(point));
 assert.equal(denied.score,4);assert.equal(denied.eligible,false);
 for(const invalid of [{...point,rubricVersion:'other'},{...point,scores:{adherence:5,evidence:4,clarity:4}},{...point,scores:{adherence:4}},{...point,toolCall:'write_canon'}]){
  await assert.rejects(judgeCase(cases[0]!,async()=>JSON.stringify(invalid)));
 }
 await assert.rejects(judgeCase(cases[0]!,async()=>'```json\n'+JSON.stringify(point)+'\n```'));
});

test('pairwise ordering is recorded and labels map back to original candidate ids',async()=>{
 const pair=cases[2]!;
 for(const swap of [false,true]){
  let sent='';
  const result=await judgeCase(pair,async request=>{sent=request.input;return JSON.stringify({mode:'pairwise',rubricVersion:'writing-judge-v1',winner:'A',rationale:'Synthetic'})},swap);
  assert.equal(result.winner,swap?'assertive':'uncertain');
  assert.equal(result.order[0],result.winner);
  assert(!sent.includes('deterministicPassed'));
 }
 const duplicate={...pair,candidates:[{id:'same',text:'a',deterministicPassed:true},{id:'same',text:'b',deterministicPassed:true}]} as JudgeCase;
 await assert.rejects(judgeCase(duplicate,async()=>''));
});

test('calibration reports null without humans and rejects duplicate or mismatched annotations',async()=>{
 const judgment=await judgeCase(cases[0]!,async()=>JSON.stringify(point));
 assert.deepEqual(calibrate([judgment],[],dev.version),{samples:0,pointwiseSamples:0,pairwiseSamples:0,pointwiseMeanAbsoluteError:null,pairwiseAgreement:null});
 // Synthetic annotations test arithmetic, never become human evidence in reports.
 const annotation:HumanAnnotation={caseId:judgment.caseId,datasetVersion:dev.version,rubricVersion:'writing-judge-v1',reviewerId:'test-only',annotatedAt:'2026-11-04T00:00:00Z',label:2};
 assert.equal(calibrate([judgment],[annotation],dev.version).pointwiseMeanAbsoluteError,2);
 assert.throws(()=>calibrate([judgment],[annotation,annotation],dev.version),/INVALID/);
 assert.throws(()=>calibrate([judgment],[{...annotation,datasetVersion:'other'}],dev.version),/INVALID/);
 assert.throws(()=>calibrate([judgment],[{...annotation,label:'winner'}],dev.version),/INVALID/);
});

test('synthetic Judge runs actual Pi transport with reservation, settlement and no tools',async()=>{
 const result=await runJudgeFixture(dev,[],new AbortController().signal);
 assert.equal(result.calls,3);assert.equal(result.tokenExposure,480);
 assert.equal(result.judgments[1]!.eligible,false);assert.equal(result.calibration?.samples,0);assert.deepEqual(result.failures,[]);
 for(const c of cases){const trace=result.traces.filter(t=>t.caseId===c.caseId).map(t=>t.action);assert(trace.indexOf('reserved')<trace.indexOf('model_started'));assert(trace.includes('model_finished'))}
 await assert.rejects(runJudgeFixture({...dev,cases:Array.from({length:11},()=>cases[0]!)},[],new AbortController().signal),/BUDGET/);
 const oversized={...cases[0]!,evidence:'x'.repeat(12000)};
 const refused=await runJudgeFixture({...dev,cases:[oversized]},[],new AbortController().signal);
 assert.equal(refused.calls,0);assert.equal(refused.tokenExposure,0);assert.equal(refused.failures.length,1);assert.equal(refused.calibration,null);
 const cancelled=new AbortController();cancelled.abort();
 const stopped=await runJudgeFixture(dev,[],cancelled.signal);
 assert.equal(stopped.calls,0);assert.equal(stopped.failures[0]!.code,'EVAL_CANCELLED');
});

test('Judge admission failure sends nothing and unknown usage is settled before returning',async()=>{
 let requests=0,settled=false;
 const server=createServer(async(req,res)=>{for await(const chunk of req){void chunk}requests++;res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'judge',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:JSON.stringify(point)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 const config=executionConfigSchema.parse({Provider:'openai-compatible',BaseURL:`http://127.0.0.1:${address.port}`,APIKey:'',Model:'fixture',ResponseFormat:'json_schema',TokenParameter:'max_tokens',Timeout:10e9,MaxContextBytes:8192,MaxOutputTokens:512,MaxResponseBytes:65536});
 const context=executionContext({executionId:'judge',traceId:'judge',role:'evaluation.judge',authorizationVersion:1,scopes:[],deadline:Date.now()+10000,signal:new AbortController().signal,budget:{maxTokens:10000,maxModelCalls:1,maxToolCalls:0}});
 const request={system:'Judge',input:'Synthetic answer',schema:{type:'object'}};
 try{
  for(const fail of ['authority','reserve']){
   await assert.rejects(completeJudgment(config,'synthetic',context,{authorize:async()=>{if(fail==='authority')throw Error('revoked')}},{reserve:async()=>{throw Error('persist failed')},settle:async()=>{settled=true}},request));
   assert.equal(requests,0);assert.equal(settled,false);
  }
  const response=await completeJudgment(config,'synthetic',context,{authorize:async()=>{}},{reserve:async()=>{},settle:async usage=>{assert.equal(usage,null);settled=true}},request);
  assert.equal(response.usage,null);assert.equal(settled,true);assert.equal(requests,1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
