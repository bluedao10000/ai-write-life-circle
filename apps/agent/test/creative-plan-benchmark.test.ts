import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {
 assertIndependentCreativePlanDatasets,creativePlanHumanAnnotationSchema,creativePlanQualityReport,creativePlanRubric,
 judgeCreativePlanPair,loadCreativePlanDataset,pairCreativePlanRuns,runCreativePlanJudgeFixture,
 summarizeCreativePlanLabels,type CreativePlanPair,type CreativePlanRun,
} from '../src/evaluation/creative-plan-benchmark.js';

const fixture=(name:string)=>fileURLToPath(new URL(`../src/evaluation/fixtures/${name}.json`,import.meta.url));
const dev=loadCreativePlanDataset(fixture('creative-plan-dev'));
const held=loadCreativePlanDataset(fixture('creative-plan-held-out'));
const roles=['creative.plan.planner','creative.plan.researcher','creative.plan.analyst','creative.plan.critic','creative.plan.coordinator'];
function run(id:string,mode:'single'|'multi'):CreativePlanRun{
 return {
  taskId:`task-${id}`,jobId:`job-${id}`,status:'completed',finished:true,revisionId:'revision',contentHash:'content',inputHash:'input',
  provider:'fixture',model:'synthetic',deadlinePolicyMs:17000,reservedTokens:10000,modelCalls:mode==='single'?1:5,
  roleBudgets:mode==='single'?[{role:'creative.plan.single',maxTokens:10000}]:roles.map((role,index)=>({role,maxTokens:index===4?2000:2000})),
  roleResults:mode==='single'?[]:roles.map((role,index)=>({role,callIndex:index+1,status:'completed' as const,durationMs:index+1,usage:{inputTokens:100,outputTokens:100}})),
  usageTokens:mode==='single'?300:1000,unknownUsage:false,toolCalls:0,businessWrites:0,durationMs:mode==='single'?10:50,
  roleDurationsMs:mode==='multi'?roles.map((role,index)=>({role,durationMs:index+1})):[],
  output:JSON.stringify({assessment:'diverged',quote:'evidence',explanation:'计划与正文不同。',question:'这是有意的吗？'}),
 };
}
function pair(caseId='dev-lighthouse-choice',single=run('single','single'),multi=run('multi','multi')):CreativePlanPair{
 return pairCreativePlanRuns({datasetVersion:dev.version,split:'dev',caseId,single,multi});
}
const response={rubricVersion:creativePlanRubric.version,winner:'A',scores:{A:{evidenceSupport:4,assessmentAccuracy:3,uncertaintyHandling:4,authorUsefulness:3},B:{evidenceSupport:3,assessmentAccuracy:3,uncertaintyHandling:2,authorUsefulness:3}},rationale:'One candidate uses the supplied evidence more carefully.'};

test('Creative plan datasets have isolated versions, splits, ids and content',()=>{
 assertIndependentCreativePlanDatasets(dev,held);
 assert.throws(()=>assertIndependentCreativePlanDatasets(dev,{...held,version:dev.version}),/INVALID/);
 assert.throws(()=>assertIndependentCreativePlanDatasets(dev,{...held,cases:[{...held.cases[0]!,caseId:dev.cases[0]!.caseId}]}),/CONTAMINATION/);
 assert.throws(()=>assertIndependentCreativePlanDatasets(dev,{...held,cases:[{...held.cases[0]!,request:dev.cases[0]!.request}]}),/CONTAMINATION/);
});

test('paired results require matching Go evidence, model, deadline and parent cap',()=>{
 const value=pair();
 assert.equal(value.eligible,true);assert.equal(value.deterministicPassed,true);
 assert.equal(value.checks.equalParentReservation,true);assert.equal(value.checks.expectedCalls,true);
 for(const [field,change] of [
  ['revisionId','other-revision'],['contentHash','other-content'],['inputHash','other-input'],['model','other-model'],['deadlinePolicyMs',18000],['reservedTokens',11000],
 ] as const){
  const altered={...run('multi','multi'),[field]:change} as CreativePlanRun;
  assert.throws(()=>pairCreativePlanRuns({datasetVersion:dev.version,split:'dev',caseId:'dev-lighthouse-choice',single:run('single','single'),multi:altered}),/PAIR_MISMATCH/);
 }
 assert.throws(()=>pairCreativePlanRuns({datasetVersion:dev.version,split:'dev',caseId:'dev-lighthouse-choice',single:run('same','single'),multi:run('same','multi')}),/DUPLICATE/);
});

test('child role caps exactly consume the shared parent budget and reject expansion',()=>{
 assert.equal(pair().multi.roleBudgets.reduce((sum,item)=>sum+item.maxTokens,0),pair().multi.reservedTokens);
 const expanded={...run('multi','multi'),roleBudgets:roles.map((role,index)=>({role,maxTokens:index===4?2001:2000}))};
 const changed=pairCreativePlanRuns({datasetVersion:dev.version,split:'dev',caseId:'dev-lighthouse-choice',single:run('single','single'),multi:expanded});
 assert.equal(changed.checks.childBudgetBounded,false);assert.equal(changed.eligible,false);
});

