import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMemoryQuality,memoryQualityReviewTemplate,parseMemoryQualityDataset,type MemoryQualityAnnotation} from '../src/evaluation/memory-quality.js';

const resultVersion='sha256:'+'a'.repeat(64);
const taskEvidence=(taskId:string)=>({taskId,kind:'review.execute',strategyVersion:'review-v1',inputHash:'input-'+taskId,completedAt:'2026-11-06T00:00:00Z'});
function capture(caseId:string,withRelation:boolean){
 const taskId=caseId==='case-1'?'task-1':'task-2',sessionId='session-'+caseId,runId='run-'+caseId,memoryId='memory-1';
 const evidence=taskEvidence(taskId);
 const relation=withRelation?[{memoryId,memoryVersion:1,kind:'refinement',reason:'补充了作者反馈环节。'}]:[];
 const comparison=withRelation?[{id:memoryId,status:'confirmed',version:1,content:'先核对引文，再归纳审查结论。',createdAt:'2026-11-06T00:00:00Z',updatedAt:'2026-11-06T00:00:00Z',available:true}]:[];
 return {
  caseId,
  candidate:{id:'pm-'+caseId,status:'candidate',version:1,content:caseId==='case-1'?'适用于审查任务：先核对每条原文，再结合作者反馈整理候选。证据只有一次成功记录，尚未验证跨任务效果。':'适用于所有写作任务：改写全文并自动确认。',provenance:[evidence],extractions:[{sessionId,runId,provider:'test-provider',model:'test-model',promptVersion:'memory-extraction-v3',authorizationVersion:1,relations:relation}],createdAt:'2026-11-06T00:00:00Z',updatedAt:'2026-11-06T00:00:00Z',available:false,unavailableReason:'not_confirmed'},
  session:{sessionId,status:'idle',scopes:[],model:{provider:'test-provider',model:'test-model'},memoryExtraction:{version:3,tasks:[{taskId,resultVersion}],comparisons:withRelation?[{memoryId,memoryVersion:1}]:[],comparisonOmitted:0},run:{runId,status:'completed',authorizationVersion:1}},
  sources:[{evidence,source:{type:'chapter',chapterId:'chapter-1',revisionId:'revision-1',contentHash:'content-hash',text:'作者要求逐条核对原文。'},truncated:false}],
  outcomes:[{evidence,basis:'task_result',version:resultVersion,items:[{id:'result-1',kind:'review_finding',status:'proposed',text:'作者反馈该做法有用。',feedback:'useful'}],total:1,truncated:false}],
  comparisons:comparison,
 };
}
const dataset=parseMemoryQualityDataset({version:'memory-quality-dev-v1',split:'dev',origin:'production',captures:[capture('case-1',true),capture('case-2',false)]});
const good=(caseId:string,reviewerId:string,overrides:Partial<MemoryQualityAnnotation>={}):MemoryQualityAnnotation=>({
 caseId,datasetVersion:dataset.version,rubricVersion:'procedural-memory-quality-v1',reviewerId,annotatedAt:'2026-11-06T00:00:00Z',
 evidenceGrounding:'supported',actionability:'actionable',scope:'appropriate',limitations:'adequate',coverage:'complete',sourceSelection:'relevant',
 relations:caseId==='case-1'?[{memoryId:'memory-1',assessment:'accurate'}]:[],...overrides,
});

test('memory quality report keeps every quality value null until annotations are supplied',()=>{
 const result=evaluateMemoryQuality(dataset,[]);
 assert.deepEqual(result.qualitySuccessRate,{numerator:0,denominator:0,value:null});
 for(const value of Object.values(result.dimensions))assert.equal(value.value,null);
 assert.equal(result.relationAccuracy.value,null);
 assert.equal(result.reviewerAgreement.evidenceGrounding.rate,null);
 assert.equal(result.reviewerAgreement.evidenceGrounding.pairs,0);
 assert.equal(result.relationAgreement.rate,null);
});

