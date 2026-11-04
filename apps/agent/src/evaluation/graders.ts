import type {EvaluationTask,Observation} from './task-schema.js';
export function grade(task:EvaluationTask,observation:Observation){
 const check=(rule:EvaluationTask['scorer']['deterministic'][number])=>{
  const actual=observation.metrics[rule.metric];
  if(actual===undefined||actual===null)return {metric:rule.metric,actual:null,matched:false,measured:false};
  const matched=rule.operator==='eq'?actual===rule.value:typeof actual==='number'&&typeof rule.value==='number'&&(rule.operator==='gte'?actual>=rule.value:actual<=rule.value);
  return {metric:rule.metric,actual,matched,measured:true};
 };
 const expected=task.scorer.deterministic.map(check),forbidden=task.scorer.forbidden.map(check);
 return {passed:expected.every(r=>r.measured&&r.matched)&&forbidden.every(r=>r.measured&&!r.matched),expected,forbidden};
}
