# thinking-v1 私有协议

Zod 可执行契约：`packages/contracts/src/thinking.ts`。外部 author API 见 `thinking-api-v1.json`；以下内部路由不可安装在公网 listener/Worker 白名单上。

## Go → Pi（127.0.0.1:8790）

所有请求含独立服务 Token：`Authorization: Bearer <service-token>`；固定配置目标，禁止重定向。JSON 请求最多64KiB。

| 方法/路径 | 输入 | 输出 |
| --- | --- | --- |
| GET /internal/v1/health | 无 | `{protocol:"thinking-v1",version:<release revision>,model:ThinkingModel}`，无 Key |
| POST /internal/v1/sessions | ThinkingPrivateCreate（sessionId,authorId,bookId,model,scopes,createdAt,capability） | 201 ThinkingSession，重复创建恢复同一记录 |
| GET /internal/v1/sessions/{id} | 无 | ThinkingSession，transcript 不含能力 Token/Pi raw entries |
| POST /internal/v1/sessions/{id}/messages | ThinkingPrivateMessage（input,key,capability） | 202 `{messageId}`，先持久接受再异步执行，同键不重复付费 |
| GET /internal/v1/sessions/{id}/events?after=N | 非负游标 | ThinkingEvents，每页至多200；Accept:text/event-stream 时同一事件以 SSE id/data 发出 |
| POST /internal/v1/sessions/{id}/cancel | `{}` | 200 ThinkingSession，取消当前请求并保留历史 |
| DELETE /internal/v1/sessions/{id} | 无 | 200 `{}`；持久删除墓碑，清除 transcript/SDK entries/events，迟到创建也不得复活 |

普通 RPC 最多15秒；长执行不占用作者 RPC。外部使用游标短轮询，避免 Worker 30秒限制；刷新读取 snapshot.cursor 后继续。内部 SSE 是观测通道，断线不取消任务。客户端只能 append 大于上次游标的事件；已经接受消息的重试使用原键。Node 重启标记 interrupted，绝不自动重新调用模型。

## Pi → Go（127.0.0.1:8791，第二个 listener）

使用 Go HMAC 签发、10分钟过期的单会话能力 Token。签名 Key 仅 Go 持有。Token 绑定 registry 的 nonce，registry 决定 owner/book/model/scopes；每个模型调用/工具执行重新授权，Go 在工具返回前再次核对。取消/删除轮换 nonce；作品不存在立即拒绝。仅支持 POST：

| 路径 | 输入 | 输出 |
| --- | --- | --- |
| /internal/v1/agent/authorize | 空 | ThinkingGrant：sessionId,authorId,bookId,model,scopes |
| /internal/v1/agent/memory-extraction-context | 空 | 专用会话绑定的任务来源与结果；仅持有该会话 capability 可读取 |
| /internal/v1/agent/story-context | `{sessionId,query}`；需 creative scope | 当前作品设定、候选、问题、本会话焦点及近期变更 |
| /internal/v1/agent/story-change-receipt | `{sessionId,messageId}`；需 creative scope | 原作者消息的权威回执摘要或 null，用于恢复 |
| /internal/v1/agent/tools/execute | ThinkingToolRequest：sessionId,tool,arguments；写工具附可信 messageId/runId | 工具专属 JSON，可能含 ThinkingSource 数组；≤ maxToolResultBytes |

允许工具：search_knowledge、read_chapter、get_entity、find_related_chapters、get_author_notes、get_timeline、get_plot_threads。需要 `creative` scope 的读取工具：list_creative_assets、get_creative_asset、list_creative_proposals、list_open_questions、get_writing_context、compare_plan_with_manuscript、get_discussion_source。request_turn_organize 只为当前回合入队整理，结果是待作者审核的候选。工具无任意 bookId、authorId、path、URL 参数；ID 均按会话归属校验。get_discussion_source 可读取同一作者、同一本书的原始讨论消息，摘要不能作为逐字证据。

creative scope 下，作品开启 dialogueRecording 时注册 record_story_changes，关闭时注册 offer_story_changes；update_discussion_focus 在两种状态下都可更新会话备注。Host 将当前逻辑作者 messageId 与 runId 放在工具外层，模型不能指定；Go 对照 Pi 的运行快照及授权版本，在授权锁内提交 creative 事务。record_story_changes 一次提交本轮完整变化，校验引用与资产版本，返回独立持久回执。offer_story_changes 保存待作者手动应用的预览，不修改作品设定。Pi 在检查点保留写入参数和结果，恢复时先读取原消息回执，复用 offered/applied/undone 状态；结果未知时不允许另换一批参数。409/422 作为可恢复工具反馈返回；关闭开关后拒绝自动记下。上下文读取失败使用 STORY_CONTEXT_UNAVAILABLE，发生在模型执行与本轮写入之前。详细状态语义见 [故事连续性](../architecture/story-continuity.md)。

