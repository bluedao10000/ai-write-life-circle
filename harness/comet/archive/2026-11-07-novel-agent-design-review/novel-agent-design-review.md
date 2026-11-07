# 小说助手 Agent 架构与模块设计结论

日期：2026-11-07  
调研范围：`apps/agent`、与 Agent 直接相关的 Go 权威服务、共享契约，以及 `harness/architecture` 中已生效的 ADR。  
结论状态：架构评审，不改变产品行为、运行协议或持久格式。

## 1. 结论

当前架构适合本项目定义的**作者主导、单作者、可追溯、AI 辅助**小说工作台：作者保存正文并作最终决定；Go 持有身份、授权、预算、任务和正式提交权威；Pi Thinking 负责作者主动对话和受控工具循环；Pi Worker 负责有界后台模型任务；Pi Durable 保存 Thinking 的可恢复执行状态。这个边界合理，现有模块可以继续承载设定管理、计划核对、一致性检查、长对话上下文、反馈修订和受控编排。

它还不是一个能够自主规划并持续写完小说的通用“小说 Agent 平台”。章节正文生成和小说文风生成属于当前 ADR 的明确非目标；长全书语义一致性、跨章节多跳推理、真实模型质量与成本收益也还没有代表性证据。因此结论是：

- **对当前产品方向：合理，可继续演进。**
- **对“由 Agent 自动生成并管理整部小说”的目标：不合理且证据不足，需要先改变产品边界，不能只增加 Prompt 或角色。**

## 2. 目标场景与原则

目标用户是单作者。作者提供创作意图，在写作工作台保存章节 Revision，Agent 从作者授权的来源中检索证据、提出问题、整理候选，并把结果交回作者审核。

数据流是：

```text
作者正文与决定
  -> Go 保存 Revision / Creative Asset / 正式业务状态
  -> Pi Thinking 或 Pi Worker 执行受治理模型调用
  -> 候选、观察、差异或讨论记忆
  -> 作者审核
  -> Go 正式提交
```

这条链路由 `harness/architecture/architecture.md` 规定“正文由作者书写”，并由 `harness/architecture/pi-unified-agent-runtime.md` 将职责拆到 Go API、Pi Thinking 和 Pi Worker 三个进程。任何能力扩展都必须保留“正文未授权修改 0 次、正式设定未确认写入 0 次、已核验引用可追溯率 100%”的硬指标。

## 3. 七项小说能力成熟度

成熟度只表示当前证据覆盖程度，不作为文件数量或功能宣称。“已验证”指当前开发/保留集的工程合同通过；“部分覆盖”指已有真实执行路径，但仍有产品能力或质量证据缺口；“未实现”指没有可交付的产品能力。

