# Agent Maturity：能力与验收证据

日期：2026-11-04。基线：`25e6066f519fdb4386bbbbe334edb48badbc5c03`。

Phase 0 已完成源码审计和架构设计；Phase 1 已完成本地代码接入和工程验收；Phase 2–6 尚未实现。成熟度采用“工程验证 / 部分覆盖 / 未实现”，不以文件数量打分。此前同基线的本地 `pnpm verify` 已通过，包含 102 项 Agent 测试和 Go/Pi 真实进程集成；不代表真实模型任务成功率或全部威胁已验证。远程最新状态未刷新：GitHub API 最近返回账号停用403，本次使用本地 main 与已有跟踪引用。

## 能力矩阵

| 能力 | 当前成熟度 | 实现与证据 | 缺口 / 下一步 |
| --- | --- | --- | --- |
| Durable执行 | 工程验证 | runtime/durable.ts、durable-crash/lifecycle测试；启动中断旧任务 | 治理生命周期映射，禁止自动付费恢复 |
| 分层存储 | 工程验证 | sessions/store/event-store/projection；layered-storage-crash测试、10万事件基准 | 统一健康、投影指标与诊断 |
| 预算 | 工程验证，分路径治理 | PiHost payload后预留与usage检查点；Go agenttasks started/complete；budget/turn-budget测试 | 统一适配；尚无父子预算分配 |
| 授权及工具 | 部分覆盖 | tools/registry、Go工具RPC、strict schema、scope、epoch及StoryWrites | 本地重放前授权、统一ToolPolicy与攻击集 |
| Worker | 工程验证 | scheduler/dispatcher/TaskClient，四种Go任务；Review/Knowledge/Creative集成 | 统一执行合同与关联审计 |
| 上下文 | 部分覆盖 | context-management、讨论摘要及来源重读；context-management测试 | 摘要并非长期已确认事实 |
| 长期记忆 | 部分领域覆盖 | Go creative决定/提案/资产，knowledge检索，讨论focus | 缺统一来源/过期/冲突/审核模型和召回评测 |
| Evaluation | 工程验证分散 | eval-thinking/reliability/knowledge/style，HTTP模型fixture | 缺统一schema、split、版本、五类指标；首批事件截断计数 |
| 安全 | 部分覆盖 | capability、隔离进程、工具授权、取消及幂等测试 | 缺独立红队数据、记忆污染、子角色扩权验证 |
| 可观测性 | 部分覆盖 | reliability.traceRun及内存计数；Worker有限任务日志 | 缺模型/工具关联、持久诊断、投影与未知费用指标 |
| 多角色协作 | 未实现 | 三领域Worker是任务执行器，不是协调层 | Creative只读试点，单/多角色同条件比较 |
| 自主规划 | 未实现 | 有限模型/工具循环与显式恢复 | 有界Goal/Plan与审批版本绑定，须后置 |

以上路径中 Agent 文件位于 `apps/agent/src`，测试位于 `apps/agent/test`；Go 文件位于 `apps/api-go/internal`。

## 架构差距与复用清单

1. `runtime/model-gateway.ts` 为 Worker 提供 completeSimple；Thinking 用 configuredModel 后在 PiHost 包装 streamSimple，Discussion Compaction 也走该包装。共享 Provider 适配已经存在，但统一治理合同尚不存在。保留这条 streaming 的原检查点语义再提取，不能换成另一套预算。
2. `worker/scheduler.ts` 先 validateTask，再持久 started，随后 heartbeat 和 execute；Go 决定结果提交和重试。Budget/Authorization适配器应调用这一权威协议，不能以本地 started boolean替代。
3. `tools/registry.ts` 的 onCall 持久计数与栅栏，Go RPC校验授权；命中本地 StoryWrites回执则直接返回，受控 analysis skill也为本地执行。统一Gateway要覆盖这些分支，不能只包fetch。
4. `ThinkingState` 与 EventStore outbox 已解决业务/事件一致性。审计复用同一检查点，投影健康直接派生Store状态；不要再加审计任务数据库。
5. `creative` 现有决定、提案、版本和撤销，以及 `knowledge` 来源检索，是长期记忆的业务基础。新通用Memory模块应适配，不应拥有第二个确认事实入口。
6. `scripts/eval-thinking.mjs` 只请求一次 events?after=0，而接口最多200条，长轨迹会少算工具调用。Phase 2需分页读取并回归验证；不能据此报完整效率指标。
7. `runtime/reliability.ts` counters在进程重启归零；Worker日志主要taskId/kind/code。统一observer需要有限标签、关联ID与持久诊断分工，不能声称当前已有跨重启总量。

## 文档与模块设计

- [总体ADR](agent-maturity-upgrade.md)：阶段门、进程/业务权威、迁移和发布。
- [Runtime Governance ADR](agent-runtime-governance.md)：执行上下文、Registry、模型/工具入口、预算/授权适配及审计。
- [Evaluation ADR](agent-evaluation-platform.md)：任务schema、五类split、grader/judge、报告及成本限制。
- [Memory ADR](agent-memory-architecture.md)：四层模型、来源、审核、隔离、冲突和撤销。
- [Orchestration ADR](agent-controlled-orchestration.md)：只读Creative试点、父子约束及有界规划。
- [Security Threat Model](agent-security-threat-model.md)：攻击入口、权限边界和失败标准。

