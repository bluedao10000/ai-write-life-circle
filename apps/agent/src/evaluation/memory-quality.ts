import {Buffer} from 'node:buffer';
import {memoryExtractionBindingSchema,proceduralOutcomeSchema,proceduralSourceSchema,proceduralViewSchema} from '@writer-agent/contracts';
import {z} from 'zod';

export const memoryQualityRubric=Object.freeze({
 version:'procedural-memory-quality-v1',
 dimensions:Object.freeze({
  evidenceGrounding:'Is the candidate supported by the selected source text, task results and author feedback? Execution alone does not prove quality or causality.',
  actionability:'Does it describe a concrete, reusable method rather than a vague goal?',
  scope:'Does it avoid treating fictional facts as real operating rules or generalizing beyond the evidence?',
  limitations:'Does it describe limits of the evidence and uncertainty?',
  coverage:'Does it preserve material conditions, exceptions and author corrections from the supplied evidence?',
  sourceSelection:'Are the selected tasks relevant, and are material selected tasks represented?',
  relations:'Does each proposed duplicate, conflict or refinement accurately describe the compared confirmed experience?',
 }),
});

const nonblank=(max:number)=>z.string().min(1).max(max).refine(value=>value.trim().length>0);
const sourceTaskSchema=z.object({
 taskId:nonblank(200),
 kind:nonblank(80),
 sourceText:nonblank(32_768),
 outcomeText:nonblank(32_768),
 sourceTruncated:z.boolean(),
 outcomeTruncated:z.boolean(),
}).strict();
const relationSchema=z.object({memoryId:nonblank(200),kind:z.enum(['duplicate','conflict','refinement']),reason:nonblank(1000)}).strict();
const comparisonSchema=z.object({memoryId:nonblank(200),content:nonblank(4000)}).strict();
const caseSchema=z.object({
 caseId:nonblank(160),
 extraction:z.object({provider:nonblank(100),model:nonblank(200),promptVersion:z.enum(['memory-extraction-v1','memory-extraction-v2','memory-extraction-v3'])}).strict(),
 sourceTasks:z.array(sourceTaskSchema).min(1).max(4),
 comparisons:z.array(comparisonSchema).max(8),
 candidate:z.object({content:nonblank(4000),taskIds:z.array(nonblank(200)).min(1).max(4),relations:z.array(relationSchema).max(8)}).strict(),
}).strict();
export const memoryQualityDatasetSchema=z.object({
 version:nonblank(120),
 split:z.enum(['dev','held-out']),
 origin:z.enum(['production','synthetic']),
 cases:z.array(caseSchema).min(1).max(100),
}).strict();
export type MemoryQualityDataset=z.infer<typeof memoryQualityDatasetSchema>;
export type MemoryQualityCase=z.infer<typeof caseSchema>;

const captureSchema=z.object({
 caseId:nonblank(160),
 candidate:proceduralViewSchema,
 session:z.object({
  sessionId:nonblank(200),status:z.enum(['idle','running','deleted']),scopes:z.array(z.string()),
  model:z.object({provider:nonblank(100),model:nonblank(200)}).strict(),
  memoryExtraction:memoryExtractionBindingSchema,
  run:z.object({runId:nonblank(200),status:z.enum(['accepted','running','checkpointed','completed','failed','interrupted','cancelled']),authorizationVersion:z.number().int().nonnegative()}).strict().optional(),
 }).strict(),
 sources:z.array(proceduralSourceSchema).max(4),
 outcomes:z.array(proceduralOutcomeSchema).max(4),
 comparisons:z.array(proceduralViewSchema).max(8),
}).strict();
const captureDatasetSchema=z.object({version:nonblank(120),split:z.enum(['dev','held-out']),origin:z.enum(['production','synthetic']),captures:z.array(captureSchema).min(1).max(100)}).strict();

const values={
 evidenceGrounding:['supported','mixed','unsupported','unclear'],
 actionability:['actionable','vague','not_reusable'],
 scope:['appropriate','overgeneralized','fictional_leak','unclear'],
 limitations:['adequate','incomplete','missing'],
 coverage:['complete','minor_omission','material_omission','unclear'],
 sourceSelection:['relevant','irrelevant_included','relevant_omitted','unclear'],
} as const;
export const memoryQualityAnnotationSchema=z.object({
 caseId:nonblank(160),datasetVersion:nonblank(120),rubricVersion:z.literal(memoryQualityRubric.version),
 reviewerId:nonblank(120),annotatedAt:z.iso.datetime(),
 evidenceGrounding:z.enum(values.evidenceGrounding),
 actionability:z.enum(values.actionability),
 scope:z.enum(values.scope),
 limitations:z.enum(values.limitations),
 coverage:z.enum(values.coverage),
 sourceSelection:z.enum(values.sourceSelection),
 relations:z.array(z.object({memoryId:nonblank(200),assessment:z.enum(['accurate','inaccurate','unclear'])}).strict()).max(8),
}).strict();
export type MemoryQualityAnnotation=z.infer<typeof memoryQualityAnnotationSchema>;

