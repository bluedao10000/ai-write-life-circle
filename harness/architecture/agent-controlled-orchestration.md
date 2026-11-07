# ADR：受控角色编排与规划

日期：2026-11-07。状态：同预算只读多角色试点、配对工程评测与单消息有界只读自主执行已接入，均默认关闭，尚未部署。

试点为 Creative 研究与计划检查。复用 Go AgentTask 的任务权威与 Pi Worker，不增加另一条领取队列。Planner、Researcher、Analyst、Critic、Coordinator 是登记逻辑角色，默认保留单 Agent；作者可在作品级设置中显式开启只读五角色模式。

父任务记录有限有向无环计划：目标、完成条件、最大步骤/深度/子任务、deadline、调用/token/tool预算、工具集合与副作用级别。子任务引用 parentTaskId 和既有 inputHash，scope、资源、期限、任务种类只能收窄；不传父 Capability 或完整凭证。

第一版仅并行只读子任务。候选汇总保持来源和冲突，不能以多数投票确认事实。写入通过作者审批和现有 Go 业务路径，正式提交使用原业务幂等键。协调输出不形成第三套任务权威。

子预算在父权威事务内预分配；保留协调与最终回答额度，不在子任务失败时退还未知模型消耗。取消传播至所有子任务和网络请求；完成提交仍由 Go 再查授权、期限和栅栏。重启不自动重新付费，只有经确认的新 attempt 可以恢复未完成工作。

试点评测使用独立版本的开发集与保留集，在相同保存版本、Provider/Model、deadline和父预算下对照单/多角色；报告确定性结果、失败、token、调用、预留与延迟。计划核对使用专用pairwise rubric，候选顺序随机化，人工双评按数据集与rubric版本绑定。缺少可用模型输出或双评时质量字段为`null`；合成Provider只提供工程证据。

Phase 6 仅在前五阶段通过后接入有界计划调整。模型不能提高预算、权限、步数或审批期限。变更操作输入/目标/版本必须重新审批；无完成条件的计划拒绝执行。

## 已接入的只读计划核对

Go在现有Creative `plan_check` Job上记录`creative-plan-check-readonly-v1`和输出合同`creative-plan-check-candidates-v2`，仍使用原领取队列、租约、任务回执和Divergence提交路径。五角色任务的父预留沿用单角色每任务上限。Pi将该父预算分成五个互不重叠的子预算，Coordinator获得整数余数，五项之和精确等于父额。Go的每日预算准入、累计预留与设置展示按同一父额计算。单角色设置继续使用`creative-plan-check-v1`与`creative-plan_check-candidates-v1`，行为不变。

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

五角色共用一份usage账本。任一已发送请求没有返回usage时，编排器把父调用的usage标为未知，不将其他角色的部分值作为完整成本交给Go；Go继续保留整笔父预留并标记`UsageIncomplete`。这条规则覆盖并行角色部分成功、Provider HTTP失败、超时和取消，不因已获得部分usage而少计未知费用。

v2输出合同同时是混部栅栏：旧Worker不识别该版本时会在调用模型前拒绝领取，而不是把五角色任务静默降级为单角色。单角色响应继续省略`modelCalls`，保持旧Go与新Worker兼容；五角色成功响应必须报告5次调用。生产升级先部署兼容单角色的Worker，再部署Go并保持试点关闭；确认Worker合同后启用试点。回滚先关闭试点并等待在途任务结束，再替换进程。

## 早期只读试点验收

早期跨进程验收使用真实 Go API、Pi Thinking、Pi Worker 与本地合成 Provider，验证单/多角色处理同一章节、五个逻辑角色各调用一次、最终Divergence经原Go路径提交、治理事件先于模型请求，且正文、计划未变化。该阶段的报告用于固定执行合同与治理边界，当前预算策略与配对报告见下节。

Agent 治理/编排定向测试覆盖角色集合、预算总和、越权 planId、隐藏 usage、并行失败取消和空 scope/无工具策略。真实跨进程测试使用合成 Provider，没有付费请求。Go私有任务指标从原准入与终态回执派生各角色Admissions、Results、Usage和耗时P50/P95，同时为五种Worker任务类型投影生命周期计数和claimed→started、started→terminal耗时；它不新增指标账本，也不会把没有终态结果的准入算作完成。

开发可靠性与保留集还覆盖Provider在并行阶段失败：Coordinator未运行，无Divergence或业务写入，且没有自动重试；未知usage保留该次Go父预留。真实模型下的同预算质量差异、代表性延迟、货币成本、冲突处理能力及任务泛化仍未测量，因此试点保持默认关闭。考虑默认启用前还需具备独立模型输出、有效人工双评、无安全与可靠性回退，以及可接受的成本和延迟证据。

