# ADR：Pi 是唯一的模型执行器

状态：已实现。Review、Knowledge、Creative 的后台模型调用均只由 Pi Worker 执行；Go 只保留业务权威与任务协议。

## 决策

生产运行时固定为三个进程：

1. **Go API**：身份、作品与 Revision、授权快照、任务领取、预算预留/结算、候选证据验证和业务提交。它只读取无密钥的公共模型配置，不创建模型客户端。
2. **Pi Thinking**：作者主动对话的 Session、受控故事工具和对话事件。PiHost 内部使用 Pi Durable 执行任务，每个 Session 保存一份 SQLite，每次 Run / attempt 使用独立 Conversation。Thinking 与后台任务使用独立用户、状态目录、RPC 凭证和额度。
3. **Pi Worker**：通过私有 `agent-tasks-v1` 协议领取 Review、Knowledge、Creative 任务，调用模型并回传候选。它不能读取 Go 状态目录、正文库或 Thinking 会话目录。

不存在 Go 模型执行进程、API 内嵌执行器或进程内后台模型循环。`writer-agent-worker`、`cmd/agent-worker` 与 `cmd/creative-eval` 已删除。

Thinking 的接受回执、预算、执行 epoch、事件与 Durable 任务共用持久化提交。进程重启先中断旧任务，作者确认额外费用并重新授权后才创建新 attempt；Go 继续负责授权、费用与正式业务提交。模型出口使用共享 Pi AI 1.5.0 Models 接口。Worker 沿用现有领取、单次生成与候选交付协议；候选跨进程持久交付属于独立后续改造。Thinking 的恢复与旧 JSON 导入规则见 [Durable 执行与显式恢复](agent-reliability.md)。

## 分域任务

| 领域 | Task kind | Go 负责 | Pi 只负责 |
| --- | --- | --- | --- |
| Review | `review.execute` | 计划摘要、同意范围、证据与 Revision 校验、反馈、结算 | 单次结构化候选调用 |
| Knowledge | `knowledge.extract` | 扫描、预算、实体/断言校验、索引提交、过期与纠错 | 单次结构化候选调用 |
| Creative organize | `creative.organize` | 对话摘录、候选/资产校验、作者审核状态、幂等提交 | 单次结构化候选调用 |
| Creative plan check | `creative.plan_check` | 计划与正文快照、Revision 锁、引文校验、作者决定 | 单次结构化候选调用 |

Pi Worker 不持有任意章节读取能力，也没有业务写接口。任务只包含 Go 已经确认的有界输入、固定 Prompt、Schema、模型配置指纹和输出上限。

## 执行器归属

`agent-runtime/executors-v1.json` 为每个领域保存 owner、epoch、draining 和租约。owner 只允许 `pi` 或 `disabled`。旧状态中的 `go` 在读取时按已完成迁移处理为 `pi`；切换接口不再接受 `go`。

Claim 在 ownership 文件锁内完成领域领取与租约登记。开始、心跳和完成都会重新核验 owner、epoch、lease、deadline、取消状态、配置指纹和领域前置条件。完成提交持有领域锁；关闭、暂停、Revision 变化、作品删除或 epoch 变化会使迟到结果失效。

`disabled` 是维护开关，不是第二个执行器。恢复时必须先确认 Pi Worker 健康，再显式切回 `pi`。生产操作可以使用：

```sh
node scripts/deploy/switch-agent-executor.mjs \
  --confirm-executor-switch --kind review --owner disabled \
  --state /var/lib/writer-agent \
  --control /opt/writer-agent/current/writer-agent-control
```

恢复时把 `--owner` 改为 `pi`。Review、Knowledge、Creative 可以独立排空和切换。

## 协议与配置

私有 Task API 仅监听 loopback，使用独立 service bearer。`capabilities` 和每次 Claim 都校验固定策略、输出 Schema 和完整 Prompt 的 SHA256 合同。共享 Zod 契约位于 `packages/contracts/src/agent-tasks.ts`，Python/Go/Node 都不能自行改写 Prompt 或业务规则。

任务配置指纹只覆盖 provider、endpoint、model、ResponseFormat、Token 参数、超时、上下文与输出限制，不包含 API Key。Go API 与 Pi Worker 的公共配置不一致时在 Claim 前拒绝；模型凭证只在受保护的 Pi Worker 环境中。

## 费用与失败语义

- Go 在领取时预留 AI 点数，在完成或失败时按实际 Usage 结算；Usage 未知时保守保留预留。
- Pi 不自动重试付费模型调用。是否重试、是否产生新费用由 Go 领域状态决定。
- 模型开始前必须持久确认 `started`。确认失败时不得发送请求。
- Complete 的 HTTP 重试复用同一候选；Go 领域回执保证不重复提交或结算。
- 进程崩溃、网络中断、取消、过期 lease 和旧 epoch 都可能造成一次无效模型调用，但不会重复写入有效业务结果。

## 健康与验收

`GET /v1/agent-runtime` 报告 `review`、`knowledge`、`creative` 三个 executor，并分别返回 owner、epoch、draining、ready、心跳、任务计数和最后成功时间。计数来自 Go 领域状态，不是 Node 自报。

验收至少包含：

- 三个 Pi 服务只监听约定端口，Task/Thinking RPC 均只允许 loopback。
- `--check-config`、`--healthcheck` 与 capabilities 的模型指纹一致。
- 每个领域完成一次隔离合成任务，重复 Candidate 不重复提交。
- Worker 在 started 前退出、模型 I/O 中 SIGKILL、lease 过期、取消与 Revision 变化均不能产生有效迟到结果。
- API 重启后队列可恢复，Thinking 会话不受后台 Worker 故障影响。

部署与运维见 [Pi Worker 流程](../workflows/pi-worker.md) 和 [生产部署指南](../deploy-guide.md)。
