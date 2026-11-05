import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {judgeCaseSchema,type JudgeCase} from './judge.js';

export const judgeDatasetSchema=z.object({
  version:z.string().min(1),
  split:z.enum(['dev','held-out']),
  synthetic:z.literal(true),
  cases:z.array(judgeCaseSchema).min(1),
}).strict();
export type JudgeDataset=z.infer<typeof judgeDatasetSchema>;

function contentKey(value:JudgeCase){
  const candidates=value.mode==='pointwise'
    ? [{text:value.candidate.text,passed:value.candidate.deterministicPassed}]
    : value.candidates.map(candidate=>({text:candidate.text,passed:candidate.deterministicPassed})).sort((a,b)=>a.text<b.text?-1:a.text>b.text?1:Number(a.passed)-Number(b.passed));
  return JSON.stringify({mode:value.mode,request:value.request,evidence:value.evidence,candidates});
}

export function parseJudgeDataset(value:unknown){
  const data=judgeDatasetSchema.parse(value),ids=new Set<string>();
  for(const value of data.cases){
    if(ids.has(value.caseId))throw Error('DUPLICATE_JUDGE_CASE_ID');
    ids.add(value.caseId);
  }
  return data;
}
export const loadJudgeDataset=(path:string)=>parseJudgeDataset(JSON.parse(readFileSync(path,'utf8')));

export function assertIndependentJudgeDatasets(dev:JudgeDataset,held:JudgeDataset){
  if(dev.split!=='dev'||held.split!=='held-out'||dev.version===held.version)throw Error('INVALID_JUDGE_DATASET_SPLIT');
  const ids=new Set(dev.cases.map(value=>value.caseId)),content=new Set(dev.cases.map(contentKey));
  for(const value of held.cases)if(ids.has(value.caseId)||content.has(contentKey(value)))throw Error('JUDGE_DATASET_CONTAMINATION');
}