| 能力 | 成熟度 | 当前实现 | 结论边界 | 主要出处 |
| --- | --- | --- | --- | --- |
| 设定管理 | 部分覆盖 | Creative Asset 区分创作意图、人物、世界规则、计划等；提案、版本、接受/拒绝、显式替代和来源证据由 Go 管理 | 工程生命周期已验证；开放世界设定、复杂语义冲突和真实模型整理质量未验证 | `apps/api-go/internal/creative/model.go`、`assets.go`、`decisions.go`；`harness/architecture/agent-memory-architecture.md` |
| 情节规划 | 部分覆盖 | 计划作为 Asset 保存；可对一章已保存 Revision 与已接受计划做只读偏离检查；作者决定处理方式 | 有一章级计划核对，没有跨章路线规划、目标拆解和自动剧情决策 | `apps/api-go/internal/creative/plancheck.go`；`apps/agent/src/agents/creative/orchestrator.ts`；`harness/architecture/agent-controlled-orchestration.md` |
| 角色与世界观一致性 | 部分覆盖 | Knowledge 观察、Review 的人物/时间线检查、Creative 计划核对和 `retrieve_memory` 能带来源地辅助判断 | 已有证据驱动检查，尚不能证明全书范围内的完整人物关系、世界规则和时间线一致性 | `apps/agent/src/agents/knowledge/`、`apps/agent/src/agents/review/`、`apps/agent/src/tools/registry.ts`、`harness/architecture/agent-memory-architecture.md` |
| 长文本上下文 | 部分覆盖 | 讨论历史可压缩为带消息来源的 Working Memory；章节与记忆读取有界；每轮只重放有效讨论，不重放旧工具记录 | 有 45 轮 Pi 真实上下文回归和全书检索工具，但没有整部长篇多跳推理、跨章规模质量或代表延迟证据 | `apps/agent/src/runtime/context-management.ts`、`apps/agent/src/memory/working-memory.ts`、`harness/architecture/agent-context-management.md` |
| 章节生成 | 未实现 | 可生成计划、提案、计划与正文偏离报告、评论、知识候选和讨论记忆等结构化产物 | 当前 ADR 明确不自动发布章节或决定剧情；“章节生成”不能解释为 AI 自动代写并提交正文 | `harness/architecture/architecture.md`；`apps/api-go/internal/creative/plancheck.go` |
| 风格控制 | 未实现 | `RAS-001` 约束 Thinking 的**回复风格**；它能减少套话并控制建议表达 | 这不是小说正文文风控制；不存在作者文风画像、正文风格生成或自动演化闭环 | `apps/agent/src/agents/thinking/reply-style.generated.ts`；`harness/architecture/agent-reply-style.md`；`harness/architecture/architecture.md` |
| 反馈修订 | 部分覆盖 | Review feedback 区分有用、误报、有意和忽略；Creative 提案可接受/拒绝，计划偏离可由作者标记处理；经验候选需独立证据和确认 | 反馈能驱动候选状态和后续检索，尚无语义学习、跨任务稳定改进或真实修正质量评测 | `packages/contracts/src/reviews.ts`；`apps/api-go/internal/creative/decisions.go`、`plancheck.go`；`harness/architecture/agent-memory-architecture.md` |

这里的“章节相关结构化生成物”是本报告对“章节生成”的项目内解释。它证明系统能帮助准备和检查一章，不证明系统能替作者产出正文。

## 4. Agent 子项目结构

### 4.1 进程与顶层目录

```text
apps/agent
  src/
    agents/         领域 Prompt、Schema、执行器和 Creative 编排
    evaluation/     数据集、评分器、Judge、报告与故障适配
    memory/         Working Memory
    observability/  Runtime 健康与诊断投影
    runtime/        Pi Durable、Model Gateway、上下文、治理与可靠性
    server/         Thinking HTTP / SSE 接口
    sessions/       会话、Durable 文档、事件投影和分层存储
    tools/          Thinking 工具注册及 Go RPC 客户端
    worker/         Worker 配置、领取、调度和 Task API 客户端
    config.ts       Thinking 配置
    main.ts         Pi Thinking 入口
  test/             Agent 单元、真实 SDK、故障和治理测试
```

### 4.2 模块职责

| 模块 | 职责 | 不应承担 |
| --- | --- | --- |
| `agents/` | 各领域的提示、严格输出 Schema 和领域执行入口；Creative 只读五角色编排也在这里 | 作者身份、正式状态、费用结算或任意写正文 |
| `runtime/governance/` | 登记角色版本、执行上下文、子上下文收窄、Model/Tool Gate 和审计元数据 | 第二套任务、预算或授权账本 |
| `runtime/model-gateway.ts` | 校验模型合同、处理最终 payload、预留、网络限制、Usage 和取消 | 在 Pi 内重新决定业务重试 |
| `runtime/pi-host.ts` | Thinking Session/Run 执行、工具循环、上下文、计费检查点和恢复 | 后台任务领取或 Canon 提交 |
| `runtime/context-management.ts` | 长讨论压缩、摘要预算和有效历史选择 | 把摘要变成正式设定或授权来源 |
| `sessions/` | Pi Durable 状态、分层事件存储、投影、删除墓碑与本会话运行指标 | 独立确认业务事实 |
| `tools/` | 声明受 scope 限制的 Story Tool，经 Tool Gateway 后调用 Go RPC | 接受 `bookId`、`authorId`、路径或扩大权限 |
| `worker/` | 领取 Go AgentTask，校验合同，持久 started/heartbeat，执行并回报候选 | 读取 Go 状态目录、正文库或 Thinking 会话 |
| `memory/` | 维护讨论记忆及消息来源 | 长期 Semantic/Episodic/Procedural 事实权威 |
| `evaluation/` | 数据集、确定性评分、Judge、人工校准入口和报告 | 用合成结果宣称真实模型质量 |
| `observability/` | 将现有持久状态投影为健康、诊断和有限标签指标 | 新指标数据库或自报成功 |