function sameEvidence(left:{taskId:string;kind:string;strategyVersion:string;inputHash:string;completedAt:string},right:{taskId:string;kind:string;strategyVersion:string;inputHash:string;completedAt:string}){
 return left.taskId===right.taskId&&left.kind===right.kind&&left.strategyVersion===right.strategyVersion&&left.inputHash===right.inputHash&&left.completedAt===right.completedAt;
}
function memorySourceText(source:z.infer<typeof proceduralSourceSchema>):string{
 if(source.source.type==='chapter')return `[章节 ${source.source.chapterId} / 修订 ${source.source.revisionId}${source.truncated?' / 内容截断':''}]\n${source.source.text??''}`;
 return `[讨论 ${source.source.sessionId}${source.truncated?' / 内容截断':''}]\n${source.source.messages.map(message=>`[${message.role==='user'?'作者':'助手'}] ${message.text}`).join('\n')}`;
}
function memoryOutcomeText(outcome:z.infer<typeof proceduralOutcomeSchema>):string{
 const items=outcome.items.map(item=>[
  `${item.id} | ${item.kind} | ${item.status}${item.epistemic?` | ${item.epistemic}`:''}${item.feedback?` | feedback: ${item.feedback}`:''}`,
  item.text,
 ].join('\n')).join('\n\n');
 return [`结果依据：${outcome.basis}`,`结果条目：${outcome.total}`,outcome.truncated?'结果内容截断':'',items].filter(Boolean).join('\n');
}

