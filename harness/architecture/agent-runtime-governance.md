# ADR：统一 Runtime Governance

日期：2026-11-04。状态：Phase 1 本地实现并验收，尚未部署。

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

## Phase 1 实现与验收

公共入口为 `apps/agent/src/runtime/governance/index.ts`。Registry 登记 Thinking 与四种 Go task kind，并校验 Worker 输出合同；ExecutionContext 固定角色、scope、期限、关联ID和版本，预算只读派生自原 Run/AgentTask。

`ModelRequestGate` 已接入 PiHost 的回复与讨论压缩 stream，以及 Worker 的 complete。SDK最终payload钩子等待授权和原持久预留适配器；实际fetch要求该请求已准备且尚未发送。并发准备、未预留发送和重复发送均被拒绝。Worker适配器在最终payload阶段调用Go started和heartbeat，没有适配器的ModelGateway默认拒绝执行。usage结算、未知费用与重试仍沿用原实现。

闸门将执行取消、执行deadline与调用方的Request/init信号合并到实际fetch。该约束覆盖响应体读取；调用方未传signal也不能绕过执行期限。取消不释放费用预留，未知usage仍由原预算权威处理。真实本地HTTP测试覆盖执行取消、Request信号、init信号及deadline四种路径。

工具调用的实际取消信号取任务deadline与工具timeout中较早者，并保留执行与调用方取消。工具HTTP响应体读取随该信号中断；超时沿用 `TOOL_TIMEOUT` 合同，失败后不发布工具成功审计或继续模型请求。

`governTool` 包装所有注册工具，包括本地analysis skill与StoryWrites回执重放：校验schema/输入大小、scope、当前授权、取消和期限，然后执行原工具及检查输出大小。执行仍使用原顺序调度、原意图持久化和Go回执。Thinking重新核验作者、作品、session、授权版本、模型与scope；本地缓存不能绕过这项检查。

Thinking的版本和白名单审计记录加入原 `RunExecution`，随业务检查点提交，并跟随既往attempt映射保留。Worker继续使用Go的任务、started、预算和完成/失败回执作为持久事实；治理关联日志不构成第二个数据库。治理指标按固定role/action计数，属于进程内统计，不是跨重启总账。

新增可选私有字段不改公共Thinking或Go协议；旧运行没有governance元数据时保留legacy语义，启动仍中断旧付费执行。现有layout=2迁移与墓碑规则不变。代码回滚需支持该布局，禁止恢复旧状态覆盖新费用/回执。

验收：106项Agent测试通过，包含治理预留闸门、失败零网络、撤销后的本地重放、严格参数、迟到结果拒绝及审计脱敏/持久记录；类型检查、lint和构建通过。真实Go/Pi集成通过Thinking、story-continuity、Review Worker、Creative workflow、Knowledge 10章及Knowledge faults，全部合成HTTP模型。

本阶段不启用子任务、父子预算划分、通用审批存储或长期记忆。高风险业务仍依赖现有作者同意、消息证据和Go确认规则。全局持久诊断、历史指标与统一健康聚合属于后续Observability阶段；不将本地日志标为完整持久审计。

## Thinking健康与诊断合同

健康从当前进程、Store初始化/关闭状态、失败会话、待投影提交及活动任务派生，不新增任务权威。liveness表示HTTP进程响应；readiness表示本地存储已初始化、未关闭且存在启用模型；degraded表示部分会话需要修复或投影恢复，健康会话仍可服务。Provider可用性不在健康探测时调用模型，显示not_probed；单次模型失败不等于存储损坏。

保留原health响应，新增runtime字段；新增同服务令牌保护的liveness/readiness/diagnostics路径。诊断仅返回固定字段、有限标签的计数和组件状态，不含会话ID、正文、凭证或任意错误文本。失败和恢复计数来自Store内已有运行状态，投影重放后重新派生；进程累计指标明确标为process，不作为跨重启账本。Worker仍以Go现有heartbeat/status为权威，后续聚合不引入第二心跳服务。

生产入口仍在Store初始化成功后监听端口，启动失败直接退出；liveness不是迁移期间的进度接口。`--healthcheck`使用readiness。unpublishedSessions表示已观察到的提交后发布失败，不统计正在正常投影的短暂提交。