### 4.3 Thinking 调用链

```text
Go 创建受 capability 约束的 Session
  -> Pi Thinking /internal session/run
  -> PiHost 接受消息并写原 Durable checkpoint
  -> 生成有效讨论上下文与 Working Memory
  -> 可选 Tool 调用：Tool Gateway
       -> Go 重新校验作者、作品、scope、授权版本
       -> Creative / Knowledge / Chapter / Notes 原业务状态
  -> Model Gateway：最终 payload -> 授权 -> 费用预留 -> Provider
  -> Usage 与终态写回同一 Store 检查点
  -> SSE/历史投影
```

入口位于 `apps/agent/src/main.ts` 和 `apps/agent/src/server/http.ts`；执行主体是 `runtime/pi-host.ts`；持久任务由 `runtime/durable.ts` 定义。Go 在 `apps/api-go/internal/thinking/` 仍持有 Session、Billing、授权和工具业务规则。

### 4.4 Worker 调用链

```text
Go 领域服务创建 AgentTask 并预留预算
  -> Pi Worker 校验公共配置、Prompt/Schema 合同和任务种类
  -> Model Gateway 生成最终 payload
  -> Go started：重新检查任务租约/执行器并写入 started 回执；适用的业务计费授权也在此准入
       -> Creative 五角色另带 modelStep：Go 核验已登记角色、父任务、子预算和调用序号
  -> heartbeat -> Provider
  -> Go complete/fail：重新校验 lease、Revision、取消和 epoch
  -> Go 解析候选并提交业务状态
```

入口和调度在 `apps/agent/src/worker/main.ts`、`scheduler.ts`、`dispatcher.ts` 和 `task-client.ts`。普通 Review、Knowledge、Creative、Memory 任务通过任务级 `started` 准入；Go 复查原任务栅栏、适用的业务计费授权，并保存 started 回执。只有 Creative 五角色步骤会额外发送 `modelStep`，由 Go 核验登记角色、父任务、子预算和调用序号（`apps/api-go/internal/agenttasks/model_step.go`）。Review、Knowledge、Creative、Memory 的候选解析分别在 `agents/*/executor.ts`；Creative 五角色由 `apps/agent/src/agents/creative/orchestrator.ts` 按固定有向图执行。Worker 不持有任意章节读取能力，模型只能看到 Go 准备的任务请求。

### 4.5 状态与记忆

状态分为四类：

1. Durable 执行状态：Pi `ThinkingState` 保存 checkpoint、Run/attempt、审计和模型请求账目；每 Session 一个 SQLite。
2. 事件投影状态：`sessions/event-store.ts` 和 `projection.ts` 从同一提交恢复历史、outbox 和健康状态。
3. 业务权威状态：Go 的 Revision、Creative 状态、Knowledge、Review、AgentTask、Billing 和幂等回执。
4. 记忆：讨论摘要属于 Working Memory；Semantic/Episodic/Procedural 是 Go 业务状态的带来源投影或经作者审核的新记录，不另建可独立确认 Canon 的 Pi 数据库。

这种分层避免把“运行状态”“事件历史”“业务事实”和“模型讨论记忆”混成一套状态机。来源删除、版本变化、取消、授权撤销和作品栅栏都会在读取或提交时重新核验。

### 4.6 扩展点与现有约束

可复用扩展点是 `runtime/governance/runtime.ts` 的角色注册、`ModelGateway`、`ToolGateway`、Go AgentTask、领域 executor、Evaluation task schema 和 Go 业务 API。新增领域应在这些合同内增加明确角色、工具策略、输出 Schema 和评测集。

现有约束包括：

