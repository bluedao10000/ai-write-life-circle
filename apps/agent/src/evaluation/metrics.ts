export function percentile(values:number[],fraction:number){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]!}
export function aggregate(results:{passed:boolean;durationMs:number;observation?:{chargedTokens:number|null;modelCalls:number;toolCalls:number}}[]){
 const measured=results.filter(r=>r.observation?.chargedTokens!==undefined&&r.observation.chargedTokens!==null);
 const successful=measured.filter(r=>r.passed),failed=measured.filter(r=>!r.passed);
 return {tasks:results.length,passed:results.filter(r=>r.passed).length,engineeringPassRate:results.length?results.filter(r=>r.passed).length/results.length:null,qualitySuccessRate:null,
 p50Ms:percentile(results.map(r=>r.durationMs),.5),p95Ms:percentile(results.map(r=>r.durationMs),.95),tokenMeasuredTasks:measured.length,
 tokensPerSuccessfulTask:successful.length?successful.reduce((s,r)=>s+r.observation!.chargedTokens!,0)/successful.length:null,
 failedTaskTokens:failed.length?failed.reduce((s,r)=>s+r.observation!.chargedTokens!,0):null,currencyCost:null,
 unobservedTasks:results.filter(r=>!r.observation).length,modelCalls:results.every(r=>r.observation)?results.reduce((s,r)=>s+r.observation!.modelCalls,0):null,toolCalls:results.every(r=>r.observation)?results.reduce((s,r)=>s+r.observation!.toolCalls,0):null};
}