export function parseMemoryQualityDataset(input:unknown):MemoryQualityDataset{
 const captured=captureDatasetSchema.parse(input),captureIDs=new Set<string>();
 const dataset=memoryQualityDatasetSchema.parse({version:captured.version,split:captured.split,origin:captured.origin,cases:captured.captures.map(value=>{
  if(captureIDs.has(value.caseId))throw Error('DUPLICATE_MEMORY_QUALITY_CASE');
  captureIDs.add(value.caseId);
  const candidate=value.candidate,session=value.session,binding=session.memoryExtraction,run=session.run;
  if(candidate.status!=='candidate'||!candidate.content||!candidate.extractions||candidate.extractions.length!==1||!candidate.provenance?.length||session.status!=='idle'||session.scopes.length!==0||binding.version!==3||!run||run.status!=='completed')throw Error('INVALID_MEMORY_QUALITY_CAPTURE');
  const extraction=candidate.extractions[0]!;
  if(extraction.promptVersion!=='memory-extraction-v3'||extraction.sessionId!==session.sessionId||extraction.runId!==run.runId||extraction.provider!==session.model.provider||extraction.model!==session.model.model||extraction.authorizationVersion!==run.authorizationVersion)throw Error('MEMORY_QUALITY_RUN_MISMATCH');
  const boundTasks=new Map(binding.tasks.map(task=>[task.taskId,task.resultVersion]));
  if(boundTasks.size!==binding.tasks.length||value.sources.length!==boundTasks.size||value.outcomes.length!==boundTasks.size)throw Error('MEMORY_QUALITY_SOURCE_SET_MISMATCH');
  const sources=new Map(value.sources.map(source=>[source.evidence.taskId,source]));
  const outcomes=new Map(value.outcomes.map(outcome=>[outcome.evidence.taskId,outcome]));
  if(sources.size!==value.sources.length||outcomes.size!==value.outcomes.length)throw Error('MEMORY_QUALITY_SOURCE_SET_MISMATCH');
  const sourceTasks=[];
  for(const [taskId,resultVersion] of boundTasks){
   const source=sources.get(taskId),outcome=outcomes.get(taskId);
   if(!source||!outcome||!sameEvidence(source.evidence,outcome.evidence)||outcome.version!==resultVersion)throw Error('MEMORY_QUALITY_SOURCE_VERSION_MISMATCH');
   sourceTasks.push({taskId,kind:source.evidence.kind,sourceText:memorySourceText(source),outcomeText:memoryOutcomeText(outcome),sourceTruncated:source.truncated,outcomeTruncated:outcome.truncated});
  }
  const sourceTaskIDs=new Set(sourceTasks.map(task=>task.taskId)),selectedTaskIDs=new Set(candidate.provenance.map(source=>source.taskId));
  if(selectedTaskIDs.size!==candidate.provenance.length||[...selectedTaskIDs].some(taskId=>!sourceTaskIDs.has(taskId)))throw Error('INVALID_MEMORY_QUALITY_TASK_BINDING');
  for(const evidence of candidate.provenance){const source=sources.get(evidence.taskId);if(!source||!sameEvidence(evidence,source.evidence))throw Error('MEMORY_QUALITY_SOURCE_VERSION_MISMATCH')}
  const boundComparisons=new Map(binding.comparisons.map(comparison=>[comparison.memoryId,comparison.memoryVersion]));
  const comparisons=new Map(value.comparisons.map(comparison=>[comparison.id,comparison]));
  if(boundComparisons.size!==binding.comparisons.length||comparisons.size!==value.comparisons.length||comparisons.size!==boundComparisons.size)throw Error('MEMORY_QUALITY_COMPARISON_SET_MISMATCH');
  for(const [memoryId,memoryVersion] of boundComparisons){
   const comparison=comparisons.get(memoryId);
   if(!comparison||comparison.status!=='confirmed'||!comparison.available||comparison.version!==memoryVersion||!comparison.content)throw Error('MEMORY_QUALITY_COMPARISON_VERSION_MISMATCH');
  }
  const relations=extraction.relations??[];
  for(const relation of relations)if(boundComparisons.get(relation.memoryId)!==relation.memoryVersion)throw Error('INVALID_MEMORY_QUALITY_RELATION');
  return {caseId:value.caseId,extraction:{provider:extraction.provider,model:extraction.model,promptVersion:extraction.promptVersion},sourceTasks,comparisons:Array.from(comparisons.values(),comparison=>({memoryId:comparison.id,content:comparison.content!})),candidate:{content:candidate.content,taskIds:Array.from(selectedTaskIDs),relations:relations.map(({memoryId,kind,reason})=>({memoryId,kind,reason}))}};
 } )});
 const ids=new Set<string>();
 for(const value of dataset.cases){
  if(ids.has(value.caseId))throw Error('DUPLICATE_MEMORY_QUALITY_CASE');
  ids.add(value.caseId);
  const taskIds=new Set<string>();
  for(const task of value.sourceTasks){
   if(taskIds.has(task.taskId))throw Error('DUPLICATE_MEMORY_QUALITY_TASK');
   taskIds.add(task.taskId);
   if(Buffer.byteLength(task.sourceText,'utf8')>32_768||Buffer.byteLength(task.outcomeText,'utf8')>32_768)throw Error('MEMORY_QUALITY_SOURCE_TOO_LARGE');
  }
  const selected=new Set<string>();
  for(const taskId of value.candidate.taskIds){
   if(selected.has(taskId)||!taskIds.has(taskId))throw Error('INVALID_MEMORY_QUALITY_TASK_BINDING');
   selected.add(taskId);
  }
  const comparisons=new Set<string>();
  for(const comparison of value.comparisons){
   if(comparisons.has(comparison.memoryId)||Buffer.byteLength(comparison.content,'utf8')>4000)throw Error('INVALID_MEMORY_QUALITY_COMPARISON');
   comparisons.add(comparison.memoryId);
  }
  const relations=new Set<string>();
  for(const relation of value.candidate.relations){
   if(relations.has(relation.memoryId)||!comparisons.has(relation.memoryId)||Buffer.byteLength(relation.reason,'utf8')>1000)throw Error('INVALID_MEMORY_QUALITY_RELATION');
   relations.add(relation.memoryId);
  }
  if(Buffer.byteLength(value.candidate.content,'utf8')>4000)throw Error('MEMORY_QUALITY_CANDIDATE_TOO_LARGE');
 }
 return dataset;
}

export function memoryQualityReviewTemplate(dataset:MemoryQualityDataset){
 return {
  schemaVersion:1,
  datasetVersion:dataset.version,
  rubricVersion:memoryQualityRubric.version,
  instructions:'Review each candidate against its source tasks, current results and comparisons. Keep reviewer labels independent. Do not infer quality or causality from successful execution alone.',
  annotations:dataset.cases.map(value=>({
   caseId:value.caseId,datasetVersion:dataset.version,rubricVersion:memoryQualityRubric.version,reviewerId:'',annotatedAt:'',
   evidenceGrounding:'',actionability:'',scope:'',limitations:'',coverage:'',sourceSelection:'',
   relations:value.candidate.relations.map(relation=>({memoryId:relation.memoryId,assessment:''})),
  })),
 };
}