- 模型调用必须有授权和预算预留；未知 Usage 保守保留费用，Pi 不自动重试付费请求。
- Tool 参数只引用当前作者/作品内的显式 ID；模型不能用参数扩大 scope。
- 每个 Thinking attempt 使用独立 Conversation；旧工具内容和跨作品上下文不自动进入下一轮。
- Worker 只处理 Go 已准备的固定输入，不能直接读正文库或 Thinking 会话。
- 子角色不创建第二任务权威；scope、期限和预算只能从父上下文收窄。
- 高风险写入经过作者决定和 Go 业务提交；LLM 输出始终是不可信候选。

## 5. 理想设计与当前架构逐项比较

| 能力 | 理想小说助手应具备 | 当前架构 | 判定 |
| --- | --- | --- | --- |
| 设定管理 | 有来源、版本、冲突、审核和可逆更新 | Creative Asset/Proposal/Version/Decision 已具备核心生命周期；Memory/Knowledge 提供来源投影 | **合理基础，复杂语义治理待补** |
| 情节规划 | 能在全局目标、卷章计划和正文之间保持一致，计划改变需作者决定 | 有一章计划与正文偏离检查；没有跨章规划协调 | **局部合理，全局规划未实现** |
| 角色/世界观一致性 | 跨章检索、关系图、时间线、矛盾解释和作者裁决 | Review、Knowledge、`retrieve_memory` 和只读计划核对已覆盖证据读取；真实规模与语义质量未知 | **方向合理，规模能力待验证** |
| 长文本上下文 | 全书索引、分层摘要、多跳检索和证据预算 | Working Memory、有效历史重建、有界工具和来源版本已实现 | **合理工程基础，整书推理待验证** |
| 章节生成 | 在作者边界内起草、改写或检查，并保证 Canon 不自动变化 | 明确不自动生成/发布正文；仅生成结构化辅助产物 | **与当前产品 ADR 一致；若产品目标变化需新 ADR** |
| 风格控制 | 可描述、可引用、可版本化的作者文风约束与审核 | 只有 Agent 回复风格；没有正文文风模型或自动演化 | **当前边界合理，正文风格未实现** |
| 反馈修订 | 反馈改变后续建议，可追溯、可撤销，并经过质量评测 | Review/Creative 反馈与经验候选已进入原业务状态；语义学习和真实改进未验证 | **闭环基础合理，学习质量待补** |

总体判断：当前架构把高权限业务事实留在 Go，把有状态模型执行放在可恢复的 Pi，把后台模型调用放在隔离 Worker，并让全部候选回到作者审核。这比把正文、工具、费用和长期记忆交给一个 Agent 进程更符合单作者写作产品。它的不足主要在**跨章语义能力**与**真实模型质量证据**，不在基础权威划分。

## 6. 风险、能力缺口与可复用部分

### 6.1 风险

| 风险 | 后果 | 现有控制 | 出处 |
| --- | --- | --- | --- |
| 把模型候选误当 Canon | 未确认设定污染正文与后续推理 | Go 提案/确认/版本合同；Thinking Prompt 区分 proposals、plans、observations | `apps/api-go/internal/creative/decisions.go`；`apps/agent/src/agents/thinking/prompt.ts` |
| 摘要丢失或越权 | 长对话后事实遗漏，或摘要成为第二事实源 | Working Memory 绑定消息来源；摘要明确非可信、非 Canon | `apps/agent/src/memory/working-memory.ts`；`harness/architecture/agent-context-management.md` |
| 跨作品或跨作者读取 | 私有作品泄露 | capability、Go 资源所有权、scope、Tool Gateway、独立 Session | `apps/agent/src/runtime/governance/tool-gateway.ts`；`apps/api-go/internal/thinking/tools.go` |
| 未知费用或重复执行 | 作者被少计费，任务被重复提交 | Go started/complete、幂等回执、Durable attempt、未知 Usage 保留 | `apps/agent/src/worker/task-client.ts`；`harness/architecture/agent-reliability.md` |
| 多角色扩权或冲突被多数表决掩盖 | 幻觉经协调层固化 | 默认关闭、只读、固定五角色、子预算总和受父预算约束、Coordinator 仍由 Go 校验 | `apps/agent/src/agents/creative/orchestrator.ts`；`harness/architecture/agent-controlled-orchestration.md` |
| 合成评测被误报为真实质量 | 功能看似成熟但实际写作收益未知 | 报告区分工程通过、`realLLMCalled`、`qualityValidated` 和 null 指标 | `apps/agent/src/evaluation/report.ts`；`harness/architecture/agent-evaluation-platform.md` |
| 章节 Revision 在异步任务中变化 | 旧分析覆盖新正文 | 任务绑定 Revision/contentHash；Go 完成时重新检查并 fencing | `apps/api-go/internal/agenttasks/`；`apps/api-go/internal/creative/jobs.go` |

