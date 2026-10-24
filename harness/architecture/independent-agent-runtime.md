# 独立 Agent Runtime 与 Worker 部署

状态：已采纳
日期：2026-10-20
关联：`ai-knowledge-memory.md`、`sprint3-evidence-review-agent.md`、`author-workspace-management.md`、`deploy-guide.md`

## 目标

把「作者业务」与「AI 计算」拆成两个独立 Go 可执行程序，二者共享一个 Go Module、一套受控本机持久化状态，但生命周期、升级、资源限制与观测相互独立。

- `writer-agent-api`：作者认证与权限、作品管理、Chapter Revision、Notes、Publication、私有知识查询、Review 预览/提交/查询/反馈/取消、持久化 Agent 任务。
- `writer-agent-worker`：自动知识提取、Knowledge Job 调度、ReviewRun 后台执行、LLM 请求、超时/重试/预算/取消/崩溃恢复。

## 进程边界

- API 进程不启动任何后台 Agent 调度循环，不发起任何 LLM 模型请求，不运行长生命周期 Review goroutine。
- Worker 进程不提供公网业务 API，不直接接受浏览器作者身份，不修改正文、不发布作品、不写 confirmed Harness。
- Agent 永远不能修改作者正文或自行发布作品。

## 任务所有权与状态共享

- 单机文件系统共享 `/var/lib/writer-agent` 状态目录，沿用经过验证的 `storage.Lock`（O_EXCL 锁文件）+ `storage.Write`（临时文件 + fsync + 原子 rename）。
- 正文 Revision 是原文权威；Agent 状态是派生数据或任务记录。
- 跨进程共享状态只适用于当前单机文件系统，不视为天然支持多机。多机需另行设计安全的数据访问、任务领取与提交协议。

## 租约与 Fencing

- `storage.Lock` 文件锁与 Agent 任务 Lease 是两种不同机制，不可互相替代。
- Worker 领取任务时，在持久化状态里写入随机 Lease、`running` 状态与 deadline，并递增 attempts。
- 提交结果时，必须在同一个持久化事务里校验：状态仍为 `running`、Lease 匹配且未过期。Review 固定使用作者确认的快照，发送前检查快照新鲜度；Knowledge 在提交时持有 Revision 锁检查 Hash。
- 崩溃遗留的锁文件不按文件年龄自动删除，以免破坏仍在执行的事务；保留需要人工介入的故障状态与恢复工具。
- 目标：允许故障重试，但过期 Worker 不能覆盖当前结果、不能重复结算 Usage、不能突破预算、不能复活过期来源。

## ReviewRun 兼容迁移

- 旧 `running` 语义是「已创建且立即执行」。新系统区分 `queued → running → completed|failed|cancelled`。
- queued 不消耗执行 deadline。带 Lease 的 running 过期后最多领取三次；无 Lease 的旧 running 过期后进入失败，不静默重发。模型超时、无效输出或授权变化属于明确失败。
- 历史 ReviewRun 只读保留，不丢失；`StrategyVersion` 为空的历史记录仍映射到 `LegacyStrategyVersion`。
- 作者确认的 PlanHash、模型、来源范围、Revision/Hash、ReviewTypes、策略版本与上下文预算在 Worker 中不可私自扩大。

## 模型密钥边界

- `WRITER_AGENT_LLM_*` 与真实 API Key 只存在于 Worker 配置，不写入共享状态、公开响应或日志。
- API 仍需展示可用能力与可披露模型，但不依赖真实密钥；通过不包含密钥的模型配置描述与 Worker 状态发现机制判断能力可用性。
- API/Worker 配置不一致时 fail closed；模型变化必须要求作者重新授权，不能静默扩大数据范围。

## 部署与回滚

- 新增 `scripts/deploy/systemd/writer-agent-worker.service`，与 `writer-agent-api.service` 独立。
- 版本化 release 目录同时包含 `writer-agent-api` 与 `writer-agent-worker` 两个二进制，各自记录版本与 SHA256。
- 状态格式变化需兼容性校验；不支持的 API/Worker 组合停止部署；不静默用旧 Worker 处理新格式任务。
- 回滚必须有单一执行器保证：切换期间避免旧 API 内置 Agent 与新 Worker 同时运行；绝不用旧备份覆盖部署后新写的作者正文。
- 生产自动部署保持人工控制；旧 `deploy-api.yml` 的 EC2 自动部署 job 保持禁用。

## 锁恢复策略

- `storage.Lock` 使用 `O_CREATE|O_EXCL` 创建锁文件，成功进入临界区后 `defer` 删除锁文件。
- 进程异常退出（SIGKILL）可能遗留锁文件。当前策略：不在自动路径里按文件年龄删除锁文件；由运维确认无持有者后人工清理。
- 任务级恢复依赖 Lease/deadline 而非锁文件年龄：锁文件阻塞的是单次事务，Lease 阻塞的是任务提交，二者分层解耦。

## 尚未实现

- OS 级强文件权限隔离（不同 Unix 用户 + ACL/Group）尚未实现；API 与 Worker 共用同一 Unix 用户与可写目录，只提供进程与资源隔离。
- 跨机器部署的安全数据访问、任务领取与提交协议。


## 调度、心跳与取消

Runtime 在全局两个槽和每作品一个槽内运行；先检查 readiness，空队列不占用模型槽。第一次访问作品优先 Review，后续按作品/执行器游标轮转，Knowledge 自身仍按章节顺序和预算处理。这样持续 Review 不能永久阻塞回填；不声称抢占正在执行的模型请求。

Worker 每秒原子写入 `agent-runtime/worker.json`，包含协议、版本、实例、无密钥配置指纹、正在执行数及持久化任务计数。API 的作者鉴权 `GET /v1/agent-runtime` 判断五秒 freshness 和配置兼容性；Knowledge 响应披露 online/offline/incompatible。进程退出写离线状态，SIGKILL 由 freshness 检测。

Review 执行前对比已确认 ModelInfo、策略版本和上下文上限，不重建或扩大 Plan。每 100ms 检查持久化取消/租约并取消 HTTP context；远端提供商是否立即停止计费无法保证，提交仍受 fencing 保护。

## 可验证的发布组合

API 和 Worker 的 `--version` 输出 `agent-runtime-v1` 协议；安装器要求同一 release 的二进制组合并记录各自 SHA256 和 release manifest。Worker 使用独立 LoadWorker，不需要 HTTP Bearer 凭证；生产仍要求作者身份。`--check-config` 在不执行任务的情况下验证模型、可写状态目录及注册表。安装器在服务账号下预检后才停止两类 writer，再做完整状态备份、切换、显式重启 API 和 Worker。新 Worker 的实际心跳属于成功条件。回滚优先停止 Worker，然后恢复先前配置和二进制；只在先前为双进程部署时恢复旧 Worker，保留全部新状态。