test('review template references cases and relation ids without copying private source or candidate text',()=>{
 const value=memoryQualityReviewTemplate(dataset);
 assert.equal(value.annotations.length,2);
 assert.deepEqual(value.annotations[0]!.relations,[{memoryId:'memory-1',assessment:''}]);
 const serialized=JSON.stringify(value);
 assert(!serialized.includes('作者要求逐条核对原文'));
 assert(!serialized.includes('尚未验证跨任务效果'));
});

test('quality metrics use independent complete reviews and report dimension agreement',()=>{
 const annotations=[good('case-1','reviewer-a'),good('case-1','reviewer-b'),good('case-2','reviewer-a',{evidenceGrounding:'unsupported',actionability:'not_reusable',scope:'overgeneralized',limitations:'missing',coverage:'material_omission',sourceSelection:'irrelevant_included'})];
 const result=evaluateMemoryQuality(dataset,annotations);
 assert.equal(result.reviewedCases,2);assert.equal(result.annotations,3);assert.equal(result.reviewers,2);assert.equal(result.doubleReviewedCases,1);
 assert.deepEqual(result.qualitySuccessRate,{numerator:1,denominator:2,value:.5});
 assert.deepEqual(result.dimensions.evidenceGrounding,{numerator:2,denominator:3,value:2/3});
 assert.deepEqual(result.relationAccuracy,{numerator:2,denominator:2,value:1});
 assert.deepEqual(result.reviewerAgreement.evidenceGrounding,{pairs:1,rate:1});
 assert.deepEqual(result.relationAgreement,{pairs:1,rate:1});
 assert.deepEqual(result.extractorVersions,[{provider:'test-provider',model:'test-model',promptVersion:'memory-extraction-v3',samples:2}]);
});

test('memory quality captures reject mismatched Go, Thinking, source and comparison records',()=>{
 const invalidRun=structuredClone(capture('bad-run',false));
 invalidRun.candidate.extractions[0]!.runId='another-run';
 assert.throws(()=>parseMemoryQualityDataset({version:'v1',split:'dev',origin:'production',captures:[invalidRun]}),/RUN_MISMATCH/);
 const invalidTask=structuredClone(capture('bad-task',false));
 invalidTask.session.memoryExtraction.tasks[0]!.taskId='unbound-task';
 assert.throws(()=>parseMemoryQualityDataset({version:'v1',split:'dev',origin:'production',captures:[invalidTask]}),/SOURCE_VERSION_MISMATCH/);
 const invalidResult=structuredClone(capture('bad-result',false));
 invalidResult.outcomes[0]!.version='sha256:'+'b'.repeat(64);
 assert.throws(()=>parseMemoryQualityDataset({version:'v1',split:'dev',origin:'production',captures:[invalidResult]}),/SOURCE_VERSION_MISMATCH/);
 const invalidRelation=structuredClone(capture('bad-relation',true));
 invalidRelation.candidate.extractions[0]!.relations[0]!.memoryId='missing-memory';
 assert.throws(()=>parseMemoryQualityDataset({version:'v1',split:'dev',origin:'production',captures:[invalidRelation]}),/RELATION/);
 const invalidComparison=structuredClone(capture('bad-comparison',true));
 invalidComparison.comparisons[0]!.version=2;
 assert.throws(()=>parseMemoryQualityDataset({version:'v1',split:'dev',origin:'production',captures:[invalidComparison]}),/COMPARISON_VERSION_MISMATCH/);
});

test('memory quality annotations reject duplicates, wrong versions and incomplete relation labels',()=>{
 const annotation=good('case-1','reviewer-a');
 assert.throws(()=>evaluateMemoryQuality(dataset,[annotation,annotation]),/ANNOTATION/);
 assert.throws(()=>evaluateMemoryQuality(dataset,[{...annotation,datasetVersion:'wrong'}]),/ANNOTATION/);
 assert.throws(()=>evaluateMemoryQuality(dataset,[{...annotation,relations:[]}]),/INCOMPLETE/);
 assert.throws(()=>evaluateMemoryQuality(dataset,[{...annotation,relations:[{memoryId:'foreign',assessment:'accurate'}]}]),/RELATION_LABEL/);
});