### 6.2 主要能力缺口

1. 缺少全书级计划协调：现有计划检查以单章 Revision 为单位，见 `apps/api-go/internal/creative/plancheck.go`。
2. 缺少跨章多跳语义检索和可解释关系推理：现有 `retrieve_memory` 有界聚合并保留来源，但没证明整书规模质量，见 `apps/agent/src/tools/registry.ts` 和 `agent-memory-architecture.md`。
3. 缺少正文生成与文风控制：这是 `harness/architecture/architecture.md` 的明确非目标。
4. 缺少真实模型的质量、冲突处理、成本与延迟收益证据：`harness/architecture/agent-evaluation-platform.md` 明确合成 Provider 只验证工程边界。
5. 缺少真实作者标注支持的长期记忆噪声控制、召回质量和泛化证据：`harness/architecture/agent-maturity-report.md` 保持了相应 null 指标。
6. 当前已实现的自主协作仅限 Creative 计划核对中的固定五角色只读流程；更广的计划调整或写入执行仍未实现，并被 ADR 设为 Phase 6 门槛，见 `apps/agent/src/agents/creative/orchestrator.ts`、`harness/architecture/agent-controlled-orchestration.md` 和 `harness/architecture/agent-maturity-report.md`。

### 6.3 可直接复用

- Go Creative Asset/Proposal/Version/Decision 继续作为设定、计划和审核基础，见 `apps/api-go/internal/creative/model.go`、`assets.go` 和 `decisions.go`。
- Go Revision、Knowledge、Review 和幂等回执继续作为章节事实与反馈来源，见 `apps/api-go/internal/application/revision.go`、`apps/api-go/internal/knowledge/service.go`、`apps/api-go/internal/review/service.go` 和 `apps/api-go/internal/agenttasks/service.go`。
- `runtime/governance`、ModelGateway 和 ToolGateway 继续作为所有新角色的统一入口，见 `apps/agent/src/runtime/governance/runtime.ts`、`apps/agent/src/runtime/model-gateway.ts` 和 `apps/agent/src/runtime/governance/tool-gateway.ts`。
- Pi Durable、Store 和事件投影继续承载 Thinking Run，不新增任务数据库，见 `apps/agent/src/runtime/durable.ts`、`apps/agent/src/sessions/store.ts`、`event-store.ts` 和 `projection.ts`。
- Worker TaskClient、AgentTask 合同和领域 executor 继续承载后台有界任务，见 `apps/agent/src/worker/task-client.ts`、`packages/contracts/src/agent-tasks.ts` 和 `apps/agent/src/worker/dispatcher.ts`。
- Evaluation dataset/split/runner/grader/report 继续承载公平对照与保留集验收，见 `apps/agent/src/evaluation/dataset.ts`、`task-schema.ts`、`runner.ts`、`graders.ts` 和 `report.ts`。
- Health/Metrics 继续从原业务状态投影，不维护第二指标事实，见 `apps/agent/src/observability/runtime-health.ts`、`apps/api-go/internal/agentruntime/health.go` 和 `metrics.go`。

## 7. 改善方向：影响、成本、优先级与验收

排序先考虑对作者结果的直接影响，再考虑对现有权威和进程边界的改动成本。方向都落在现有模块内，不要求新增外部框架或数据库。