## 同预算计划核对对照

每次单角色与五角色核对都从Go取得同额父预留；五个角色的准入上限合计精确等于该父额。配对器验证case、保存Revision和Content Hash、inputHash、Provider/Model、deadline策略与预留额一致；未完成、工具/写入非零、缺失角色、预算和不符或确定性失败的结果不计入语义判断。Go仍持有任务和业务结果权威，Pi Worker保持只读、零scope、零工具。

`creative-plan-check-dev-v1`与`creative-plan-check-held-out-v1`各有3个互不重叠的合成案例。专用pairwise Judge使用固定`creative-plan-check-pairwise-v1` rubric和本地受治理Provider；候选顺序与映射记录在本地报告。人工标签绑定数据集、case和rubric版本，重复reviewer/case及不合格配对会被拒绝。当前报告没有真人双评和真实模型输出，所有语义质量字段保持`null`；合成Judge只验证治理、预算与结果映射。

报告写入`.local/evals/agent/creative-plan-{split}.json`，记录Go Job的预留、usage、调用、任务/角色延迟、确定性资格、Judge单独的预留与usage，以及runtime、提示、schema、dataset和rubric版本。货币成本没有Provider价目依据时保持`null`。开发与保留集通过不证明真实模型质量收益，也不作为生产SLO。

### 并发准入与子上下文收窄

真实跨进程样本读取任务API代理的重叠窗口：Researcher、Analyst、Critic的started请求最大并发为3，随后与Planner、Coordinator共同形成五个唯一准入。Go持久化的五个child预算为父预留等分后的整数额度，Coordinator接收余数，合计精确等于与单角色相同的父预留。混入的扩大预算、重复序号、外来parent或未登记角色均在写入前拒绝；合法并行请求不因到达顺序改变callIndex或预算。

Agent统一从父`ExecutionContext`派生子上下文，强制同任务、trace、授权版本与executor epoch，executionId独立，scope、deadline和三类预算只能收窄。同预算对照每组仍执行1次单角色和5次五角色模型调用，所有模型请求、工具和业务写入均保持只读。该证据覆盖固定只读试点中的并发预算竞争和权限传播，不证明允许模型动态创建角色。真实模型的并发质量收益、角色冲突裁决和代表性成本仍未测量。

## 有界只读自主执行

Phase 6 第一版接在现有Thinking Session和Pi Durable内，不创建新队列、Agent进程、计划服务或第三套任务状态。作者逐消息填写目标、完成条件和最多步骤，并显式批准只读工具；计划、每步状态与完成记录保存在原消息checkpoint。Go继续持有作者身份、scope、模型、费用预留、期限和当前授权，Pi只执行受治理的计划内只读工具。

模型必须先提交与原目标、完成条件一致的计划，之后每个证据调用必须引用计划中的唯一步骤。计划不得改变工具集合、scope、预算、期限或创建子任务。正文/故事写入、组织请求和Canon能力在该模式中根本不可用。最后必须提交`complete`或`needs_input`；缺少完成记录的回答失败，不把省略当作成功。

单消息步骤上限同时受固定8步、模型工具额度和模型轮次约束，为`min(8, maxToolCalls, maxTurnsPerRequest - 3)`。后三次轮次分别保留给计划、完成记录和最终回答；工具额度只由计划内证据调用消耗。额度到达上限后仅保留完成工具，允许模型安全收口。

取消、期限、授权撤销、Provider/工具失败和重启沿用原Thinking语义。SIGKILL不会自动产生新付费attempt；显式Resume恢复同一计划、授权版本和上限。完成工具的证据与原checkpoint一同保留，Resume复用已成功读取的结果，不重复业务工具；已完成或进入`needs_input`的计划会被封印，不能再继续读取。Resume及其同一幂等键重放只承接原消息，不进入Creative intake，也不会创建自动整理任务。

本地工程回归覆盖11项Agent自主行为测试、Go admission/intake幂等/legacy projection测试和真实Go/Pi进程。真实流程验证计划先于读取、当前授权调用、只读payload、完成投影、重启中断与显式Resume、零业务写入；完整Agent188/188、Web294加Worker25项及Go全量race通过。模型均由localhost合成Provider提供，真实模型规划质量、错误计划率、长期成本和大量Book上下文表现仍未测，因此该能力保持默认关闭。
