# Agent Task Protocol v1

服务端：独立 `127.0.0.1:8792`，是 Pi-only 生产拓扑的一部分，不挂在公网 API、Thinking RPC 或只读能力接口。凭证：`WRITER_AGENT_TASK_SERVICE_TOKEN_FILE`，受保护的独立 Worker service bearer。不能复用公开 API Token、Thinking token/HMAC key 或能力签名 Key。

- GET `/internal/v1/agent/tasks/capabilities`：协议、模型、无密钥配置指纹。
- POST `/internal/v1/agent/tasks/claim`：instance、configFingerprint；返回 `{task:null}` 或一个持久领取任务。
- POST `/internal/v1/agent/tasks/{taskId}/started`：模型请求前持久确认，幂等。
- POST `.../heartbeat`：重新核验，不延长模型总执行期限。
- POST `.../complete`：返回候选 text/usage，Go 独立校验并提交。
- POST `.../fail`：受限失败码，重试决定保留在 Go。

Zod：`packages/contracts/src/agent-tasks.ts`；任务类型为 `review.execute`、`knowledge.extract`、`creative.organize`、`creative.plan_check`。每个任务包含业务/作者固定标识、随机 Lease、epoch、Attempt、绝对 Deadline、策略版本、原文版本/Hash、模型与配置指纹、授权快照、输出 Schema 版本、预算预留、输入 Hash 与固定 model request。未领取时无任意正文读取入口。任务内 schema 与 prompt 由 Go 固定准备；Node 无权修改计划、读取额外章节或写业务状态。

动作必须回显 leaseToken/executorEpoch/attempt/kind/inputHash/instance。最大请求体 256 KiB；模型候选正文上限按任务类型与 Go 领域解码器一致：Review 64 KiB、Knowledge 512 KiB、Creative organize 256 KiB、Creative plan check 64 KiB。输出 Token 与 Usage 契约上限为 131072，HTTP 响应体上限为 1 MiB；这些上限也参与执行策略合同。错误不返回源文本或凭证。HTTP 401 表示服务身份错误，409 `EXECUTOR_FENCED` 表示取消、过期、disabled、执行器切换或其他失效。客户端收到失效须取消模型请求，不直接重试模型调用。

同一候选结果完成重试返回确认，新的候选不能覆盖已完成任务。领域回执恢复覆盖 Commit 成功而确认丢失的跨文件窗口。故障可能造成重复模型调用，但不会重复有效提交或错误退款。

不包含任何生产凭证、真实作品正文或自动部署操作。

Worker 在 capabilities 与每次 Claim 中校验/回传 `contracts`（Review、Knowledge、Creative 的策略版本、输出 Schema 版本及完整固定 Prompt 的 SHA256）。Creative Prompt/Schema 由 Go 在 capabilities 中下发，Node 不再维护第二份文本；其他本地合同与 Go 不一致时在返回正文快照前拒绝。配置不兼容不能把排队任务当模型失败。

执行器 owner 只有 `pi` 和 `disabled`。旧状态文件中的 `go` 在读取时迁移为 `pi`；不存在 Go fallback 任务或旧二进制回滚路径。
