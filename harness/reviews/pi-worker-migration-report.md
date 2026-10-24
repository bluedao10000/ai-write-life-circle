# Pi Worker 迁移交付报告

基线 main dd4bb42。任务按 A → B → C 推进；三个阶段已实现，等待最终 CI 与审查。生产不部署、不切换默认执行器，不调用付费模型。保留用户未跟踪目录 `.workbuddy-ai/`。

## PR A：任务协议（本地与远端 CI 验证完成）

已拆分 Knowledge/Review 的领取、准备和验证提交；旧 Go Worker 使用同一领域阶段。新增独立私有任务 listener、持久 owner/epoch/drain、started、固定输入快照、模型执行配置指纹、领域完成回执和管理 CLI。默认两类执行器仍 Go。知识合并、来源、Correction 与 Review Evidence 均保留 Go。

本地完整 `pnpm test`、`pnpm test:e2e`、Typecheck、Lint、OpenAPI 重现与验证通过。新增真实 Go 私有监听器 ↔ Zod 协议联调，验证默认 Go、独立 Worker 身份、并发领取、started/heartbeat、完成重放；新增 drain/epoch、取消、证据拒绝、删除清理和领域提交后确认丢失测试。最新 Review 阶段拆分另跑 Race 通过。

严格配置校验发现旧 HTTP fixture 的 API/Worker 超时不同，已对齐；Timeout 变更需要重新预览。队列尚未 Claim 时失败不会伪装成旧 running；旧无 Lease running 的失败恢复仍有独立覆盖。

租约结算覆盖了“已领取但尚未 `started`”的取消与正文替换路径：持久执行器标记证明模型请求没有开始时，到期任务退还当日预留 Token 和 Job 次数，并清除领域租约标记以避免重试重复退款。对应回归同时覆盖暂停取消和修订替换。

