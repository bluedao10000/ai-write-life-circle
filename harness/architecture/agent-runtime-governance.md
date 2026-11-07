# ADR：统一 Runtime Governance

日期：2026-11-05。状态：Phase 1 本地实现并验收；受控只读试点已接入，尚未部署。

## 合同与权威

新增 runtime/governance，按实际职责组合模块，不要求每个参考名称单独成文件。ExecutionContext 是从 Thinking Run 或 Go AgentTask 派生的不可变视图，包含 execution/run/task/parent 标识、角色、授权版本、资源、scope、预算上限、deadline、取消信号和 traceId。上下文不包含能力令牌或模型 Key；凭证由进程内适配器封装。

Registry 登记 Thinking、Review、Knowledge、Creative 的版本、工具集合、输出合同和策略。登记仅限制能力，不授予作者权限。只读Creative试点登记独立Planner、Researcher、Analyst、Critic和Coordinator角色，默认仍由Go选择单角色策略。Worker的strategyVersion、outputSchemaVersion、inputHash和模型指纹直接复用Go合同。

## 模型入口

复用 runtime/model-gateway.ts 的 Models API、独立凭证、boundedModelFetch、usage 解析和错误分类。将 PiHost 的 streaming 治理拆成适配器，保留终态 usage 在交给 Durable 前落盘的顺序。

统一执行顺序：核验版本与取消 → 当前授权与执行栅栏 → 构造最终 payload → 校验输入/输出与策略 → 持久预留 → 允许网络发送 → 结算已知 usage 或保留未知费用 → 持久终态 → 发布。不得用 Promise 超时替代对真实网络调用的取消。

Thinking BudgetAdapter 复用 Saved.execution.modelRequests、usage 和 Store.write；Worker Adapter 复用 Go claim/started/heartbeat/complete/fail。Go决定重试和正式点数，治理层不得补一个自动重试循环。只读Creative试点由一个Go父任务预留五个调用的总额，Pi按Planner、三个并行检查角色和Coordinator划分互不重叠的子预算，子预算总和等于父额；父任务中断后不自动重试。

子执行由统一 `childExecutionContext` 派生。它要求同一taskId、traceId、authorizationVersion和executorEpoch，使用独立executionId，并强制scope、deadline、token/model/tool预算只能收窄；父任务没有的scope不能出现在子任务中。该上下文是原Go任务和Pi执行的只读视图，不是第三套任务或预算权威。固定五角色和普通Worker复用同一合同。

真实Go/Pi验收中，Researcher、Analyst、Critic的started请求在任务API代理层达到并发3；Go原子保存五个角色准入，角色预算合计精确等于父任务预留111200 tokens。提交前增加并发race测试，向三个合法并行准入中混入扩大1 token的重复角色；扩大请求以`AGENT_CONFIG_CHANGED`拒绝，合法请求各保留原序号和预算，重启读取仍是五个唯一准入。

本批完整验收包含158项Agent测试、类型检查、lint、Agent与Go构建、`go test -race ./...`、真实Agent task API合同和运行时健康检查。开发集42/42工程通过，保留任务成功集5/5通过；两侧固定只读对照都从真实任务API代理读到并发3、五个唯一准入和111200 tokens子预算总和。所有模型响应来自本地合成Provider，没有付费调用。

## 工具入口

复用 tools/registry.ts 的 TypeBox/Zod 参数、scope 映射、返回大小、5秒超时和 StoryWrites 回执。ToolPolicy 从注册定义派生风险、safe/unsafe、输入/输出上限、授权与幂等要求。授权检查必须发生在本地缓存命中和回执重放之前；safe 只表示重放策略。Go 继续验证作者/作品/消息来源与正式写入，作者 messageId 保持业务幂等身份。

已存在的作者同意与 Go 写入规则视为业务授权，不增设重复确认。新增高风险操作的审批绑定精确操作、资源、输入、授权版本和期限；任何变更均失效。

## 审计与健康

审计事件只接收白名单元数据：关联ID、已登记角色、动作、允许/拒绝、固定原因码、授权版本、时间与版本。禁止任意对象、正文、凭证和工具参数。重要审计随原业务检查点提交；stdout 日志不能替代持久事实。

版本分别记录 runtime、definition、prompt、tool schema、dataset、memory schema；不以 npm 版本代替。恢复必须检查原策略兼容、重新授权，不能静默换模型。