test('paired results require a finished task and five persisted completed role results',()=>{
 const complete=run('multi','multi');
 const reordered=pair('dev-lighthouse-choice',run('single','single'),{...complete,roleResults:[...complete.roleResults].reverse()});
 assert.equal(reordered.checks.persistedTaskResults,true);assert.equal(reordered.checks.persistedRoleResults,true);assert.equal(reordered.eligible,true);
 const unfinished=pairCreativePlanRuns({datasetVersion:dev.version,split:'dev',caseId:'dev-lighthouse-choice',single:run('single','single'),multi:{...complete,finished:false}});
 assert.equal(unfinished.checks.persistedTaskResults,false);assert.equal(unfinished.eligible,false);
 for(const changed of [
  {...complete,roleResults:complete.roleResults.slice(0,4)},
  {...complete,roleResults:complete.roleResults.map((result,index)=>index===2?{...result,status:'failed' as const}:result)},
  {...complete,roleResults:complete.roleResults.map((result,index)=>index===1?{...result,durationMs:null}:result)},
  {...complete,roleResults:complete.roleResults.map((result,index)=>index===4?{...result,usage:null}:result)},
  {...complete,usageTokens:999},
 ]){
  const value=pairCreativePlanRuns({datasetVersion:dev.version,split:'dev',caseId:'dev-lighthouse-choice',single:run('single','single'),multi:changed});
  assert.equal(value.checks.persistedRoleResults,false);
  assert.equal(value.eligible,false);
 }
});

test('pairwise Judge records random order, mapped winner and fixed plan-check rubric',async()=>{
 for(const swap of [false,true]){
  let request='';
  const result=await judgeCreativePlanPair(pair(),'synthetic request',async value=>{request=value.input;return JSON.stringify(response)},swap);
  assert.equal(result.rubricVersion,'creative-plan-check-pairwise-v1');
  assert.deepEqual(result.order,swap?['multi','single']:['single','multi']);
  assert.equal(result.winner,swap?'multi':'single');
  assert.deepEqual(result.scores.single,swap?response.scores.B:response.scores.A);
  assert(request.includes('synthetic request'));
 }
});

test('a deterministic failure stays ineligible regardless of Judge response',async()=>{
 const value=pair('dev-lighthouse-choice',run('single','single'),{...run('multi','multi'),status:'failed',modelCalls:4,output:null});
 assert.equal(value.eligible,false);assert.equal(value.checks.multiCompleted,false);
 await assert.rejects(judgeCreativePlanPair(value,'synthetic request',async()=>JSON.stringify(response)),/INELIGIBLE/);
});

test('human labels require two distinct reviewers and quality stays null without evidence',()=>{
 const value=pair(),judgment={caseId:value.caseId,datasetVersion:dev.version,rubricVersion:creativePlanRubric.version,promptVersion:creativePlanRubric.promptVersion,order:['single','multi'],winner:'single' as const,scores:{single:response.scores.A,multi:response.scores.B},rationale:'',eligible:true as const};
 const empty=summarizeCreativePlanLabels([value],[judgment],[],dev.version);
 assert.equal(empty.humanAgreement,null);assert.deepEqual(empty.quality,{singleWinRate:null,multiWinRate:null,tieRate:null});
 const annotation=(reviewerId:string,winner:'single'|'multi'|'tie')=>({caseId:value.caseId,datasetVersion:dev.version,rubricVersion:creativePlanRubric.version,reviewerId,annotatedAt:'2026-11-07T00:00:00Z',winner});
 const labeled=summarizeCreativePlanLabels([value],[judgment],[annotation('reviewer-a','single'),annotation('reviewer-b','single')],dev.version);
 assert.equal(labeled.doubleReviewedCases,1);assert.equal(labeled.humanAgreement,1);assert.equal(labeled.judgeHumanAgreement,1);assert.equal(labeled.quality.singleWinRate,1);
 assert.deepEqual(creativePlanQualityReport(labeled),{singleWinRate:1,multiWinRate:0,tieRate:0,validated:false});
 assert.deepEqual(creativePlanQualityReport(empty),{singleWinRate:null,multiWinRate:null,tieRate:null,validated:false});
 assert.throws(()=>summarizeCreativePlanLabels([value],[judgment],[annotation('reviewer-a','single'),annotation('reviewer-a','single')],dev.version),/INVALID/);
 assert.throws(()=>summarizeCreativePlanLabels([value],[judgment],[{...annotation('reviewer-a','single'),datasetVersion:'other'}],dev.version),/INVALID/);
 const denied=pair('dev-lighthouse-choice',run('single','single'),{...run('multi','multi'),businessWrites:1});
 assert.throws(()=>summarizeCreativePlanLabels([denied],[judgment],[annotation('reviewer-a','single')],dev.version),/INVALID/);
 assert.doesNotThrow(()=>creativePlanHumanAnnotationSchema.parse(annotation('reviewer-a','single')));
});

test('localhost governed plan-check Judge keeps synthetic judgments out of quality metrics',async()=>{
 const value=pair();
 const annotation=(reviewerId:string)=>({caseId:value.caseId,datasetVersion:dev.version,rubricVersion:creativePlanRubric.version,reviewerId,annotatedAt:'2026-11-07T00:00:00Z',winner:'single' as const});
 const result=await runCreativePlanJudgeFixture([value],new Map([[value.caseId,'synthetic evidence']]),new AbortController().signal,[annotation('reviewer-a'),annotation('reviewer-b')]);
 assert.equal(result.realLLMCalled,false);assert.equal(result.qualityValidated,false);
 assert.equal(result.calls,1);assert.equal(result.reservedCalls,1);assert.equal(result.tokenExposure,200);
 assert.deepEqual(result.quality,{singleWinRate:1,multiWinRate:0,tieRate:0,validated:false});
 assert.equal(result.labels.humanAgreement,1);
});
