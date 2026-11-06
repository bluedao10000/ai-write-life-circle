import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMemoryQuality,memoryQualityReviewTemplate,parseMemoryQualityDataset,type MemoryQualityAnnotation} from '../src/evaluation/memory-quality.js';

const dataset=parseMemoryQualityDataset({
 version:'memory-quality-dev-v1',split:'dev',origin:'production',cases:[
  {caseId:'case-1',extraction:{provider:'test-provider',model:'test-model',promptVersion:'memory-extraction-v3'},sourceTasks:[{taskId:'task-1',kind:'review.execute',sourceText:'作者要求逐条核对原文。',outcomeText:'作者反馈该做法有用。',sourceTruncated:false,outcomeTruncated:false}],comparisons:[{memoryId:'memory-1',content:'先核对引文，再归纳审查结论。'}],candidate:{content:'适用于审查任务：先核对每条原文，再结合作者反馈整理候选。证据只有一次成功记录，尚未验证跨任务效果。',taskIds:['task-1'],relations:[{memoryId:'memory-1',kind:'refinement',reason:'补充了作者反馈环节。'}]}},
  {caseId:'case-2',extraction:{provider:'test-provider',model:'test-model',promptVersion:'memory-extraction-v3'},sourceTasks:[{taskId:'task-2',kind:'review.execute',sourceText:'作者只要求校对标点。',outcomeText:'任务成功完成。',sourceTruncated:false,outcomeTruncated:false}],comparisons:[],candidate:{content:'适用于所有写作任务：改写全文并自动确认。',taskIds:['task-2'],relations:[]}},
 ]
});
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

test('memory quality data and annotations reject unbound sources and incomplete reviewer labels',()=>{
 const invalid=structuredClone(dataset);
 invalid.cases[0]!.candidate.taskIds=['unbound-task'];
 assert.throws(()=>parseMemoryQualityDataset(invalid),/BINDING/);
 const wrongRelation=structuredClone(dataset);
 wrongRelation.cases[0]!.candidate.relations[0]!.memoryId='missing-memory';
 assert.throws(()=>parseMemoryQualityDataset(wrongRelation),/RELATION/);
 const annotation=good('case-1','reviewer-a');
 assert.throws(()=>evaluateMemoryQuality(dataset,[annotation,annotation]),/ANNOTATION/);
 assert.throws(()=>evaluateMemoryQuality(dataset,[{...annotation,datasetVersion:'wrong'}]),/ANNOTATION/);
 assert.throws(()=>evaluateMemoryQuality(dataset,[{...annotation,relations:[]}]),/INCOMPLETE/);
 assert.throws(()=>evaluateMemoryQuality(dataset,[{...annotation,relations:[{memoryId:'foreign',assessment:'accurate'}]}]),/RELATION_LABEL/);
});