只读Creative试点使用策略版本`creative-plan-check-readonly-v1`和输出合同`creative-plan-check-candidates-v2`。每次子调用记录登记角色、父taskId、独立executionId、模型请求序号、授权版本和固定版本；五个角色共享原Deadline、取消信号和Go started/heartbeat核验。任一并行角色失败会取消其余本地请求，缺失usage立即停止，不会在没有剩余预算证据时继续付费。单角色成功响应保持旧线协议；五角色成功响应报告5次调用，旧Worker因不识别v2输出合同而在模型调用前拒绝领取。

健康按现有进程聚合：活性表示进程响应；就绪表示存储、投影、授权/预算适配和注册合同可用；degraded 表示局部投影/Provider/Worker 故障。Provider 故障不等同数据损坏。指标标签只能使用受控角色、状态和原因码，关联ID仅进入受控 trace。

## 验收

用真实入口证明请求前预留、预留失败零网络请求、撤销后零工具执行、缓存重放也授权、取消后迟到结果被栅栏拒绝、未知 usage 不退款。保留现有 SIGKILL/outbox/迁移/Go 集成测试。静态入口扫描只用于发现绕过，不能替代运行验证。

## Phase 1 实现与验收

公共入口为 `apps/agent/src/runtime/governance/index.ts`。Registry 登记 Thinking 与五类 Go task kind，并校验 Worker 输出合同；ExecutionContext 固定角色、scope、期限、关联ID和版本，预算只读派生自原 Run/AgentTask。

`ModelRequestGate` 已接入 PiHost 的回复与讨论压缩 stream，以及 Worker 的 complete。SDK最终payload钩子等待授权和原持久预留适配器；实际fetch要求该请求已准备且尚未发送。并发准备、未预留发送和重复发送均被拒绝。Worker适配器在最终payload阶段调用Go started和heartbeat，没有适配器的ModelGateway默认拒绝执行。usage结算、未知费用与重试仍沿用原实现。

每个模型请求只有一个终态。授权阶段失败记录`denied`；期限到达、预留写入失败、已预留但未发送或已发送后的Provider/取消/输出失败记录`failed`；成功响应记录`model_finished`。终态记录幂等，不会因上层重复收尾产生多条结果。PiHost把终态写入原`RunExecution.audit`并随检查点持久化，Worker与Evaluation Judge使用同一分类和关联字段。

闸门将执行取消、执行deadline与调用方的Request/init信号合并到实际fetch。该约束覆盖响应体读取；调用方未传signal也不能绕过执行期限。取消不释放费用预留，未知usage仍由原预算权威处理。真实本地HTTP测试覆盖执行取消、Request信号、init信号及deadline四种路径。

工具调用的实际取消信号取任务deadline与工具timeout中较早者，并保留执行与调用方取消。工具HTTP响应体读取随该信号中断；超时沿用 `TOOL_TIMEOUT` 合同，失败后不发布工具成功审计或继续模型请求。参数、scope或当前授权在真正调度工具前被拒绝时记录`denied`；已调度后的执行、取消、期限或输出失败记录`failed`，避免把授权拒绝与工具故障混为一类。

`governTool` 包装所有注册工具，包括本地analysis skill与StoryWrites回执重放：校验schema/输入大小、scope、当前授权、取消和期限，然后执行原工具及检查输出大小。执行仍使用原顺序调度、原意图持久化和Go回执。Thinking重新核验作者、作品、session、授权版本、模型与scope；本地缓存不能绕过这项检查。

Thinking的版本和白名单审计记录加入原 `RunExecution`，随业务检查点提交，并跟随既往attempt映射保留。Worker继续使用Go的任务、started、预算和完成/失败回执作为持久事实；治理关联日志不构成第二个数据库。治理role/action计数属于进程内统计；Run生命周期指标另从原Durable会话中的历史`runs`与当前`view.run`按需投影，不写第二份账本。

新增可选私有字段不改公共Thinking或Go协议；旧运行没有governance元数据时保留legacy语义，启动仍中断旧付费执行。现有layout=2迁移与墓碑规则不变。代码回滚需支持该布局，禁止恢复旧状态覆盖新费用/回执。

验收：106项Agent测试通过，包含治理预留闸门、失败零网络、撤销后的本地重放、严格参数、迟到结果拒绝及审计脱敏/持久记录；类型检查、lint和构建通过。真实Go/Pi集成通过Thinking、story-continuity、Review Worker、Creative workflow、Knowledge 10章及Knowledge faults，全部合成HTTP模型。

2026-11-05终态审计验收：145项Agent测试、类型检查、lint、Agent与Go构建通过，`go test -race ./...`通过。真实Go/Pi进程重新通过Thinking、Review Worker、Creative五角色、Knowledge 10章、story-continuity与runtime-health；PiHost超时样本同时验证`model_started`和`failed`进入持久审计且没有伪造`model_finished`。全部模型请求由本地合成HTTP Provider响应。

