# ADR：Thinking 的业务检查点与显式恢复

日期：2026-10-29。状态：开发实现，未生产部署。沿用 Pi SDK 1.3.0、独立 Go 权威和原子 JSON Store，不引入框架。

## 职责与状态

Provider 只做推理；PiHost Harness 负责接收、预算、执行时限、checkpoint、终态、恢复与审计。Tool Registry 负责定义和硬权限；Session Store 保存历史、回执、私有 checkpoint 和执行租约。Go 保留作者/作品、能力授权、点数、正式写入和受控排队权威。

公共 Session 视图通过 `X-Writer-Agent-Thinking: reliability-v1` 协商 Run 扩展；不带该头时 Go 去掉 run，旧严格解码客户端仍能读取历史。新 Worker 只转发该版本标记，不赋予权限。

用户消息 completed 表示内容已接受（不是模型已完成）；assistant 消息 accepted/running/completed/failed/interrupted/cancelled 表示该次回复。Session idle/running/deleted 为兼容视图。独立 Run 有 runId、traceId、messageId、attempt、retryCount、modelCalls、provider/model、checkpointId、stepType、epoch、时间、failure。内部步骤为 accepted/provider/tool/completed，不把工具步骤冒充新任务。

状态机：accepted → running ↔ checkpointed → completed / failed / interrupted / cancelled。accepted 时写用户输入、空回复、幂等回执、业务检查点和租约，再调用模型。模型发送前记录 reserve、incomplete、modelCalls；工具开始/结果边界写 checkpoint，终态写 usage/failure。Run 档案保留在私有 runs 中，公开 view.run 为最近一轮。

## 租约、栅栏与取消

Store 的 PID 排他进程锁增加原子 admission guard，串行初始创建和 stale PID takeover，避免两个启动者删除彼此的新锁。close 可重入；启动临界区崩溃遗留 guard 时保守要求运维核验。其上增加持久 executionLease(owner=随机进程实例 ID, epoch, expiresAt)。lease 到期不抢跑，只中断；定时 deadline 和每次结果写入都检查。不存在两份 Thinking worker 竞争领取的部署模式。

accept 在异步 authorize 返回后重新读取 epoch；取消、删除、另一轮准入改变状态会使旧快照失效。运行时用 runId + lease owner/epoch 校验结果；取消显式 Abort 原因。Go cancel 轮换 capability nonce，设置持久 ResumeBlocked（离线取消也有效），并持久标记已有请求回执 cancelled，防止未确认的旧 handoff 在重新签发能力后复活。只有后来新用户消息的真实接受回执才能解除 ResumeBlocked；恢复请求不能自行解除。Go 新准入事务再次比对 nonce，避免验证期间范围撤销。

Pi 在线时取消返回同步后的 200；Pi 离线时 Go 返回 `202 {status:"cancelled",syncPending:true}`，并在 Session/events 上用 `cancellationPending` 展示下游待同步状态。Cleanup 复用消息准入的 Session lock，并只接受当前 nonce 的取消，因而旧请求迟到时不会停止后来创建的新任务。pending 存在时新消息被稳定拒绝为 `CANCELLATION_PENDING`；Pi 恢复并同步后清除 pending，已取消 Run 仍保持不可恢复。

当前单写者锁 + 持久 epoch 不支持跨主机多副本；要扩展必须以事务存储替代文件锁，不能仅延长 lease。

## 恢复协议

`POST /v1/studio/books/:book/thinking/sessions/:id/resume`

```json
{"runId":"UUID","confirmAdditionalCost":true,"continuationContext":"可选，作者确认的续谈要点"}
```

必须带新的稳定 Idempotency-Key。客户端保存键和意图指纹；丢失响应只重投同键。服务端重放原回执，不重复模型调用。runId 必须是最近 failed/interrupted、安全 resumable 的 Run。取消、删除、已完成、已变更范围/模型、旧 Run、进入副作用的 Run 拒绝。Run 绑定单调 authorizationVersion；即使先撤销再重新授予相同范围，旧 Run 也不能恢复。Go 必须重新鉴权并重新预留，Pi 也核对 grant 和当前配置；没有 fallback 模型。

