# Sprint 4.5 Agent Runtime 交付与修复报告

日期：2026-10-20；分支：`codex/sprint4-5-agent-worker`；基线：`main` @ `e4cbf13`。
PR：https://github.com/story2u/ai-write-life-circle/pull/18

本报告替代最初 `e7dcc14` 的验收描述。PR 保持 Open；没有生产部署、生产数据迁移或付费 Eval。

## 审查问题处理

| 问题 | 修复与证据 |
| --- | --- |
| queued 未领取就过期 | 只有 running 检查 deadline；离线排队和 API 重启测试均保留 queued |
| 未确认的模型接收正文 | Generate 前比对 ModelInfo（provider、endpoint、model、execution）、策略和上下文上限；不匹配零模型调用 |
| Knowledge 无法启用 | QueueOnly 模式独立验证公开配置；API nil Client 可以授权/排队/查询，但不能领取执行 |
| 新 Worker 无法启动 | LoadWorker 不要求 HTTP 凭证；安装器必须接收预配置 Worker env，服务账号下 --check-config 预检模型/状态/注册表 |
| 升级未重启旧 Worker | 显式停止并 restart 两个进程，成功条件包含切换后的新心跳 |
| 崩溃后不能重试 | 有 Lease 的过期 running 重新排队，最多三次领取；旧无 Lease running 过期失败，不自动重新发送 |
| 备份/回滚双执行器 | 先停 Worker，再停 API 后才备份；回滚先停新 Worker，再恢复旧二进制/配置；旧版内嵌 API 不搭配新 Worker |
| UI 忽略 queued | queued 自动轮询、禁止重复发起、可以取消；增加 hook 回归测试 |
| 缺乏运行状态 | 原子持久化 Worker 心跳、配置兼容性、任务计数；鉴权 /v1/agent-runtime；Knowledge 显示离线/配置不兼容 |
| ManagedBook 严格契约回归 | 移除初版多余的公开 ownerId 字段；作品所有权继续只由内部 registry 维护，避免新建作品被前端 Zod 拒绝 |
| 调度公平性 | 空队列 readiness 不占模型槽；全局两个槽、每作品一个槽、作品/执行器游标轮转；Knowledge didWork 反映真实领取 |

## 最终交付问题回答

1. **API 是否停止执行 LLM？** 生产入口使用 LoadPublic，不构造 Client、不启动 Manager；Review 固定 DisableLocalExecution。旧内嵌实现仅供包级兼容测试。
2. **Knowledge 是否只由 Worker 执行？** 是。API 提供授权、查询和确定性的状态同步；独立 Executor 执行 ProcessOne，沿用原有预算、来源核验和 Revision 锁。
3. **Review 是否持久化异步？** Run 和创建幂等记录在同一文件事务落盘，然后返回 202 queued。Worker 原子领取，模型调用在文件锁外执行。
4. **崩溃如何恢复？** 未领取 queued 不消耗执行超时；运行租约过期后最多三次领取。SIGTERM 取消执行并保留可恢复状态；SIGKILL 后等待 lease 到期。异常遗留 O_EXCL 文件锁仍需人工处理。
5. **如何阻止重复/迟到提交？** Generate 前再次验证状态、租约与 deadline；提交事务只接受未过期的当前 running Lease。旧租约/取消/已完成结果不再生效。双 OS Worker 争抢测试只产生一次模型调用；SIGSTOP/恢复场景中旧进程不覆盖新结果。
6. **如何跨进程取消？** API 持久化 cancelled；Worker 每 100ms 检查状态/Lease 并取消 HTTP context。最终提交仍检查状态，远端停止计费速度不能保证。
7. **能否独立重启？** 两个二进制和 systemd unit，Worker 无公网监听。故障测试验证 API 重启后任务保留、Worker 停止时可以保存。
8. **模型与授权？** API 使用无密钥公开配置，Worker 加载实际凭证。已确认模型或策略不匹配时零正文发送并明确失败；不自动扩大或重建 Plan。
9. **文件锁残留？** 沿用保守 O_EXCL 锁，不按年龄自动删除；Task Lease 不代替文件锁。运维确认服务全部停止且无持有者后才人工清锁。
10. **生产配置变化？** 两个受限 systemd unit；Worker env 必须在安装前提供。API 公开配置从 Worker env 生成，剥离 APIKey。--check-config 不执行模型任务；--healthcheck 检查本机 heartbeat。release manifest 与 SHA256SUMS 记录组合；二进制协议必须都是 agent-runtime-v1。
11. **旧 ReviewRun？** 原历史与反馈保留；空策略兼容 v1。无租约旧 running 过期失败，不能静默以当前模型重发。回滚至内嵌 API 后，新 queued 记录保留，需恢复新 Worker 或由作者取消后重新确认，不由旧执行器静默发送。
12. **单执行器回滚？** 停 Worker → 停 API → 一致性备份 → 切换；失败回滚也先停 Worker。仅先前部署具有 Worker 二进制且 Worker 曾运行才恢复旧 Worker；不恢复状态备份覆盖新正文。
13. **故障测试？** scripts/test-agent-runtime.mjs 使用真实 API/Worker 进程和临时合成章节，覆盖离线排队、保存、API 重启、模型不匹配、双 Worker、模型调用中 SIGKILL、过期恢复、SIGSTOP 后旧租约迟到提交、调用中取消与心跳。单元测试补充三次上限、legacy 恢复和主动 HTTP context 取消。scripts/test-agent-installer.sh 在隔离 Linux CI 以真实文件操作和模拟 systemctl/curl 验证首次安装、升级、一致性备份、双服务/legacy 回滚与不兼容拒绝；不是实际 EC2 部署测试。
14. **真实模型？** 本轮没有。Knowledge 24 场景与 Review HTTP 替身只验证工程链路，qualityValidated=false；不能作为文学语义或真实付费模型质量结论。
15. **多机限制？** 仍只支持单机本地文件系统。跨机器需独立租约存储、队列或安全 RPC；共用 Unix 用户不代表强文件权限隔离。心跳是本机观测信息，不是分布式互斥协议。
16. **PR？** https://github.com/story2u/ai-write-life-circle/pull/18 ，保持 Open。

## 验证记录

本轮本地通过：Go Race、go vet、typecheck、lint（一个既有 warning）、OpenAPI 生成检查、Node/Go 差分兼容、构建、生产模式身份/保存/重放烟测、双进程 Runtime 故障注入、Review HTTP 集成、Knowledge 24 个合成场景（工程失败 0）、前端 120 + Worker 12 项测试、Review Playwright 3 项与 Knowledge Playwright 1 项。

本机没有运行中的 Docker；Linux 安装/回滚合约测试交由 PR CI 执行。最终 CI 结论以该 PR 最新提交对应的 GitHub Actions 为准。未在本轮验证强制 SIGKILL 正好打断 fsync/rename 的每条指令边界；已有原子写和文件锁测试继续保留，此类遗留锁需要人工恢复。