本阶段保留通用审批存储和长期记忆的既有边界。高风险业务仍依赖现有作者同意、消息证据和Go确认规则。只读多角色试点仅拆分一个既有Go任务的预算，不创建子任务权威。Thinking Run历史投影只汇总保留会话中的生命周期、模型调用、恢复次数和终态耗时，不将本地日志标为完整持久审计。

## Thinking健康与诊断合同

健康从当前进程、Store初始化/关闭状态、失败会话、待投影提交及活动任务派生，不新增任务权威。liveness表示HTTP进程响应；readiness表示本地存储已初始化、未关闭且存在启用模型；degraded表示部分会话需要修复或投影恢复，健康会话仍可服务。Provider可用性不在健康探测时调用模型，显示not_probed；单次模型失败不等于存储损坏。

保留原health响应，新增runtime字段；新增同服务令牌保护的liveness/readiness/diagnostics路径。诊断仅返回固定字段、有限标签的计数和组件状态，不含会话ID、正文、凭证或任意错误文本。失败和恢复计数来自Store内已有运行状态，投影重放后重新派生；进程累计指标明确标为process，不作为跨重启账本。新增的Thinking Run聚合从已有Durable会话记录重新计算。Worker仍以Go现有heartbeat/status为权威，不引入第二心跳服务。

生产入口仍在Store初始化成功后监听端口，启动失败直接退出；liveness不是迁移期间的进度接口。`--healthcheck`使用readiness。unpublishedSessions表示已观察到的提交后发布失败，不统计正在正常投影的短暂提交。

## 工具执行耗时

Tool Gateway使用单调时钟记录每次调用的耗时。tool_started包含注册工具名，tool_finished/failed包含工具名与durationMs；计时从进入网关开始，包含参数校验、授权、实际执行和输出校验，不包含此前的模型响应等待。字段加入原RunExecution审计及关联日志，随原检查点持久化，不建立独立统计权威。工具名取注册定义，不取模型参数；审计仍不记录输入、输出、错误正文或凭证。

新增字段可选，旧审计继续可读。代码回滚忽略这些元数据，保留原任务、费用和回执。重启回归验证工具超时的耗时记录持久保留。当前不提供跨进程历史聚合或生产延迟SLO。

## Go跨进程健康汇总

Go在原Thinking私有监听器提供服务令牌保护的Runtime Health路由。Worker就绪从原executorpolicy与心跳派生，Thinking通过受保护readiness接口读取；没有第二个心跳来源或持久状态。请求至多2秒，固定字段投影排除正文、凭证和任意错误。组件故障保持Go liveness可响应，整体readiness和degraded独立报告。失效Worker心跳的待办数为未知，不推导为零。

现有公网agent-runtime响应、Go healthz与各进程healthcheck行为不变。新增接口需要原Thinking私有监听器已配置；未配置时继续使用已有Worker状态接口。详细字段与状态见thinking-internal-v1私有协议。该健康路由只报告当前状态；历史Run指标由后续Prometheus抓取读取Thinking诊断投影。

## Worker任务回执诊断

私有Worker监听器提供`GET /internal/v1/agent/tasks/{taskId}/diagnostics`，使用原Worker服务凭证。公开API不转发该路径。输出从原`tasks-v1.json`投影任务身份、作品、类型、策略/输出版本、epoch、attempt、deadline、started/finished、业务终态及终态时间；后台整理额外返回原来源任务ID，支持由候选的RunID定位整理任务再定位来源任务。

接口不写状态、不延长租约、不启动恢复或模型请求；不返回租约Token、实例、配置指纹、授权凭证、模型请求、正文、响应或任意错误文本。历史记录缺失终态时明确返回unknown；过期回执映射为interrupted。该投影用于诊断已持久化的当前执行事实，不能还原未保存的逐事件时间线。

新增字段均为读取投影，无存储格式迁移；回滚只移除接口。Go回归覆盖接受、运行、完成、失败、中断、历史unknown和重启读取。真实Go API/Zod验收覆盖服务身份隔离、公开路由拒绝、缺失任务及正文/凭证不泄漏。

## Worker持久生命周期审计

原任务回执新增可选`audit`，每个任务最多三条事件：`claimed`、`started`、`terminal`。时间在对应Go任务事务内写入，与任务身份及终态一起持久化；同动作重复回报不增加事件或改写时间。Worker模型调用仍必须等待started事务完成。过期清理写入固定`TASK_DEADLINE_EXPIRED`，失败回报只接收已有失败码白名单，其他拒绝归为`TASK_REJECTED`；不保存Provider错误正文、工具参数或凭证。