read_chapter 按 UTF-16 窗口读取已保存 Revision，返回 totalUTF16/truncated；quote 模式要求唯一且≤4000字符，用于作者选区。相关章最多扫描64个候选、返回8条摘要；不是全书检索保证。知识保持既有 observation/claim/inference 与有效来源状态；没有数据时不伪造。大笔记集合显式报 TOO_LARGE，不静默省略。

错误仅 `{code}` 或标准 problem，401/403 为无授权/撤销，404 为未知/无归属，409 为正在运行/模型需重新确认，422 为非法输入/正文定位失败，429 为预算/并发，503 为服务不可用。不得返回原始模型错误、Key、Token、系统路径或未脱敏工具结果。

## Go 私有 Runtime 汇总

`GET /internal/v1/runtime/health`安装在现有Go私有loopback监听器（默认8791），使用与Thinking RPC相同的服务Token。公网API不提供该路径。未授权返回401，非GET返回405；有效汇总返回200与`Cache-Control: no-store`，组件故障通过JSON表达。

输出`schemaVersion=1`：

| 字段 | 含义 |
| --- | --- |
| liveness | 当前Go私有HTTP处理器可响应 |
| readiness | 所有启用Worker执行器及配置的Thinking就绪 |
| degraded / status | 组件不可用或Thinking局部存储/投影降级；status为ready或degraded |
| api | ready表示Go处理器可服务该探测，不执行业务数据写入探测 |
| provider | 固定not_probed，不产生模型调用 |
| worker | status、readiness、enabledExecutors、onlineExecutors、pendingTasks |
| thinking | status、readiness、degraded、counts |

Worker复用Go已有执行权政策与5秒心跳有效期；禁用的执行器不参与就绪判断。仅当所有启用执行器在线时返回pendingTasks，否则为null，不把旧心跳中的任务数当作当前值。Worker status为ready/degraded/unavailable/disabled。

Thinking通过原服务Token读取`/internal/v1/readiness`，单次探测至多2秒，并服从更短的调用方期限；禁止重定向，响应最多32KiB。仅投影固定状态与activeTasks/pendingAdmissions/failedSessions/unpublishedSessions/recoveryPending计数，不转发任意错误或未知字段。无法连接/超时为unavailable，合同不匹配为invalid_response，未配置为disabled；有效响应保留ready/degraded/not_ready。只有有效响应中的固定计数可读取，无法取得有效响应时counts为null。

该接口不新增心跳、数据库或调度权威，不替代进程自己的liveness探针。Go API可响应与完整业务数据健康是不同观测；汇总readiness表示启用Agent执行组件可用。

## 经验提取会话

ThinkingCreate 可包含 `memoryExtraction:{taskIds:[...]}`，须 `consent:true` 且不含 scope。Go验证1–4个成功任务并捕获公开结果投影版本；新会话版本为3，`resultVersion`是不含正文的`sha256:`令牌。ThinkingGrant、PrivateCreate、Session、Summary携带可选`memoryExtraction`；v1/v2旧会话继续使用原数字版本读取，但不能恢复新的付费提取。旧普通会话省略该字段。

私有上下文响应为`{binding,items,comparisons,comparisonOmitted}`，只含固定任务和至多8条当前可用已确认经验；逐次验证令牌、原来源可读及比较版本。v3执行角色为`memory.extract.v3`，禁止全部故事工具。取消同步仍可获取最新grant以撤回Pi执行，已取消的grant不得用于新模型请求或候选导入。

作者 `POST /thinking/sessions/{id}/memory-candidate` 提交 `{runId}`。Go从持久会话读取已完成输出，验证严格 JSON、来源子集、授权版本与取消状态，调用原 Procedural 候选事务。幂等身份为 Run；响应 201 ProceduralRecord，`extractions` 记录会话、Run、模型、提示版本和授权版本。确认、合并与检索继续验证各提取来源，撤销或来源变化后不可用。正式确认仍走原作者决定命令。