| 优先级 | 方向 | 影响范围 | 改造成本 | 可验证验收标准 |
| --- | --- | --- | --- | --- |
| P0 | 建立真实作者任务的 dev/held-out 质量基线，覆盖设定整理、单章一致性、计划核对与反馈后修订 | 高 | 中 | 同一输入、模型和预算下有版本化报告；确定性指标与人工双评分离；无标注时质量为 null，不以合成通过替代 |
| P0 | 扩充章节级到全书级的来源检索评测，重点测迭代修订后的来源、版本失效和跨章召回 | 高 | 中 | 至少含多章同实体、改名、时间跳跃和作者拒绝误报样本；来源可追溯；删除/替换后零旧结果；质量指标由真实标注给出 |
| P1 | 在现有 Creative AgentTask 上增加只读的跨章计划检查，不增加第二调度器 | 高 | 中高 | 共用父预算和 deadline；零工具或显式只读工具策略；Revision 变化使结果失效；不能修改计划或正文；单/多角色在相同预算下有对照 |
| P1 | 把反馈闭环做成有来源的候选，而不是自动学习：反馈变化可影响下一次检索提示，但仍需作者确认 | 中高 | 中 | Review/Creative 反馈版本变化使旧建议失效；候选确认前不可检索；撤销后重启仍不可见；报告区分反馈采纳与质量提升 |
| P2 | 为长篇检索建立更明确的有限上下文预算和冲突汇总 | 中 | 中 | 固定字数/章数输入下返回来源、遗漏原因与冲突清单；无证据时明确不足；跨章 P50/P95、token 和工具调用有可复现基准 |
| P2 | 改进 Creative 只读多角色的冲突表达与来源合并，不引入多数投票事实确认 | 中 | 中低 | 每个角色引用来源；Coordinator 保留冲突；任何结论仍需作者审核；子预算不超父额；失败不自动重试 |
| P3 | 若产品决定允许正文起草或正文文风控制，先写新 ADR，再设计 Revision 级候选与作者接受流程 | 高 | 高 | 新 ADR 明确产品目标、确认/拒绝/撤销、版本迁移、模型与人工质量门槛；未确认候选无法修改 Canon；真实模型评测通过 |
| P3 | 扩展有界计划调整和步骤执行 | 高 | 高 | Goal、Plan、Budget、Deadline、Step Limit、Approval、Cancellation、Completion Criteria 均持久可审计；模型不能扩大预算、scope 或步骤；前序阶段质量门槛先通过 |

最先应做的是 P0 质量基线，而不是继续增加 Agent 角色。当前架构已经有足够的执行合同；没有真实任务证据时，增加角色只会扩大成本和未验证行为。

## 8. Assumptions

- 当前产品仍是单作者工作台，作者对剧情、正文、设定和最终提交拥有决定权。
- “小说助手”的核心价值包括检索、整理、追问、发现不一致和提供可审查候选，不等于自动代写。
- Go 继续是身份、授权、费用、任务和正式业务状态的唯一业务权威。
- Thinking 与 Worker 保持独立进程；统一的是合同、治理和可观测接口。
- 现有 Creative、Knowledge、Review、Memory 和 Evaluation 代码继续演进，不替换为新的 Agent 框架。
- 本地合成 Provider 的通过只证明工程合同，不能外推真实模型质量、成功率和生产 SLO。

## 9. To confirm

1. “章节生成”是否继续遵循现有非目标，只表示计划、提案、偏离报告和候选等结构化产物；若包含正文起草，需要新 ADR 和新验收。
2. “风格控制”是否只针对 Agent 回复风格；若包含正文文风，需要作者文风来源、版本、采样标准、作者确认和真实质量评测。
3. 长篇目标规模是“几十万字单书”还是更大；这会决定跨章检索与性能验收的数据规模。
4. 首要产品收益是减少设定维护成本、提高连续性发现率，还是增加正文产出；三者对应不同的下一阶段优先级。
5. 真实模型质量验收是否允许使用作者授权的生产脱敏样本；没有生产样本时只能建立工程基线和待标注集，不能宣称成熟。

## 10. 最终判断

现有 Agent 架构的合理部分是权威边界、失败语义、来源治理和扩展点；不成熟的部分是全书语义规模、真实写作质量、正文生成与文风、以及更高阶规划。继续演进应先补真实质量证据和跨章只读能力，再决定是否扩展多角色和自主执行。架构无需重做，但“完整小说 Agent”这一目标不能从当前 Phase 1–6 的工程接入直接推出。