私有诊断直接返回这些事件。旧回执缺省audit，读取时不补造历史时间；旧二进制忽略可选字段，回滚保留原任务回执。该审计记录任务级接受、执行准入和终态，尚未覆盖Worker内部每次模型请求、子角色步骤或所有授权拒绝。

## 五角色模型准入回执

Creative只读计划试点的每次模型调用沿用原started命令，可附带固定角色、callIndex、parentTaskId及maxTokens。Go按已登记五角色和原任务预留预算验证；只有原任务身份、策略和租约有效时才写入原任务回执。每个序号最多一条，重复身份幂等，修改角色或预算拒绝。Worker等待该事务成功才允许网络发送。

回执只记录请求准入，不能作为模型成功或已知费用的证明。原任务仍拥有租约、预算和最终提交；没有第二套子任务权威。新增字段可选，旧普通任务不变；旧二进制忽略记录字段，但不支持新准入请求，部署需Go先于Worker升级。

### 准入失败与模型调用分离

ModelRequestGate在Go started事务失败时不再把该子调用推算给Provider，也不生成对应的stepResult。`AGENT_CONFIG_CHANGED`保留原失败码；其他准入拒绝归一为`MODEL_REQUEST_NOT_ADMITTED`。已完成并准入的调用继续携带真实Usage上报，未准入调用不计`modelCalls`、不占子预算，也不会让失败回执因伪造步骤结果被Go再次拒绝。

Worker收到`AGENT_CONFIG_CHANGED`先提交原任务失败回执，再标记执行合同不兼容并停止领取新任务。真实Creative攻击在Coordinator扩预算请求上取得Go 409，前四个角色已结算，Coordinator请求未到Provider，任务以`AGENT_CONFIG_CHANGED`安全结束。

## 五角色请求结果元数据

Worker终态上报可携带至多五条stepResults，按callIndex排序并关联已准入角色。仅记录模型请求是否完成/失败、单调时钟耗时及Usage；不保存中间输出。Go在原任务终态事务中校验唯一序号、准入记录及预算上限并持久保存，未知Usage仍为空，任务费用仍按原业务结算。进程在上报前中断的角色仅保留准入，不能推断成功。终态字段要求Go先于Worker升级；回滚前先drain Creative并停止Worker，再回退Go，避免旧Go的严格解码拒绝新终态。

## Worker历史指标

私有`GET /internal/v1/agent/tasks/metrics`使用原Worker服务凭证，按需读取`tasks-v1.json`并从同一条准入/结果证据派生指标。任务类型维度覆盖Review、Knowledge、Creative组织、Creative只读计划和Memory整理，分别返回accepted/running/completed/failed/interrupted/unknown计数，以及claimed→started和started→terminal的P50/P95；旧回执缺少审计时间时只保留计数。

Creative只读计划额外按固定五角色返回Admissions、Results、completed/failed计数、已知Usage样本及累计输入/输出/cache tokens，耗时P50/P95只聚合实际终止结果；没有样本时返回null。没有终态结果的准入不会被推断为成功。

接口不写入第二份指标账本，服务重新实例化后从原任务回执得到同一投影。它不返回任务ID、作品、正文、凭证或任意错误文本。当前历史窗口受原任务回执保留策略约束；不能将本地合成Provider耗时解释为真实模型SLO。

`GET /internal/v1/runtime/metrics`在同一Go私有loopback监听器输出Prometheus文本。它将原运行health、Worker心跳、Thinking readiness、Thinking诊断中的持久Run聚合和任务回执投影合并为每次抓取时重新计算的固定指标；不维护抓取链路、不会把旧心跳的待办数当成当前值，也不在Go进程内保存指标历史。Thinking指标包括固定生命周期状态、恢复次数、模型调用总数和终态Run耗时P50/P95。端点要求原服务Token，只允许GET；无样本计时省略，Thinking诊断暂不可用时省略其历史指标，来源失败返回无正文503。

标签只允许五种任务类型、Creative只读计划五角色、Thinking Run固定生命周期状态及固定Usage状态。这样既能接入外部监控，又避免把任务ID、作品、消息、正文、凭证或任意错误变成高基数或敏感标签。指标只从原权威状态派生；回滚时移除路由即可，已有状态文件无需迁移。Thinking历史窗口随原会话保留策略变化，删除会话后其Run不再计入；本地合成Provider样本不代表生产SLO。