PR A：[PR #22](https://github.com/story2u/ai-write-life-circle/pull/22)，base=main，保持 Open。本阶段不包含 Pi Executor，未切换生产。

## PR B：Pi Review（本地与远端 CI 验证通过）

独立 Node Worker 使用 Pi ModelRuntime 单次结构化调用，不拥有工具、Go 状态目录或正文写入权限。Thinking 与后台进程共享受限模型适配层，生命周期和资源额度独立。Prompt 与 Go v4 策略逐字对照；模型格式、Token 参数、超时、上下文及输出上限必须匹配作者已确认的指纹。SDK 使用 SSE 传输，但不会改变已授权的结构化输出模式。缺失 Usage 保持未知，无模型自动重试。

实际启动 Go API、Go Worker、Pi Thinking、Pi Worker，验证 Go/Pi 同组合成 Review 的状态、失败码、Usage 和证据拒绝一致；验证取消、双 Node 争领、模型发送后 SIGKILL、API 重启和切回 Go。Thinking 在后台慢请求期间仍独立响应。公开 API、Thinking 和后台任务凭证必须各自不同。

新增 systemd Worker unit、独立环境示例、手动切换及回滚脚本。默认 owner 仍为 Go，PR B 只支持 Review，不改 Knowledge 的执行归属。所有测试使用隔离 HTTP Fixture；未执行真实模型、生产写入或部署。

PR B：[PR #23](https://github.com/story2u/ai-write-life-circle/pull/23)，base=PR A 分支。复查补充：私有 Claim 前核对策略/Schema 合同哈希，不兼容进程在领取正文前拒绝；本地发现不兼容时停止领取，不把任务改为模型输出失败。并发配置限定 1–2，与 Go 的全局最多 2 个有效 Pi 任务一致。公开 Runtime OpenAPI 同步增加逐类型执行器，真实四进程响应由 AJV 验证。

## PR C：Pi Knowledge 与发布准备

Knowledge 固定结构化输出已接入同一 Pi Model Gateway。保留七类实体、Assertion、Epistemic、来源、说话人、时间与 ExistingID。Node 只做结构解析；Go 继续检查来源和允许实体，执行 liveness、apply/freshen、同名消歧、Correction、来源退役及最终知识索引提交。没有迁移确定性业务逻辑，没有改变 Prompt 或补写作者正文。

Go Claim 保留自动扫描有序的已保存 Revision，以 256 个队列上限持续补充历史任务。实际四进程测试已经完成 10 / 100 / 500 章全量处理、单日 Job 预算阻断、暂停/恢复、无重复 Revision、切回 Go 与重建；500 章跨过单批队列容量。独立 Knowledge 故障测试覆盖未知 Usage、暂停与完成并发、响应丢失、Revision 替换、模型发送后 SIGKILL、API 重启、删除作品。UTC 日期切换、模型超时与后台离线检查也已通过完整回归。

旧 Go 与 Pi 各执行 24 个相同合成知识场景，状态、失败码、Usage、Attempt 与调用次数逐项一致，工程失败为 0；不把 HTTP Fixture 评分当真实模型质量。完整 `pnpm test`（含 Go Race、契约、Review/Knowledge HTTP Eval、Thinking、两个 Pi 执行器）已通过；完整 Web E2E、Typecheck、Lint、OpenAPI Check/Lint、go vet 已通过。Linux root 安装器隔离测试在 PR C CI 中已通过，本机另做语法检查。Lint 保留原 App.tsx Hook 警告，私有 OpenAPI 有五个未使用组件警告，无错误。

自动审查指出的响应上限不一致已修复：Review 继续限制 64 KiB，Knowledge 在 Pi Gateway、Task API、Zod 输出与 Go 领域解码器统一为 96 KiB，并把 96 KiB 纳入 Knowledge 策略合同，避免不兼容 Worker 领取正文。回归用 75 条合法证据断言验证 64–96 KiB 的 Knowledge 候选可完成提交，同时验证 Review 超过 64 KiB、Knowledge 超过 96 KiB 均返回 `LLM_RESPONSE_TOO_LARGE`。

新增安装脚本、人工逐类型切换和回滚；Go 双进程安装器拒绝 Pi/disabled/draining 归属，并拒绝在 ownership 状态上启动不兼容的旧回滚二进制。新 Node 发布包记录任务协议，核验 dist/worker 内容。未执行任何服务器操作。

## 一致性、恢复与费用答复

- 单有效执行器：Go 在领取和提交事务内检查持久 owner、epoch、Lease 与 deadline。切换先 drain，等待有效租约完成/到期，再递增 epoch；Go/Pi 同时存活不等于都能有效执行。节点崩溃可能重复付费调用，但旧租约不能重复有效提交。
- 模型与作品授权：独立后台身份只领取受控快照；公开 Bearer、Thinking RPC、签名 Key、后台 Token 不能复用。模型公共执行指纹与固定策略合同都须匹配。旧数据没有完整授权指纹时，Pi 需要作者重新确认。
- 预算：Go 在 Claim 预留，started 在外部请求前持久确认。Usage 缺失、发送情况不明时保守计费；只在能够证明未发送时退款。跨 UTC 日期结算不能返还新一天账本。重试由 Go 决定，Node 不自动重试模型。
- 恢复：API/Worker 重启沿用领域回执及任务登记。Complete 响应丢失重发同一请求不重复 apply 或结算；过期/取消/暂停/新 Revision/删除的迟到结果无法提交。完成或到期后清除任务正文快照，删除作品清除任务副本。
- 状态与资源：Review/Knowledge 使用各自 owner 的心跳与 Go 计数；Thinking 独立进程与会话额度。后台 Node 不读写 Go StateDirectory、Revision、Publication 或 Thinking 私有状态。操作流程记录专用用户、RPC 组、CPU、内存、健康和人工确认。
- 回滚：Pi → Go 使用同一 drain/epoch 流程，核对兼容 Go 协议后启动回退进程；不能用“同时启动两个服务”替代切换，不恢复旧数据覆盖作者新正文。
- 旧源码删除时机：只有另行授权的生产切换、隔离作品验收、预算/恢复与回滚验证通过后，才停止旧 Go Worker；源码及兼容测试在后续独立清理中删除。本次保留。

## 真实模型与剩余限制

本轮没有调用付费 DeepSeek，没有发送真实作品，qualityValidated=false。手动入口 `eval:pi:review:live` / `eval:pi:knowledge:live` 需要额外 `--confirm-fixtures` 与本地 Key，仅运行临时合成数据，最多两次调用、100,000 保守预留 Token，输出上限 2,048，无模型自动重试。显式确认、Endpoint 和预算护栏已有零调用测试。

生产迁移尚未执行。文件锁异常残留仍需运维核验；不自动抢占未知锁。原有上下文/单章大小限制和实体类型保持原样，超长 EPUB 章节的分块能力不在本轮迁移范围。固定 HTTP Fixture 不能证明模型语义质量或 500 章真实小说的长期记忆效果。Thinking 的本地资源独立，但同一 Provider 的远端限流仍需另行配置/观察。

## PR 链与验证记录（2026-10-22）

| 阶段 | PR | Base | 默认归属 |
| --- | --- | --- | --- |
| A：Go 任务协议 | [#22](https://github.com/story2u/ai-write-life-circle/pull/22) | main | Review/Knowledge 均 Go |
| B：Pi Review | [#23](https://github.com/story2u/ai-write-life-circle/pull/23) | codex/pi-worker-task-protocol | 均 Go，支持手动切 Review |
| C：Pi Knowledge | [#24](https://github.com/story2u/ai-write-life-circle/pull/24) | codex/pi-review-worker | 均 Go，支持两类独立手动切换 |

三个 PR 保持 Open 且 Mergeable。PR A/B/C 最新提交的 Push/PR CI 均为 4/4 成功，四条自动审查线程已解决。本地完整 `pnpm test`、`pnpm test:e2e`、Typecheck、Lint、OpenAPI Check/Lint、go vet 均退出 0。最新网关 Request ID 与 Unicode 兼容补充单测通过；Review 的策略不兼容拒绝测试不触发 started/fail 或模型调用。独立包已验证 Thinking / 后台协议与文件清单。Go/Pi 知识差分脚本进入常规 CI，默认仅隔离 HTTP Fixture。

本地测试日志位于 `.local/pi-migration/`，不包含生产配置。未合并、未部署、未切换生产执行器；真实模型质量未验证。
