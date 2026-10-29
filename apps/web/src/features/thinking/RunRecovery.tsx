import { useState } from "react";
import type { ThinkingRecovery, ThinkingRun } from "@writer-agent/contracts";
import { Btn } from "../../components/vnext/ui";

export default function RunRecovery({run,busy,onResume,onAuthorize}:{run?:ThinkingRun;busy:boolean;onResume:(input:ThinkingRecovery)=>void;onAuthorize?:()=>void}) {
  const [confirmed,setConfirmed] = useState(false),[context,setContext] = useState("");
  if (!run || !["failed","interrupted","cancelled"].includes(run.status)) return null;
  const f = run.failure;
  if (run.status === "cancelled") return <p role="status">当前任务已取消，收到的内容已保留。</p>;
  const needsContext = f?.userAction === "provide_context";
  return <div className="space-y-2 rounded border border-line p-3 text-ui-sm" role="status">
    <p>{f?.message ?? "执行中断，对话已保留。"}</p>
    {f?.code === "AUTHORIZATION_REQUIRED" && onAuthorize && <Btn disabled={busy} onClick={onAuthorize}>重新确认授权</Btn>}
    {f?.code === "MODEL_CONFIGURATION_ERROR" && <p>请在下方重新选择模型，再发送新问题。恢复操作不会切换模型。</p>}
    {f?.retryable && run.resumable && <>
      {needsContext && <label className="block">确认续谈要点（保留重要引用、已定事项和待定假设；模型将使用这些要点代替较早上下文，完整历史仍可查看）
        <textarea aria-label="续谈要点" value={context} onChange={e=>setContext(e.target.value)} maxLength={12000} className="block w-full border p-2"/>
      </label>}
      <label className="block"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 我确认再次调用本轮原模型（{run.provider} / {run.model}），可能产生额外费用。{f.mayHaveIncurredCost ? "上次请求可能已产生费用。" : ""}</label>
      <Btn disabled={busy || !confirmed || (needsContext && !context.trim())} onClick={()=>onResume({runId:run.runId,confirmAdditionalCost:true,...(context.trim()?{continuationContext:context.trim()}:{})})}>{run.status === "interrupted" || needsContext ? "继续执行" : "重试执行"}</Btn>
    </>}
    {!run.resumable && <p>本轮曾进入不能安全重放的操作，请先检查其结果，再发送新问题。</p>}
    <details><summary>故障详情</summary><p>错误码：{f?.code ?? "SESSION_INTERRUPTED"} · 追踪编号：{run.traceId}</p></details>
  </div>;
}
