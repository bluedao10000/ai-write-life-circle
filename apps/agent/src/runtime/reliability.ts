import type { ThinkingFailure, ThinkingRun } from "@writer-agent/contracts";

// Stable public classification; provider bodies and SDK stacks never cross this boundary.
export function failureFor(code: string, mayHaveIncurredCost: boolean): ThinkingFailure {
  let category: ThinkingFailure["code"] = "INTERNAL_ERROR";
  if (/TIMEOUT|DURATION_EXCEEDED/.test(code)) category = code.startsWith("TOOL") ? "TOOL_TIMEOUT" : "PROVIDER_TIMEOUT";
  else if (/RATE_LIMITED/.test(code)) category = "RATE_LIMITED";
  else if (/CONTEXT_OVERFLOW|INPUT_BUDGET_EXCEEDED/.test(code)) category = "CONTEXT_OVERFLOW";
  else if (/TOOL_/.test(code) && !/BUDGET/.test(code)) category = "TOOL_EXECUTION_FAILED";
  else if (/AUTHORIZATION|SCOPE_FORBIDDEN|GRANT_MISMATCH/.test(code)) category = "AUTHORIZATION_REQUIRED";
  else if (/SESSION_EXPIRED|SESSION_HISTORY_LIMIT/.test(code)) category = "SESSION_EXPIRED";
  else if (/BUDGET_EXCEEDED/.test(code)) category = "BUDGET_EXCEEDED";
  else if (/RESTARTED|INTERRUPTED|CANCELLED/.test(code)) category = "SESSION_INTERRUPTED";
  else if (/MODEL_UNAVAILABLE|MODEL_REAUTHORIZATION_REQUIRED|MODEL_CONFIGURATION_ERROR/.test(code)) category = "MODEL_CONFIGURATION_ERROR";
  else if (/PROVIDER_UNAVAILABLE|MODEL_REQUEST_FAILED|MODEL_EMPTY_RESPONSE|MODEL_OUTPUT_INCOMPLETE/.test(code)) category = "PROVIDER_UNAVAILABLE";
  const action: ThinkingFailure["userAction"] = category === "CONTEXT_OVERFLOW" ? "provide_context" : category === "AUTHORIZATION_REQUIRED" || category === "MODEL_CONFIGURATION_ERROR" ? "reauthorize" : category === "BUDGET_EXCEEDED" || category === "SESSION_EXPIRED" ? "new_session" : category === "INTERNAL_ERROR" ? "contact_support" : category === "SESSION_INTERRUPTED" ? "continue" : "retry";
  const messages: Record<ThinkingFailure["code"], string> = {
    PROVIDER_TIMEOUT: "模型回复超时，已收到的内容已保留。",
    PROVIDER_UNAVAILABLE: "模型暂时无法完成回复，对话已保留。",
    RATE_LIMITED: "模型请求较多，请稍后重试。",
    CONTEXT_OVERFLOW: "讨论内容超过本轮容量。请确认续谈要点后继续，完整历史仍然保留。",
    TOOL_TIMEOUT: "读取资料超时，本轮已停止。",
    TOOL_EXECUTION_FAILED: "本轮资料读取未完成，已保留对话。",
    SESSION_INTERRUPTED: "执行已中断，对话已保留，可以继续。",
    SESSION_EXPIRED: "本次讨论已达存储上限，请新开话题并带上续谈要点。",
    AUTHORIZATION_REQUIRED: "资料授权已变化，请确认 AI 资料范围后继续。",
    MODEL_CONFIGURATION_ERROR: "原模型配置已变化，请重新确认模型；不会自动切换。",
    BUDGET_EXCEEDED: "本轮或会话预算已达上限，请缩小问题范围或新开话题。",
    INTERNAL_ERROR: "这轮执行未完成，请保留追踪编号以便排查。",
  };
  return {code:category, retryable:["retry", "continue", "provide_context"].includes(action), autoRecoverable:false, userAction:action, contextRetained:true, mayHaveIncurredCost, retryMayIncurCost:true, message:messages[category]};
}

const counters = {completed:0,failed:0,interrupted:0,cancelled:0,resumed:0,modelCalls:0,durationMs:0};
export const reliabilityMetrics = () => ({...counters});
export function traceRun(sessionId: string, run: ThinkingRun, tokens: {input:number;output:number;charged:number;incomplete:boolean}) {
  if (["completed","failed","interrupted","cancelled"].includes(run.status)) {
    counters[run.status as "completed"|"failed"|"interrupted"|"cancelled"]++;
    counters.resumed += Number(run.attempt>1);counters.modelCalls += run.modelCalls;counters.durationMs += run.durationMs;
  }
  console.log(JSON.stringify({event:"agent_run",session_id:sessionId,run_id:run.runId,trace_id:run.traceId,provider:run.provider,model:run.model,run_status:run.status,step_type:run.stepType,duration:run.durationMs,token_usage:tokens,retry_count:run.retryCount,checkpoint_id:run.checkpointId,error_code:run.failure?.code??null}));
}