从原用户输入之前的 entries 重建 SDK，不重放原 SDK toolCall 状态，不恢复内部 stream，不假装能精确续 token。原 user messageId 保持，新增 assistant attempt 保留旧失败文本。只读工具可在新尝试重新读取；所有工具重新授权，原回合 Sources 不能直接作为新证据。

`request_turn_organize` 开始前 durably resumable=false；即使执行结果未知也禁止重放。现有 Go AcceptTurn 的业务幂等仍保持，不依赖 Node 内存去重来保证副作用安全。未来新副作用工具必须显式加入该硬边界，并提供 Go 持久回执后才能开放恢复。

## 预算与上下文

每次网络调用前预留 token ceiling。确认有效 usage 时结算已知 reservation，缺失/冲突/超时/重启则保留 ceiling；以 accountingVersion=2 惰性结算旧会话已知但未释放的预留，不重置实际累计量，不扩大点数或会话预算。SDK retry 和 auto compaction 继续关闭。手动 SDK compact 旧入口现在拒绝并要求作者续谈要点，避免额外摘要调用被视为免费或无损。

输入超限恢复时 continuationContext 必填，原正文历史、引用卡片保留；模型上下文只使用作者确认的要点和本次原问题。UI 明确“替代较早上下文”，提示保留重要引用、修订、已确认事项和假设。不自动丢弃决定，不把摘要作为 grant/canon。累计预算/存储上限不能 Resume 绕过；需要新话题或后续归档设计。

## 错误契约

所有分类 contextRetained=true、retryMayIncurCost=true、autoRecoverable=false。只读 GET 自动重连，不对模型做自动付费恢复。mayHaveIncurredCost 保守取本轮是否已开始 Provider 调用，不能由超时推断未收费。

| 分类 | Retryable | 用户操作 | 展示 |
| --- | --- | --- | --- |
| PROVIDER_TIMEOUT | 是 | 确认费用后重试 | 超时，保留部分回复，上次可能收费 |
| PROVIDER_UNAVAILABLE | 是 | 确认费用后重试 | 模型暂时不可用 |
| RATE_LIMITED | 是 | 稍后确认费用重试 | 请求较多 |
| CONTEXT_OVERFLOW | 是 | 填写并确认续谈要点 | 容量超限，完整历史保留 |
| TOOL_TIMEOUT | 是 | 确认费用后重试（必须安全） | 资料读取超时 |
| TOOL_EXECUTION_FAILED | 是 | 确认费用后重试（必须安全） | 资料读取未完成 |
| SESSION_INTERRUPTED | 是 | 确认费用后继续 | 服务/连接中断，对话保留 |
| SESSION_EXPIRED | 否 | 新话题 | 到达会话存储边界 |
| AUTHORIZATION_REQUIRED | 否 | 实际调用 preferences 确认资料范围，再发新问题 | 授权已变化 |
| MODEL_CONFIGURATION_ERROR | 否 | 主动选模型、按现有流程确认，再发新问题 | 不自动切换 |
| BUDGET_EXCEEDED | 否 | 缩小范围/新话题，不重置旧账 | 预算耗尽 |
| INTERNAL_ERROR | 否 | 联系支持并提供 Trace ID | 不展示堆栈或 Provider body |

Run failure 携带规范分类，message.errorCode 保留旧细分码以兼容；Go 错误 envelope 同时给旧 code、规范 failure 和 requestId。取消是独立终态，不显示恢复按钮。resumable=false 即使错误本身可重试也禁止恢复。

## 观测与验收

JSON 日志只记录 session_id/run_id/trace_id、provider/model、状态/步骤、duration、token_usage、retry_count、checkpoint_id、error_code，不记 Key、grant、正文、聊天或工具参数。私有 health 输出固定维度进程累计数（终态、恢复次数、模型调用、总时长），不把 session/run/书籍作为指标 label。计数重启归零，持久 Run 供离线审计。

离线 `pnpm eval:reliability` 以真实 SDK + Mock HTTP 注入故障，生成 `.local/evals/agent-reliability/report.json`。进程恢复、浏览器刷新、断网、取消竞争、授权撤销与副作用分别由配套集成/单元测试覆盖，不把 Mock 成功当作线上 SLA。Dreaming 见独立 ADR。
