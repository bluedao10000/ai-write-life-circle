# Agent Task Protocol v1

服务端：独立 `127.0.0.1:8792`，是 Pi-only 生产拓扑的一部分，不挂在公网 API、Thinking RPC 或只读能力接口。凭证：`WRITER_AGENT_TASK_SERVICE_TOKEN_FILE`，受保护的独立 Worker service bearer。不能复用公开 API Token、Thinking token/HMAC key 或能力签名 Key。

- GET `/internal/v1/agent/tasks/capabilities`：协议、模型、无密钥配置指纹。
- POST `/internal/v1/agent/tasks/claim`：instance、configFingerprint；返回 `{task:null}` 或一个持久领取任务。
- POST `/internal/v1/agent/tasks/{taskId}/started`：模型请求前持久确认，幂等。
- POST `.../heartbeat`：重新核验，不延长模型总执行期限。
- POST `.../complete`：返回候选 text/usage，Go 独立校验并提交。
- POST `.../fail`：受限失败码，重试决定保留在 Go。

Zod：`packages/contracts/src/agent-tasks.ts`；任务类型为 `review.execute`、`knowledge.extract`、`creative.organize`、`creative.plan_check`。每个任务包含业务/作者固定标识、随机 Lease、epoch、Attempt、绝对 Deadline、策略版本、原文版本/Hash、模型与配置指纹、授权快照、输出 Schema 版本、预算预留、输入 Hash 与固定 model request。只读Creative计划核对额外使用`creative-plan-check-candidates-v2`；旧Worker不识别该合同，会在模型调用前拒绝。未领取时无任意正文读取入口。任务内最终schema与prompt由Go固定准备；只读试点的中间角色由版本化策略固定，Node无权修改计划、读取额外章节或写业务状态。

动作必须回显 leaseToken/executorEpoch/attempt/kind/inputHash/instance。最大请求体 256 KiB；模型候选正文上限按任务类型与 Go 领域解码器一致：Review 64 KiB、Knowledge 512 KiB、Creative organize 256 KiB、Creative plan check 64 KiB。输出 Token 与 Usage 契约上限为 131072，HTTP 响应体上限为 1 MiB；这些上限也参与执行策略合同。成功或失败响应可带`modelCalls`（1–5）；缺省表示旧执行器的一次调用，服务端按1处理。只读Creative策略要求在成功时恰为5，且五个角色的usage汇总为一个父任务结算值。错误不返回源文本或凭证。HTTP 401 表示服务身份错误，409 `EXECUTOR_FENCED` 表示取消、过期、disabled、执行器切换或其他失效。客户端收到失效须取消模型请求，不直接重试模型调用。

同一候选结果完成重试返回确认，新的候选不能覆盖已完成任务。领域回执恢复覆盖 Commit 成功而确认丢失的跨文件窗口。故障可能造成重复模型调用，但不会重复有效提交或错误退款。

不包含任何生产凭证、真实作品正文或自动部署操作。

Worker在capabilities与每次Claim中校验/回传`contracts`（Review、Knowledge、Creative的策略版本、输出Schema版本及完整固定Prompt的SHA256）。单角色Creative Prompt/Schema由Go在capabilities中下发；只读五角色策略的中间角色Prompt、schema和执行顺序由Strategy版本锁定，Coordinator仍使用Go下发的最终Prompt/Schema。配置或策略版本不兼容时在返回正文快照前拒绝，不能把排队任务当模型失败。

执行器 owner 只有 `pi` 和 `disabled`。旧状态文件中的 `go` 在读取时迁移为 `pi`；不存在 Go fallback 任务或旧二进制回滚路径。
