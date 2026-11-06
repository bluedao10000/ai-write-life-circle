import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {capabilities,categories,evaluationTaskSchema,type Category,type EvaluationTask} from './task-schema.js';

const schema=z.object({version:z.string().min(1),split:z.enum(['dev','held-out']),synthetic:z.literal(true),tasks:z.array(evaluationTaskSchema).min(1)}).strict();
export type EvaluationDataset=z.infer<typeof schema>;
export type EvaluationSplit={
 version:string;
 split:'dev'|'held-out';
 synthetic:true;
 datasetVersions:Partial<Record<Category,string>>;
 tasks:EvaluationTask[];
};

export function loadDataset(path:string){
 const data=schema.parse(JSON.parse(readFileSync(path,'utf8')));
 const ids=new Set<string>();
 for(const task of data.tasks){if(ids.has(task.taskId))throw Error('DUPLICATE_TASK_ID');ids.add(task.taskId)}
 return data;
}

/** Load one versioned dataset for each evaluation category in a split. */
export function loadEvaluationSplit(directory:string,split:'dev'|'held-out'):EvaluationSplit{
 const datasets=Object.fromEntries(categories.map(category=>{
  const dataset=loadDataset(join(directory,`${category}-${split}.json`));
  if(dataset.split!==split||dataset.tasks.some(task=>task.category!==category))throw Error('INVALID_CATEGORY_DATASET');
  return [category,dataset];
 })) as Record<Category,EvaluationDataset>;
 const versions=Object.values(datasets).map(dataset=>dataset.version);
 if(new Set(versions).size!==versions.length)throw Error('DUPLICATE_CATEGORY_DATASET_VERSION');
 const tasks=categories.flatMap(category=>datasets[category].tasks);
 const ids=new Set<string>();
 for(const task of tasks){if(ids.has(task.taskId))throw Error('DUPLICATE_TASK_ID');ids.add(task.taskId)}
 return {version:`agent-eval-${split}-composite-v1`,split,synthetic:true,datasetVersions:Object.fromEntries(categories.map(category=>[category,datasets[category].version])),tasks};
}

export function selectEvaluationDataset(data:EvaluationSplit,category?:Category):EvaluationSplit{
 if(!category)return data;
 const version=data.datasetVersions[category];
 if(!version)throw Error('MISSING_CATEGORY_DATASET');
 const tasks=data.tasks.filter(task=>task.category===category);
 if(!tasks.length)throw Error('EMPTY_CATEGORY_DATASET');
 return {version,split:data.split,synthetic:true,datasetVersions:{[category]:version},tasks};
}

/** Validate every category's dev/held-out pair and the combined coverage. */
export function assertIndependentDatasets(dev:EvaluationSplit,held:EvaluationSplit){
 if(dev.split!=='dev'||held.split!=='held-out')throw Error('INVALID_DATASET_SPLIT');
 const ids=new Set(dev.tasks.map(task=>task.taskId)),requests=new Set(dev.tasks.map(task=>task.request));
 for(const category of categories){
  const devVersion=dev.datasetVersions[category],heldVersion=held.datasetVersions[category];
  if(!devVersion||!heldVersion||devVersion===heldVersion)throw Error('INVALID_CATEGORY_DATASET_VERSION');
 }
 for(const task of held.tasks)if(ids.has(task.taskId)||requests.has(task.request))throw Error('DATASET_CONTAMINATION');
 for(const data of [dev,held]){
  if(categories.some(category=>!data.tasks.some(task=>task.category===category))||capabilities.some(capability=>!data.tasks.some(task=>task.capability===capability)))throw Error('INCOMPLETE_DATASET_COVERAGE');
 }
}
