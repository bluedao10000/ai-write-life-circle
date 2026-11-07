import {readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {z} from 'zod';
import {creativePlanHumanAnnotationSchema,creativePlanQualityReport,creativePlanRubric,loadCreativePlanDataset,assertIndependentCreativePlanDatasets,runCreativePlanJudgeFixture,type CreativePlanDataset} from '../src/evaluation/creative-plan-benchmark.js';
import {evaluationTaskSchema,type EvaluationTask} from '../src/evaluation/task-schema.js';
import {runEvaluation} from '../src/evaluation/runner.js';
import {executeEvaluation} from '../src/evaluation/executors.js';
import {runtimeVersion} from '../src/runtime/governance/index.js';
import {execFileSync} from 'node:child_process';

const args=process.argv.slice(2).filter(arg=>arg!=='--');
let split:'dev'|'held-out'|'both'='both',annotationsPath:string|undefined;
for(const arg of args){
 if(arg.startsWith('--split=')&&['dev','held-out','both'].includes(arg.slice(8)))split=arg.slice(8) as typeof split;
 else if(arg.startsWith('--annotations=')&&!annotationsPath)annotationsPath=arg.slice('--annotations='.length);
 else throw Error('Supported options: --split=dev|held-out|both and --annotations=<file>');
}
const fixture=(name:string)=>fileURLToPath(new URL(`../src/evaluation/fixtures/creative-plan-${name}.json`,import.meta.url));
const datasets={dev:loadCreativePlanDataset(fixture('dev')),held:loadCreativePlanDataset(fixture('held-out'))};
assertIndependentCreativePlanDatasets(datasets.dev,datasets.held);
const annotations=annotationsPath?z.array(creativePlanHumanAnnotationSchema).parse(JSON.parse(readFileSync(annotationsPath,'utf8'))):[];
const selected:CreativePlanDataset[]=split==='both'?[datasets.dev,datasets.held]:[split==='dev'?datasets.dev:datasets.held];
const assertions=[
 ['pairEligible',true],['deterministicPassed',true],['singleCompleted',true],['multiCompleted',true],['sameInput',true],
 ['sameProviderModel',true],['sameDeadlinePolicy',true],['sameParentReservation',true],['childBudgetSumMatchesParent',true],
 ['zeroTools',true],['zeroBusinessWrites',true],['planUnchanged',true],['sourceUnchanged',true],['authoritativeDivergences',1],
] as const;
const abort=new AbortController(),cancel=()=>abort.abort(Error('EVAL_CANCELLED'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
function task(data:CreativePlanDataset,item:CreativePlanDataset['cases'][number],index:number):EvaluationTask{
 return evaluationTaskSchema.parse({
  taskId:`${data.split}-${item.caseId}`,category:'task-success',capability:'creative',difficulty:index===0?'basic':'boundary',request:item.request,
  environment:{scenario:'creative-plan-comparison',fixture:'synthetic-v1',datasetVersion:data.version,caseId:item.caseId,initialState:{}},
  stoppingCriteria:{timeoutMs:45000,maxTokens:200000,maxModelCalls:6,maxToolCalls:0},
  scorer:{deterministic:assertions.map(([metric,value])=>({metric,operator:'eq',value})),forbidden:[]},
 });
}
function percentile(values:number[],p:number){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil(sorted.length*p)-1]??null}
function rollup(dataset:CreativePlanDataset,result:Awaited<ReturnType<typeof runEvaluation>>,judges:Awaited<ReturnType<typeof runCreativePlanJudgeFixture>>){
 const observations=result.results.map(item=>item.observation).filter((value):value is NonNullable<typeof value>=>!!value);
 const pairs=observations.flatMap(observation=>typeof observation.metrics.pairRecord==='string'?[JSON.parse(observation.metrics.pairRecord)]:[]);
 const metric=(name:string)=>observations.map(observation=>observation.metrics[name]).filter((value):value is number=>typeof value==='number');
 const roleSamples=pairs.flatMap(pair=>pair.multi.roleDurationsMs as {role:string;durationMs:number|null}[]);
 const roles=Object.fromEntries([...new Set(roleSamples.map(item=>item.role))].map(role=>{const durations=roleSamples.filter(item=>item.role===role&&typeof item.durationMs==='number').map(item=>item.durationMs!);return [role,{samples:durations.length,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95)}]}));
 const humanLabels=judges.labels;
 const quality=creativePlanQualityReport(humanLabels);
 const multiUsed=pairs.reduce((sum,pair)=>sum+(pair.multi.usageTokens??0),0),singleUsed=pairs.reduce((sum,pair)=>sum+(pair.single.usageTokens??0),0);
 return {
  version:dataset.version,split:dataset.split,synthetic:dataset.synthetic,rubricVersion:creativePlanRubric.version,judgePromptVersion:creativePlanRubric.promptVersion,
  agent:{provider:'local-synthetic-http',model:'deterministic-test-only',realLLMCalled:false,knownUsageTokens:{single:singleUsed,multi:multiUsed},unknownUsageReservations:{single:metric('singleUnknownUsageReservation').reduce((a,b)=>a+b,0),multi:metric('multiUnknownUsageReservation').reduce((a,b)=>a+b,0)},reservedTokens:{single:metric('singleReservedTokens').reduce((a,b)=>a+b,0),multi:metric('multiReservedTokens').reduce((a,b)=>a+b,0)},modelCalls:{single:metric('singleModelCalls').reduce((a,b)=>a+b,0),multi:metric('multiModelCalls').reduce((a,b)=>a+b,0)},toolCalls:metric('toolCalls').reduce((a,b)=>a+b,0),taskLatencyMs:{single:{samples:metric('singleDurationMs').length,p50:percentile(metric('singleDurationMs'),.5),p95:percentile(metric('singleDurationMs'),.95)},multi:{samples:metric('multiDurationMs').length,p50:percentile(metric('multiDurationMs'),.5),p95:percentile(metric('multiDurationMs'),.95)},roles},monetaryCost:null},
  pairs:{total:result.results.length,eligible:pairs.filter(pair=>pair.eligible).length,deterministicPassed:result.results.filter(item=>item.passed).length,failed:result.results.filter(item=>!item.passed).map(item=>({taskId:item.taskId,error:item.error??null,checks:item.grade?.checks??[]})),items:pairs},
  judge:{...judges,labels:humanLabels,quality,monetaryCost:null},
  human:{samples:humanLabels.samples,reviewers:humanLabels.reviewers,doubleReviewedCases:humanLabels.doubleReviewedCases,agreement:humanLabels.humanAgreement,judgeAgreement:humanLabels.judgeHumanAgreement},
  quality,
 };
}
try{
 for(const dataset of selected){
  const result=await runEvaluation(dataset.cases.map((item,index)=>task(dataset,item,index)),executeEvaluation,abort.signal);
  const pairs=result.results.flatMap(item=>{
   const raw=item.observation?.metrics.pairRecord;
   return typeof raw==='string'?[JSON.parse(raw)]:[];
  });
  const requestByCase=new Map(dataset.cases.map(item=>[item.caseId,item.request]));
  const judge=await runCreativePlanJudgeFixture(pairs,requestByCase,abort.signal,annotations.filter(item=>item.datasetVersion===dataset.version));
  const summary=rollup(dataset,result,judge);
  const report={schema:1,at:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()!=='',runtimeVersion,piVersion:'1.5.0',mode:'synthetic-engineering',realLLMCalled:false,qualityValidated:false,dataset:{version:dataset.version,split:dataset.split,synthetic:dataset.synthetic},promptVersions:{creativePlanCheck:'creative-plan-check-v1',judge:creativePlanRubric.promptVersion},outputSchemaVersions:{creativePlanCheck:'creative-plan-check-candidates-v2',judge:creativePlanRubric.version},result,creativePlanCheck:summary};
  const path=resolve(fileURLToPath(new URL('../../../.local/evals/agent/',import.meta.url)),`creative-plan-${dataset.split}.json`);
  mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(report,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);
  console.log(JSON.stringify({report:path,split:dataset.split,pairs:summary.pairs.total,eligible:summary.pairs.eligible,quality:summary.quality,agentCalls:summary.agent.modelCalls,judgeCalls:judge.calls}));
  if(result.results.some(item=>!item.passed)||judge.failures.length)process.exitCode=1;
 }
}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel)}
