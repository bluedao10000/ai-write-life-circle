import {grade} from './graders.js';
import {aggregate} from './metrics.js';
import type {EvaluationTask,Observation} from './task-schema.js';
export class EvaluationFailure extends Error {constructor(readonly observation:Observation){super('EVAL_EXECUTION_FAILED')}}
export type Executor=(task:EvaluationTask,signal:AbortSignal)=>Promise<Observation>;
export async function runEvaluation(tasks:EvaluationTask[],execute:Executor,signal?:AbortSignal){
 const results=[];
 for(const task of tasks){
  signal?.throwIfAborted();const started=performance.now(),abort=new AbortController(),timeout=setTimeout(()=>abort.abort(Error('EVAL_TIMEOUT')),task.stoppingCriteria.timeoutMs);
  const cancel=()=>abort.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});
  let observation:Observation|undefined;
  try{
   observation=await execute(task,abort.signal);abort.signal.throwIfAborted();
   const limits=task.stoppingCriteria;
   const exposure=observation.budgetExposure;
   const unknownCovered=exposure?.authority==='go'&&Number.isSafeInteger(exposure.tokens)&&exposure.tokens>0&&exposure.tokens<=limits.maxTokens;
   const withinBudget=observation.modelCalls<=limits.maxModelCalls&&observation.toolCalls<=limits.maxToolCalls&&(observation.chargedTokens===null?(observation.modelCalls===0||unknownCovered):observation.chargedTokens<=limits.maxTokens);
   const scored=grade(task,observation);
   results.push({taskId:task.taskId,category:task.category,capability:task.capability,passed:scored.passed&&withinBudget,withinBudget,grade:scored,observation,durationMs:performance.now()-started});
  }catch(error){if(error instanceof EvaluationFailure)observation=error.observation;results.push({taskId:task.taskId,category:task.category,capability:task.capability,passed:false,error:abort.signal.aborted?'EVAL_CANCELLED_OR_TIMEOUT':'EVAL_EXECUTION_FAILED',observation,durationMs:performance.now()-started})}
  finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel)}
 }
 return {results,metrics:aggregate(results)};
}