建议新模块为 runtime/governance、evaluation、memory、observability、security、orchestration。模块数量不作为交付指标；复用已有model-gateway、tools/registry、TaskClient和Store。不新增框架、向量数据库或第三套调度器。

## 迁移、风险与验收

Phase 0无运行时或数据变更，可直接回退文档提交。后续版本元数据先兼容读取旧记录，旧运行只可安全中断或按原合同完成。新增持久格式必须提供真实旧数据导入、SIGKILL、未知费用/墓碑保存和兼容回滚验证。生产采用现有双数据库完整停机备份，不能以旧备份覆盖开放后的新费用和回执。

尚未解决：统一入口接入、持久审计容量策略、记忆权威接口扩展、父子预算事务、独立held-out评测和真实模型质量证据。多角色只有在相同预算下验证收益后才可启用。LLM Judge抗注入提示不能保证评分免受影响，程序约束与人工校准必须独立存在。

Phase 0验收依据为当前源码入口、契约、已有测试与基线验证记录；没有新增运行时代码，也未产生新的红队、真实模型或性能结果。Phase 1需以代码接入和运行回归验收，不以本ADR作为实现证明。

## Phase 1 验收记录

新增 `runtime/governance/runtime.ts`、`tool-gateway.ts` 和公共 `index.ts`；实际接入 PiHost、ModelGateway、工具Registry、Worker Scheduler与RunExecution持久字段。授权/预算适配复用Go与Durable，未新增状态数据库或修改公开协议。

| 验收项 | 证据 |
| --- | --- |
| 模型必须预留后发送 | governance.test.ts：未准备、预留等待、失败与取消均零发送；重复准备/发送拒绝 |
| Go started失败阻止Provider | gateway.test.ts：真实SDK与本地HTTP，拒绝admission或缺少adapter时请求数为零 |
| 工具重放重新授权 | governance.test.ts：已有故事回执与本地skill在撤销后拒绝 |
| 参数/权限/迟到结果 | governance.test.ts：额外bookId拒绝、scope扩权拒绝、取消后不发布结果 |
| 审计与版本 | reliability.test.ts：白名单日志无正文/凭证，版本和审计进入原持久执行对象 |
| 原有语义 | 全部106项Agent测试通过，包含SIGKILL、SQLite/outbox失败、预算、取消及迁移 |
| 跨进程合同 | Thinking、故事连续性、Review Worker、Creative、Knowledge quick/faults脚本通过 |
| 静态与构建 | typecheck:agent、Agent lint、build:agent通过；Go API/control构建通过 |

命令：`pnpm test:agent`、`pnpm typecheck:agent`、`pnpm --filter @writer-agent/agent lint`、`pnpm build:agent`；构建Go后执行 `scripts/test-thinking-agent.mjs`、`scripts/test-story-continuity.mjs`、`scripts/test-pi-review-worker.mjs`、`scripts/test-creative-workflow.mjs`、`scripts/test-pi-knowledge-worker.mjs --quick`、`scripts/test-pi-knowledge-faults.mjs`。

证据仅证明工程边界。未调用真实付费模型，未产生新的质量分数或性能改善结论，未部署本批代码。Phase 2下一步为统一评测schema/split/runner及Thinking事件全分页。后续仍需父子预算、长期记忆、全局持久诊断与编排审批；这些不因Registry已存在而视为完成。

## Phase 2：评测基础设施进度

状态：进行中，尚未通过完整Phase 2验收。

已实现 `evaluation/task-schema.ts`、`dataset.ts`、`runner.ts`、`graders.ts`、`metrics.ts`、`report.ts` 和生产模块执行适配器。统一命令 `eval:agent` 及 reliability/memory/safety/performance 已登记；默认运行dev合成数据，未知参数与真实模型模式拒绝执行。dev与held-out文件独立，检测重复ID/请求；本批仅运行dev，未发布held-out能力结论。

实际执行路径包括 PiHost/Store、Worker ModelGateway/领域候选解析、governTool、EventStore重新打开/重放/分页，以及manageDiscussion。报告记录commit/dirty、版本、输入fixture、预算、轨迹、未测指标和失败；没有观测的费用不记为零。质量成功率、业务提交正确率、语义记忆召回和货币成本尚无证据时保持null。

验证：109项Agent测试、类型检查、lint通过；首批dev案例8/8工程通过。Thinking Eval通过451条事件分页回归，末尾工具调用不再漏算。输出位于 `.local/evals/agent/dev-all.json`，这是一组小样本工程检查，不用于质量/SLA结论。

剩余Phase 2工作：接入Go跨进程最终状态与故障轨迹、扩展独立红队/记忆样本、实现受治理的可选pointwise/pairwise Judge及人工一致性报告、CI入口、执行超时/资源回收强化、完整版本与性能指标。当前Worker适配器使用显式synthetic admission，不证明Go授权和业务提交；讨论压缩回调为确定性fixture，不证明摘要语义准确。不得将8/8标为整个平台验收完成。