type Rate=Readonly<{numerator:number;denominator:number;value:number|null}>;
function rate(numerator:number,denominator:number):Rate{return {numerator,denominator,value:denominator?numerator/denominator:null}}
const metricFields=['evidenceGrounding','actionability','scope','limitations','coverage','sourceSelection'] as const;
type MetricField=typeof metricFields[number];
const acceptable:Record<MetricField,string>={evidenceGrounding:'supported',actionability:'actionable',scope:'appropriate',limitations:'adequate',coverage:'complete',sourceSelection:'relevant'};
function passes(annotation:MemoryQualityAnnotation){
 return metricFields.every(field=>annotation[field]===acceptable[field])&&annotation.relations.every(relation=>relation.assessment==='accurate');
}
function agreement(groups:Map<string,string[]>){
 let pairs=0,agreed=0;
 for(const labels of groups.values())for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){
  pairs++;if(labels[i]===labels[j])agreed++;
 }
 return {pairs,rate:pairs?agreed/pairs:null};
}

export function evaluateMemoryQuality(dataset:MemoryQualityDataset,input:MemoryQualityAnnotation[]){
 const cases=new Map(dataset.cases.map(value=>[value.caseId,value]));
 const seen=new Set<string>(),reviewers=new Set<string>(),byCase=new Map<string,MemoryQualityAnnotation[]>();
 for(const raw of input){
  const annotation=memoryQualityAnnotationSchema.parse(raw),value=cases.get(annotation.caseId);
  const key=JSON.stringify([annotation.caseId,annotation.reviewerId]);
  if(!value||seen.has(key)||annotation.datasetVersion!==dataset.version)throw Error('INVALID_MEMORY_QUALITY_ANNOTATION');
  seen.add(key);reviewers.add(annotation.reviewerId);
  const expected=new Set(value.candidate.relations.map(relation=>relation.memoryId)),actual=new Set<string>();
  for(const relation of annotation.relations){
   if(actual.has(relation.memoryId)||!expected.has(relation.memoryId))throw Error('INVALID_MEMORY_QUALITY_RELATION_LABEL');
   actual.add(relation.memoryId);
  }
  if(actual.size!==expected.size)throw Error('INCOMPLETE_MEMORY_QUALITY_RELATION_LABELS');
  const rows=byCase.get(annotation.caseId)??[];rows.push(annotation);byCase.set(annotation.caseId,rows);
 }
 const dimensionCounts=Object.fromEntries(metricFields.map(field=>{
  const rows=input.map(annotation=>annotation[field]);
  return [field,rate(rows.filter(value=>value===acceptable[field]).length,rows.length)];
 })) as Record<MetricField,Rate>;
 const relationLabels=new Map<string,string[]>(),dimensionLabels=Object.fromEntries(metricFields.map(field=>[field,new Map<string,string[]>()])) as Record<MetricField,Map<string,string[]>>;
 for(const annotation of input){
  for(const field of metricFields){const key=annotation.caseId,values=dimensionLabels[field].get(key)??[];values.push(annotation[field]);dimensionLabels[field].set(key,values)}
  for(const relation of annotation.relations){const key=JSON.stringify([annotation.caseId,relation.memoryId]),values=relationLabels.get(key)??[];values.push(relation.assessment);relationLabels.set(key,values)}
 }
 const reviewedCasePass=Array.from(byCase.values()).map(rows=>rows.every(passes));
 const relationValues=input.flatMap(annotation=>annotation.relations.map(relation=>relation.assessment));
 return {
  datasetVersion:dataset.version,split:dataset.split,inputOrigin:dataset.origin,rubricVersion:memoryQualityRubric.version,
  reviewedCases:byCase.size,annotations:input.length,reviewers:reviewers.size,
  doubleReviewedCases:Array.from(byCase.values()).filter(rows=>rows.length>1).length,
  qualitySuccessRate:rate(reviewedCasePass.filter(Boolean).length,reviewedCasePass.length),
  dimensions:dimensionCounts,
  relationAccuracy:rate(relationValues.filter(value=>value==='accurate').length,relationValues.length),
  relationAssessments:{accurate:relationValues.filter(value=>value==='accurate').length,inaccurate:relationValues.filter(value=>value==='inaccurate').length,unclear:relationValues.filter(value=>value==='unclear').length},
  reviewerAgreement:Object.fromEntries(metricFields.map(field=>[field,agreement(dimensionLabels[field])])) as Record<MetricField,ReturnType<typeof agreement>>,
  relationAgreement:agreement(relationLabels),
  extractorVersions:Object.values(dataset.cases.reduce<Record<string,{provider:string;model:string;promptVersion:string;samples:number}>>((out,value)=>{
   const key=JSON.stringify([value.extraction.provider,value.extraction.model,value.extraction.promptVersion]);
   const row=out[key]??{provider:value.extraction.provider,model:value.extraction.model,promptVersion:value.extraction.promptVersion,samples:0};row.samples++;out[key]=row;return out;
  },{})),
 } as const;
}
