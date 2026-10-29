import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThinkingRun } from "@writer-agent/contracts";
import RunRecovery from "../features/thinking/RunRecovery";
const run:ThinkingRun={runId:"a",traceId:"trace-synthetic",messageId:"m",status:"interrupted",stepType:"provider",checkpointId:"c",epoch:1,attempt:1,retryCount:0,modelCalls:1,resumable:true,provider:"fixture",model:"fixture",startedAt:"now",updatedAt:"now",durationMs:1,failure:{code:"SESSION_INTERRUPTED",retryable:true,autoRecoverable:false,userAction:"continue",contextRetained:true,mayHaveIncurredCost:true,retryMayIncurCost:true,message:"执行中断，对话已保留。"}};
afterEach(cleanup);
it("requires explicit cost confirmation and sends the actual run recovery intent",()=>{
 const resume=vi.fn();render(<RunRecovery run={run} busy={false} onResume={resume}/>);
 const button=screen.getByRole("button",{name:"继续执行"});expect(button).toBeDisabled();
 fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(button);
 expect(resume).toHaveBeenCalledWith({runId:"a",confirmAdditionalCost:true});
 expect(screen.getByText(/上次请求可能已产生费用/)).toBeVisible();
 fireEvent.click(screen.getByText("故障详情"));expect(screen.getByText(/trace-synthetic/)).toBeVisible();
});
it("context overflow requires author-confirmed continuation context",()=>{
 const resume=vi.fn();render(<RunRecovery run={{...run,failure:{...run.failure!,code:"CONTEXT_OVERFLOW",userAction:"provide_context"}}} busy={false} onResume={resume}/>);
 fireEvent.click(screen.getByRole("checkbox"));expect(screen.getByRole("button",{name:"继续执行"})).toBeDisabled();
 fireEvent.change(screen.getByLabelText("续谈要点"),{target:{value:"author approved source:1; suggestion remains uncertain"}});
 fireEvent.click(screen.getByRole("button",{name:"继续执行"}));
 expect(resume.mock.calls[0][0].continuationContext).toContain("source:1");
});
it("cancelled and unsafe runs have no recovery button",()=>{
 const {rerender}=render(<RunRecovery run={{...run,status:"cancelled",resumable:false}} busy={false} onResume={vi.fn()}/>);
 expect(screen.queryByRole("button")).toBeNull();expect(screen.getByText(/当前任务已取消/)).toBeVisible();
 rerender(<RunRecovery run={{...run,resumable:false}} busy={false} onResume={vi.fn()}/>);
 expect(screen.queryByRole("button")).toBeNull();expect(screen.getByText(/不能安全重放/)).toBeVisible();
});
it("authorization recovery invokes the real settings action supplied by the workspace",()=>{
 const authorize=vi.fn();render(<RunRecovery run={{...run,failure:{...run.failure!,retryable:false,code:"AUTHORIZATION_REQUIRED",userAction:"reauthorize"}}} busy={false} onResume={vi.fn()} onAuthorize={authorize}/>);
 fireEvent.click(screen.getByRole("button",{name:"重新确认授权"}));expect(authorize).toHaveBeenCalledOnce();
});
