import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {capabilities,categories,evaluationTaskSchema,type Category} from './task-schema.js';
const schema=z.object({version:z.string().min(1),split:z.enum(['dev','held-out']),synthetic:z.literal(true),tasks:z.array(evaluationTaskSchema).min(1)}).strict();
export function loadDataset(path:string,category?:Category){
 const data=schema.parse(JSON.parse(readFileSync(path,'utf8')));
 const ids=new Set<string>();for(const task of data.tasks){if(ids.has(task.taskId))throw Error('DUPLICATE_TASK_ID');ids.add(task.taskId)}
 return {...data,tasks:data.tasks.filter(task=>!category||task.category===category)};
}
export function assertIndependentDatasets(dev:ReturnType<typeof loadDataset>,held:ReturnType<typeof loadDataset>){
 if(dev.split!=='dev'||held.split!=='held-out')throw Error('INVALID_DATASET_SPLIT');
 const requests=new Set(dev.tasks.map(t=>t.request));const ids=new Set(dev.tasks.map(t=>t.taskId));
 for(const task of held.tasks)if(ids.has(task.taskId)||requests.has(task.request))throw Error('DATASET_CONTAMINATION');
 for(const data of [dev,held]){
  if(categories.some(category=>!data.tasks.some(task=>task.category===category))||capabilities.some(capability=>!data.tasks.some(task=>task.capability===capability)))throw Error('INCOMPLETE_DATASET_COVERAGE');
 }
}
