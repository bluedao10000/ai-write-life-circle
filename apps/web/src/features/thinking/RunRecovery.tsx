import type { ThinkingRecovery, ThinkingRun } from "@writer-agent/contracts";
import { Btn } from "../../components/vnext/ui";

export default function RunRecovery({run,busy,onResume,onAuthorize,continuationContext=""}:{continuationContext?:string;run?:ThinkingRun;busy:boolean;onResume:(input:ThinkingRecovery)=>void;onAuthorize?:()=>void}) {
  if (!run || !["failed","interrupted","cancelled"].includes(run.status)) return null;
  const f = run.failure;
  if (run.status === "cancelled") return <p role="status">当前任务已取消，收到的内容已保留。</p>;
  const needsContext = f?.code === "CONTEXT_OVERFLOW";
  return <div className="space-y-2 rounded border border-line p-3 text-ui-sm" role="status">
    <p>{f?.message ?? "执行中断，对话已保留。"}</p>
    {f?.code === "AUTHORIZATION_REQUIRED" && onAuthorize && <Btn disabled={busy} onClick={onAuthorize}>重新确认授权</Btn>}
    {f?.code === "MODEL_CONFIGURATION_ERROR" && <p>请在下方重新选择模型，再发送新问题。恢复操作不会切换模型。</p>}
    {f?.retryable && run.resumable && <>
      <Btn disabled={busy} onClick={()=>onResume({runId:run.runId,confirmAdditionalCost:true,...(continuationContext.trim()?{continuationContext:continuationContext.trim()}:{})})}>{run.status === "interrupted" || needsContext ? "继续回复" : "重新尝试"}</Btn>
      <p>重新尝试会再次请求原模型，按实际用量计入 AI 点数{f.mayHaveIncurredCost ? "；上次请求可能已计入" : ""}。</p>
    </>}
    {!run.resumable && <p>本轮曾进入不能安全重放的操作，请先检查其结果，再发送新问题。</p>}
    <details><summary>故障详情</summary><p>错误码：{f?.code ?? "SESSION_INTERRUPTED"} · 追踪编号：{run.traceId}</p></details>
  </div>;
}
