# ADR：统一 Runtime Governance

日期：2026-11-04。状态：设计，尚未接入生产执行。

## 合同与权威

新增 runtime/governance，按实际职责组合模块，不要求每个参考名称单独成文件。ExecutionContext 是从 Thinking Run 或 Go AgentTask 派生的不可变视图，包含 execution/run/task/parent 标识、角色、授权版本、资源、scope、预算上限、deadline、取消信号和 traceId。上下文不包含能力令牌或模型 Key；凭证由进程内适配器封装。

Registry 登记 Thinking、Review、Knowledge、Creative 的版本、工具集合、输出合同和策略。登记仅限制能力，不授予作者权限。Planner/Researcher/Analyst/Critic 在试点验收前不可选择。Worker 的 strategyVersion、outputSchemaVersion、inputHash、模型指纹直接复用 Go 合同。

## 模型入口

复用 runtime/model-gateway.ts 的 Models API、独立凭证、boundedModelFetch、usage 解析和错误分类。将 PiHost 的 streaming 治理拆成适配器，保留终态 usage 在交给 Durable 前落盘的顺序。

统一执行顺序：核验版本与取消 → 当前授权与执行栅栏 → 构造最终 payload → 校验输入/输出与策略 → 持久预留 → 允许网络发送 → 结算已知 usage 或保留未知费用 → 持久终态 → 发布。不得用 Promise 超时替代对真实网络调用的取消。

Thinking BudgetAdapter 复用 Saved.execution.modelRequests、usage 和 Store.write；Worker Adapter 复用 Go claim/started/heartbeat/complete/fail。Worker 仍每个领取任务只执行现有固定模型请求。Go 决定重试和正式点数，治理层不得补一个自动重试循环。并行子预算须在父权威事务内预分配，分配总额包含协调与最终回答，不得超过父额；崩溃后的未知消耗不得归还。

## 工具入口

复用 tools/registry.ts 的 TypeBox/Zod 参数、scope 映射、返回大小、5秒超时和 StoryWrites 回执。ToolPolicy 从注册定义派生风险、safe/unsafe、输入/输出上限、授权与幂等要求。授权检查必须发生在本地缓存命中和回执重放之前；safe 只表示重放策略。Go 继续验证作者/作品/消息来源与正式写入，作者 messageId 保持业务幂等身份。

已存在的作者同意与 Go 写入规则视为业务授权，不增设重复确认。新增高风险操作的审批绑定精确操作、资源、输入、授权版本和期限；任何变更均失效。

## 审计与健康

审计事件只接收白名单元数据：关联ID、已登记角色、动作、允许/拒绝、固定原因码、授权版本、时间与版本。禁止任意对象、正文、凭证和工具参数。重要审计随原业务检查点提交；stdout 日志不能替代持久事实。

版本分别记录 runtime、definition、prompt、tool schema、dataset、memory schema；不以 npm 版本代替。恢复必须检查原策略兼容、重新授权，不能静默换模型。

健康按现有进程聚合：活性表示进程响应；就绪表示存储、投影、授权/预算适配和注册合同可用；degraded 表示局部投影/Provider/Worker 故障。Provider 故障不等同数据损坏。指标标签只能使用受控角色、状态和原因码，关联ID仅进入受控 trace。

## 验收

用真实入口证明请求前预留、预留失败零网络请求、撤销后零工具执行、缓存重放也授权、取消后迟到结果被栅栏拒绝、未知 usage 不退款。保留现有 SIGKILL/outbox/迁移/Go 集成测试。静态入口扫描只用于发现绕过，不能替代运行验证。
