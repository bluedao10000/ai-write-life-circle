# ADR：受控角色编排与规划

日期：2026-11-05。状态：只读试点已接入，默认关闭，尚未部署。

试点为 Creative 研究与计划检查。复用 Go AgentTask 的任务权威与 Pi Worker，不增加另一条领取队列。Planner、Researcher、Analyst、Critic、Coordinator 是登记逻辑角色，默认保留单 Agent；作者可在作品级设置中显式开启只读五角色模式。

父任务记录有限有向无环计划：目标、完成条件、最大步骤/深度/子任务、deadline、调用/token/tool预算、工具集合与副作用级别。子任务引用 parentTaskId 和既有 inputHash，scope、资源、期限、任务种类只能收窄；不传父 Capability 或完整凭证。

第一版仅并行只读子任务。候选汇总保持来源和冲突，不能以多数投票确认事实。写入通过作者审批和现有 Go 业务路径，正式提交使用原业务幂等键。协调输出不形成第三套任务权威。

子预算在父权威事务内预分配；保留协调与最终回答额度，不在子任务失败时退还未知模型消耗。取消传播至所有子任务和网络请求；完成提交仍由 Go 再查授权、期限和栅栏。重启不自动重新付费，只有经确认的新 attempt 可以恢复未完成工作。

试点评测使用相同 held-out 请求、环境、模型与总预算对比单/多角色；报告质量、失败、token、协调成本与延迟，确定性结果和人工质量分别列出。无有效改善则保持单 Agent，不能用 mock 增益替代真实能力证据。

Phase 6 仅在前五阶段通过后接入有界计划调整。模型不能提高预算、权限、步数或审批期限。变更操作输入/目标/版本必须重新审批；无完成条件的计划拒绝执行。

## 已接入的只读计划核对

Go在现有Creative `plan_check` Job上记录`creative-plan-check-readonly-v1`和输出合同`creative-plan-check-candidates-v2`，仍使用原领取队列、租约、任务回执和Divergence提交路径。开启试点后，Go为一个父任务预留五次模型的完整上限；Pi将父预算分成五个互不重叠的子预算，总和不超出父额。单角色设置继续使用`creative-plan-check-v1`与`creative-plan_check-candidates-v1`，行为不变。

Pi 的固定执行顺序是：

```text
Planner
  |
  +-- Researcher --+
  +-- Analyst -----+-- Coordinator -> existing Go plan-check result
  +-- Critic ------+
```

五个角色都登记为 `tools: none`、空 scope，共享父 taskId、deadline、取消信号、模型与授权版本，但各自拥有独立 executionId、模型请求序号和审计角色。每次网络请求前仍调用原 Go started/heartbeat 核验；中间角色只能引用 Go 已绑定的 plan assetId，Coordinator 的最终 JSON 再由原 Go `buildPlan` 校验正文引文、计划版本和业务状态。模型不能创建子任务、扩大权限、改预算或提交正式内容。

三个并行检查角色中任一失败会取消其余本地请求；usage 缺失时停止后续调用。该策略的中断、暂停、过期或Worker重启进入 `failed`，不自动启动新的付费 attempt；作者需要重新发起一次核对。旧任务和单角色任务继续沿用原重试策略。

v2输出合同同时是混部栅栏：旧Worker不识别该版本时会在调用模型前拒绝领取，而不是把五角色任务静默降级为单角色。单角色响应继续省略`modelCalls`，保持旧Go与新Worker兼容；五角色成功响应必须报告5次调用。生产升级先部署兼容单角色的Worker，再部署Go并保持试点关闭；确认Worker合同后启用试点。回滚先关闭试点并等待在途任务结束，再替换进程。

## 试点验收与限制

真实 Go API、Pi Thinking、Pi Worker 与本地合成 Provider 的跨进程场景先执行一次单角色基线，再对同一章节和保存版本开启只读策略。实测五个角色各调用一次，Go 父任务预留大于单角色基线，持久任务完成；五组治理审计均带同一 parentTaskId，授权与预留先于模型开始，且没有工具事件。最终 Divergence 仍来自原 Go 业务提交，正文和计划版本均未变化。

Agent 治理/编排定向测试覆盖角色集合、预算总和、越权 planId、隐藏 usage、并行失败取消和空 scope/无工具策略。真实跨进程测试使用合成 Provider，没有付费请求。

当前证据只证明执行、预算和权限边界。单/多角色在同一真实模型与总预算下的质量差异、P95、token成本、冲突处理能力及 held-out 泛化仍未测量，因此试点默认关闭，不宣称多 Agent 已带来质量收益。达到以下条件后才考虑默认启用：同一数据集和总预算的对照评测有稳定质量收益；无新增越权或副作用；成本与延迟在可接受范围；人工审阅能解释协调结果且没有多数投票式事实确认。
