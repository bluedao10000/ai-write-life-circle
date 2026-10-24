# ADR：统一 Pi 执行器与 Go 任务权威

状态：三个阶段已实现，待审查与生产验收；默认仍为 Go，生产不切换。

## 分层与实施门

A：Go Claim / Prepare / Complete 与私有任务协议；B：有界 Pi Review 工作流；C：Pi Knowledge 与全书发现、状态、切换/回滚。三个 PR 按依赖顺序审查，均保持 Open。Thinking 的 Session、只读工具和授权独立保留。

Go 保留身份、Revision、知识 apply/freshen、实体与 Correction、Review 证据验证、预算与所有业务提交。Node 只能收到成功领取的有界快照并回传候选；不持有 Go 状态目录、任意章节读取能力或业务写入工具。API 从无密钥公共模型配置准备任务，不创建模型 Client。

## 持久化与锁序

`agent-runtime/executors-v1.json` 逐领域保存 owner（go/pi/disabled）、epoch、draining 及租约 deadline/started。默认 owner=go。Claim 在 ownership 锁内执行短领域领取事务并登记租约，不持有网络调用。Complete 在同一 ownership 锁内再次检查 epoch、owner、lease、deadline 后执行领域校验/提交。

Task API 的外层任务登记锁 → ownership 锁 → 原领域/Revision/作品提交锁。管理切换只获取 ownership 锁，不反向获取任务登记锁。后台网络调用不持有以上文件锁。O_EXCL 遗留锁沿用保守人工核验流程，不按时间自动删除。

跨文件不是事务：领取后登记失败可能留下无模型调用的领域租约，等待到期恢复，不冒充成功。领域完成回执与最终状态/预算同一次原子写入；若领域写入后进程崩溃、任务登记尚未确认，重试从领域回执确认完成，不重复提交或结算。回执哈希由 Go 根据原执行结果计算，Node 不能指定。

## 执行开始、费用与失效

模型请求前须先持久确认 started。调用开始确认丢失时不得发送模型请求；未知发送情况保留预算预留。Knowledge 的每日预留、Attempt/Job 上限、未知 Usage 和重试仍由 Go 结算；Node 不自行决定付费重试。

每次 start/heartbeat 检查归属、当前授权/暂停、模型配置、租约和原文 Revision。Complete 再经领域代码验证证据、来源、实体引用及当前正文，在 Revision 锁内提交。取消、过期、旧 epoch、删除作品的迟到候选不能生效。已提交结果的同一回执重放仅返回确认。

## 配置和旧数据

任务携带无密钥执行配置指纹，覆盖 provider/model/endpoint、格式、Token 参数、时长、上下文、输出/响应限制。Worker 配置不匹配时在 Claim 前拒绝；Go 预览/新知识授权另存配置指纹。旧 Go 授权/历史仍可读取；切 Pi 时缺少完整指纹的旧授权须由作者重新确认，不隐式扩大授权。Knowledge 响应明确 needsModelConsent。现有 100,000,000 Token 作品预算可继续读写，迁移不重置用量。

## 迁移和回滚

管理 CLI 先 drain：禁止新 Claim，但允许现有有效租约完成。Switch 拒绝未到期租约；到期后更新 owner 并递增 epoch，旧进程即使恢复也失去提交权。无强制越过活租约模式。超时保留 draining，运维核验后重试。Review 和 Knowledge 独立切换；Pi → Go 使用相同步骤，不启动两份执行器来“回滚”。

只能使用本协议兼容的 Go Worker 作为回滚执行器；旧二进制不具有 ownership 防护。生产切换前停止旧服务、备份全状态、验证部署组合；不得用旧备份覆盖新正文。源码保留至真实生产切换验收后另行清理。

## Pi 模型执行与准入

Thinking 保持 Pi Session / 只读工具循环；Review 和 Knowledge 使用同一 ModelRuntime 的单次结构化调用，不创建自由 Agent Loop，不加载未知扩展，不授予工具。Model Gateway 共享受限 fetch、Endpoint、大小和 AbortSignal 处理；每次付费调用禁止 SDK 自动重试。SDK 通过 SSE 接收输出，response_format 与 Token 字段仍严格遵循既有授权指纹。未知 Usage 不伪装为零。

私有 capabilities 与每次 Claim 都验证固定策略/Schema/完整 Prompt 的 SHA256 合同。版本不匹配时不返回正文，不兼容 Node 停止领取并离线报告；不会将作者已排队任务错误标为模型输出失败。Task API 的 Go 全局 Pi 上限为两个有效租约；Node 并发只能配置 1–2。逐 book/kind 轮转避免历史回填饥饿，同一本书 Knowledge 仍逐章执行，Review 与 Thinking 不共用后台会话额度。

## 历史发现、健康与部署

Go Knowledge Claim 内保留 sync，对 OrderedChapters 和已保存 Revision 扫描，以 MaxQueue=256 分批补充；每次完成后继续发现，不由 Node 按 ZIP 文件名推测顺序。不启用授权、不匹配模型、暂停或预算不足时不能开始模型调用。Go 保留幂等、同名身份、有效证据、Correction、Observation/Claim/Inference 和失效逻辑。

API `/v1/agent-runtime` 的 executors 分别报告 Review/Knowledge owner、epoch、draining、ready、模型指纹、发布版本、心跳、计数和最后成功。计数从 Go 领域状态读取；不是 Node 自报完成数。Knowledge UI 使用当前 Knowledge owner 的状态；Thinking 在线性仍通过独立 Thinking capabilities 查询，不能替代后台健康。

最终安装目标为 API、Pi Thinking、Pi Worker 三个 unit。新用户不读取 Go 状态/正文或 Thinking 会话目录；独立 RPC 凭证与 CPU/内存限制。包清单同时记录 Thinking 与后台协议并校验全部 dist/skills。具体安装、逐类型切换、回滚和明确确认的合成 Live Eval 见 [操作流程](../workflows/pi-worker.md)。默认归属仍为 Go，开发交付不代表已迁移生产。
