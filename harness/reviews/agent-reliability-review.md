# Writer Agent Reliability Review & Improvement

日期：2026-10-29。审查基线：`4dfdca1d8322f1bdc73017ea67eb1b745efe71c1`（本次开发前 HEAD）。只使用隔离 HTTP Provider、临时目录、合成作品。未访问生产状态、未调用付费模型、未部署或合并。

## 1. 实际架构与已有能力

浏览器 `useThinking` → 同源 Worker 的路由白名单和签名身份 → Go `thinking.PublicHandler`（归属、授权、模型、点数）→ loopback PiHost → Pi SDK 1.3.0 → 显式 Provider。Story Tools 回到独立 Go 内部 listener；Pi 不持有 Go StateDirectory、作者文件或任意 Shell 权限。

后台 Review/Knowledge 使用另一套 Go task authority：claim/start/heartbeat/complete、executor epoch、领域租约、完成回执；Node Scheduler 只返回候选。不能把后台已有的租约误认为 Thinking 已有相同机制。本次不替换后台调度器。

已读取根入口、CLAUDE、任务路由、Pi 工作流、Pi/统一 Runtime/灵感可用性/前端架构及适配器文档、部署指南、CI、Thinking/Provider/工具/后台调度器/Go 授权与预算/浏览器控制器/共享契约和已有测试。历史 `architecture.md` 的“暂不开发 SDK”和两个 README 的 Go-only 描述已过时；以当前源码和进程测试为准。

| 能力 | 基线分类 | 源码证据 | 测试证据 / 限制 |
| --- | --- | --- | --- |
| 用户消息先落盘后执行 | 已实现且有测试 | `apps/agent/src/runtime/pi-host.ts` accept 的 message_started 写盘在 run 之前；Store fsync/rename | runtime/chat；真实进程 SIGKILL 后用户消息保留。202 之前 Go→Pi handoff 仍可能不确定；客户端用原键确认，不能声称未确认发送已被接受 |
| 消息幂等、长会话重建 | 已实现且有测试，但有预算缺陷 | `Saved.requests`、Go Requests、SessionManager entries | chat 的多轮/模型切换/重启；新增小额度 15 轮回归证明预算缺陷 |
| 游标事件、SSE、轮询 | 已实现但首次重连缺陷 | `server/http.ts` events；`useThinking` 首次 get catch 无重试 | `test-thinking-agent.mjs` 的游标/SSE；新增浏览器控制器断网测试 |
| 删除、撤销授权、迟到结果拒绝 | 已实现且有测试 | Go Nonce/Deleted、Pi tombstone、每次工具与模型前授权 | Go service tests、runtime/budget、进程离线删除；不绕过墓碑 |
| Thinking SIGKILL 恢复 | 已实现中断识别，缺少 Resume | `Store.recover` 标记 interrupted，未重新执行 | 已有真实 SIGKILL 测试；基线只能发新消息 |
| Thinking 执行租约、Run checkpoint | 完全缺失 | 基线只有进程锁、active Map 和 entries，没有持久 run/lease/epoch | 后台 `agenttasks` 已有相应机制，不能替 Thinking 作证 |
| 自动压缩 | 文档声称受预算控制，未有覆盖证明 | `session.compact` 与 prompt 分离；没有独立的授权/预留/摘要完整性验证 | 不将 SDK 文档等同于部署保证；本次关闭旧 compact 入口，以作者确认的续谈上下文恢复 |
| DeepSeek / OpenAI 显式选择 | 已实现且有测试 | Config registry、Go chooseModel、每条消息 modelId、Provider 隔离 | config/chat/Go model switch 测试；OpenAI GPT-OSS 经 Bedrock 是已有部署选项，不能伪称本次验证了 OpenAI 官方线上 API |
| 工具权限与副作用 | 已实现且部分有测试 | scope 白名单、Go 归属、只读工具；request_turn_organize 是排队副作用 | registry 去重只在单次运行内；Go AcceptTurn 有业务幂等。恢复不能依赖内存 Set |
| 错误分类、恢复 UX、Run 追踪 | 部分实现但不完整 | 原 safeCode 抹平 Provider 错误；UI 重试只复制输入；无独立 Run | 本次增加 Failure、RunRecovery、真实 resume、聚合指标和离线 Eval |
| Dreaming | 完全缺失（符合当前边界） | 当前没有历史自动升级正式设定的后台学习任务 | 仅设计新 ADR；不实现自动写入 |

## 2. 缺陷与优先级（基线证据）

| ID | 优先级 / 分类 | 文件与触发条件 | 影响 | 可复现验证 |
| --- | --- | --- | --- | --- |
| REL-01 | P0 / 缺陷 | `pi-host.ts` streamSimple，每次 reserve 后已知 usage 不结算 charged | 小请求反复消耗完整 ceiling；讨论很快 SESSION_BUDGET_EXCEEDED | `reliability.test.ts` 18,000 上限、15 次 120-token 回复；基线数轮内 failed，修复后 charged=1,800 |
| REL-02 | P0 / 缺陷 | `useThinking.ts` 首次 GET 失败，只 setError；capabilities/models 失败后不重试 | 刷新恰逢断网/Pi 重启后永远不恢复 | initial snapshot + online 事件；真实浏览器断网刷新后还复现了 capability 缓存为 null、恢复后发送永久禁用，增加 metadata 重连回归；修复前无法恢复，修复后自动读服务端 |
| REL-03 | P0 / 缺陷 | `PiHost.accept` 在 await authorize 前读快照，cancel 无版本栅栏 | 用户停止期间等待授权的旧请求仍接受；Resume 同类竞态 | `concurrency.test.ts` 用 Promise gate 精确阻塞授权，cancel 后 release；基线 Missing expected rejection |
| REL-04 | P0 / 缺失 | `Store.recover` 只改消息；UI 没有恢复接口 | 中断后只能重新发问题，费用与上下文不明 | 新真实 `/resume`、同键重放、SIGKILL+Resume 进程集成 |
| REL-05 | P0 / 缺陷 | Provider 429/500/截断在 SDK 中成为 MODEL_REQUEST_FAILED | 无法区分限流、配置、上下文和未知费用 | 隔离 HTTP Provider 429/500/400/length/timeout 注入；检查分类和恰好一次模型请求 |
| REL-06 | P0 / 缺失 | Thinking 无持久执行版本/业务检查点 | 无法安全区分可重构执行与副作用未知结果 | 新 lease、epoch、checkpoint、runId guard；工具副作用后恢复拒绝测试 |
| REL-07 | P0 / 缺陷 | `ThinkingPanel`/`InspirationWorkspace` 的“重试”仅恢复草稿 | 操作名称与后端状态不一致；误导重复发送 | 新 RunRecovery 费用确认、恢复当前 Run；旧按钮改名“复制原问题到输入框” |
| REL-08 | P0 / 恢复缺失 | 输入 bytes 保守上限、context window、200 message / 20k event 上限 | 长聊在边界停止后无明确路径 | 保留预算/存储上限；CONTEXT_OVERFLOW 要作者确认续谈要点；额度/存储上限明确新话题。未承诺无限历史 |
| REL-09 | P1 / 缺陷 | 工具没有独立 timeout，SDK 将 tool error 交给模型继续 | 失败后可能再付费生成“成功”回答；耗尽整轮时间 | 工具失败立即停止，5s 工具 timeout + 整轮 deadline；失败/超时测试 |
| REL-10 | P1 / 缺失 | 无 run_id / trace_id / checkpoint 指标 | 故障无法关联，无法量化恢复 | 元数据 JSON 日志、私有 health 聚合、`eval:reliability` |
| REL-12 | P0 / 准入竞争 | `Store` 并行启动者可能交错 stale PID unlink/create；close 重入可移除下一实例的锁 | 破坏单写者前提 | 原子 admission guard 串行准入；guard 占用和 close 重入的确定性测试 |
| REL-11 | P2 / 设计缺失 | 长期记忆缺少作者裁决契约 | 建议可能在未来被误写成事实 | Dreaming ADR：候选、冲突、作者确认、版本、撤销；本次只设计 |

## 3. 修改设计与边界

完整方案见 [Reliability ADR](../architecture/agent-reliability.md)。消息、Run 和内部步骤分开：已接受的用户消息不重建；每次 Run 有独立 attempt 与 trace；模型/工具边界持久 checkpoint。`accepted → running ↔ checkpointed → completed/failed/interrupted/cancelled`。Session 继续使用 idle/running/deleted，兼容已有前端和 Go 结算。

Resume 从已持久化的“当前用户请求之前”业务检查点重建 SDK 会话，重新走 Go 归属/模型/授权/预算，再走 Pi 校验；不是复活 SDK 内部 token stream。保留失败回答和部分文本，不增加假用户消息。只恢复最近失败/中断且 resumable 的 Run；取消、删除、作用域/模型变化、已进入排队副作用的 Run 均拒绝。

未知付费调用无自动重试。恢复请求强制 confirmAdditionalCost=true，UI 显示可能额外费用；恢复请求自身有稳定 Idempotency-Key。仅事件/快照 GET 自动重连，现有后台 completion receipt 的幂等重试不变。

上下文过长时作者填写续谈要点（引用、修订、已定事项与未定假设），明确授权它替换较早的模型上下文。完整历史与原卡片保留，重要上下文由作者决定；不声称机器摘要必定无损。授权依然只由 Go grant 决定，要点不能扩大权限或修改正式设定。

## 4. 实施范围与文件

- `packages/contracts/src/thinking.ts`：Failure / Run / Recovery；兼容老 session 的可选 run。
- `apps/agent/src/runtime/{pi-host,reliability,model-gateway}.ts`：准入栅栏、单写者持久租约、checkpoint、Resume、预算结算、错误分类、结构化追踪、低维聚合。
- `apps/agent/src/sessions/store.ts`：旧 schema=1 增量字段、重启终态、删除清除 checkpoint/attempt/lease。
- `apps/agent/src/tools/registry.ts`：有界工具时限，区分授权拒绝与临时授权服务中断。
- `apps/api-go/internal/thinking/{http,model,reliability}.go`：真实 resume 路由、统一费用确认、相同模型/范围校验、Go 预算不旁路、取消回执栅栏、错误 requestId 与分类。
- `apps/web/src/features/thinking/*`、`InspirationWorkspace.tsx`、`thinkingApi.ts`、Worker 白名单：断线恢复、真实恢复与授权操作、错误/Trace 展示，保留草稿/历史。
- 自动化：Agent fault tests、Go service tests、Web controller/UX tests、真实 Go/Pi restart 集成、Reliability Eval、CI 门禁。章节编辑、自动保存、出版、正式知识 apply 路径未修改。

## 5. 验证与结果

Eval 只统计隔离故障场景，不能外推生产可用性或文学质量。taskCompletionRate 的分母包含故意不恢复的故障，不能把它解释为线上完成率。真实进程 SIGKILL 与 Go restart 在 `test-thinking-agent.mjs`，不混同 Store 单测模拟。

| 验收场景 | 自动化证据 | 验证结果 |
| --- | --- | --- |
| 浏览器执行中刷新、首次读取断网、重新联网 | `apps/web/scripts/test-thinking-funnel.mjs`、thinkingController tests | 从服务端恢复消息；会话和模型能力目录都重连，发送按钮恢复 |
| Pi SIGKILL、Go API 重启 | `scripts/test-thinking-agent.mjs`；Pi Worker integration | 中断保留输入、显式 Resume；Go 重启后回执/预算/历史保留 |
| 429、500、超时、截断、上下文溢出 | `apps/agent/test/reliability.test.ts` | 规范错误分类；失败调用无自动重试；未知用量保留预留 |
| 工具失败、重复调用、未知副作用 | fingerprint/runtime/reliability tests；Go creative integration | 单轮重复读取去重；工具失败立即停止；副作用执行后拒绝恢复 |
| 长对话与预算、旧数据迁移 | 小额度 15 轮回归、legacy accounting test、真实浏览器续谈要点 | 有效 usage 结算；旧会话仅结算已知预留；容量超限由作者确认上下文继续 |
| 主动取消、Resume/Cancel 竞争、离线取消 | admission gate test、reliability tests、真实进程 offline cancel | 取消有持久栅栏；新幂等键也不能复活已取消 Run |
| 删除后迟到结果 | reliability delete、Go ownership race、进程离线删除 | 墓碑阻断后续写入，抹除消息、entries、checkpoint、runs、lease |
| 撤销授权，再授予相同范围 | authorizationVersion test、Go scope preflight | 旧 Run 仍被拒绝，恢复不能自行重新授权 |
| 用户主动切换模型、同 ID 配置改变 | chat/config/Go model switch tests | 明确选择可切换；不 fallback；同 ID 改变 Provider 配置要求新话题确认 |
| 同请求并发/重复提交、Go API 重启后重放 | simultaneous admission、Go resume service、进程 tests | 一个用户消息、一份回执；已接受的恢复意图不会再次调用模型 |
| 错误 UX 与费用确认 | RunRecovery 4 tests、controller 14 tests、真实浏览器 | 未确认费用按钮禁用；操作调用真实 resume；保留失败文本、错误码与 Trace ID；取消的请求回执不会卡住后续草稿 |

最终验证：

- `pnpm test:api:go`：全部 Go 包通过 `-race`。
- `pnpm test:agent`：34 项通过；`pnpm eval:reliability`：18 项通过。
- Web 单测：221 项通过；Worker/D1 单测：23 项通过。
- `pnpm test:thinking`、Web `test:thinking`、`pnpm test:pi:worker`、`pnpm test:creative`：真实隔离进程/浏览器集成通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm openapi:check`、`pnpm openapi:lint`、`pnpm test:style` 通过。构建保留 chunk 大小提示，OpenAPI lint 保留 license/未引用组件提示；无阻断错误。

Reliability Eval 的 9 个计量场景中：6/9 完成，另 3 个故意注入且不恢复的 timeout/tool failure/unsafe side-effect 被安全停止；恢复成功 5/5，23 条已接受消息丢失 0，重复工具执行 0，非预期重复模型调用 0，错误与实际状态一致 9/9。本机 Mock HTTP 故障恢复多次运行约 70–130ms（不含真实网络、排队和作者确认时间；不是 SLA）。原始报告生成于 `.local/evals/agent-reliability/report.json`。

## 6. 未解决风险与后续

- 仍是单 Pi 进程/私有文件目录，进程锁必须独占。若在启动准入临界区崩溃，遗留 `.process-lock-admission` 需要人工核验，不按年龄删除。持久租约不是分布式共享存储协调器；多副本需要外部事务存储和真实 fencing。现有 Go O_EXCL 遗留锁的人工恢复策略不改。
- 输入容量仍采用偏保守 UTF-8 bytes 上界；可早于供应商实际窗口拒绝。历史上限仍保留，尚未实现分页归档和自动无损压缩。
- 旧会话没有业务 checkpoint 时历史可读，但不伪造可恢复 Run；可以发新问题继续。只支持恢复最近一次安全 Run，不能任意跳到旧模型步骤。
- 模型返回合法却不准确、重要上下文遗漏等语义风险需要作者检查；本次不付费做真实模型评估。
- 已进入副作用的任务停止恢复，需作者检查现有整理结果；不实现跨系统 exactly-once 模型调用或推测超时请求是否收费。
- 文件系统损坏、磁盘满、宿主机掉电、跨机脑裂未做破坏性测试；fsync/rename 不能替代独立备份。完整进程生命周期日志在 SIGKILL 时可能只有 accepted/provider 记录，重启以持久状态为准。
- 受管 Go Session 与 Pi state 无跨文件事务，202/网络确认仍可能不确定；不自动重发新的付费意图。必要的原键确认由持久回执保障。

## 7. 数据迁移与回滚

不迁移正文/知识/出版数据库。Pi schema=1 的 epoch/checkpoint/runs/lease/view.run 为增量字段；旧数据读取不重置实际 usage 或幂等键；accountingVersion=2 惰性迁移只对 incomplete=false 的旧会话，将已知预留结算为 input+output，未知费用预留保持原值，并有迁移测试。Go registry 的 cancelledReceipts 与 Session resumeBlocked 为可选字段；删除墓碑始终保留。

上线需要用户另行授权。先停止 Pi，备份整个 Pi 私有目录（保持 0700/0600）和 Go 状态，联合发布 Go API、Pi、Web；新 Run 字段通过版本头协商，对旧 Web 返回兼容投影。检查协议和 health 后用合成作品演练。

回滚优先关闭 Thinking、保留写作，使用理解新 Run 契约与取消回执的兼容版本。**新 API 会为旧 Web 投影兼容 Session；旧 Pi 的 schema=1 严格校验仍不能读取持久 run；旧 Go 会忽略取消回执；不能直接滚回旧组合并保持恢复开放。** 若必须回旧版本，先停服务、以离线单向适配器从公开视图去掉新字段，并永久禁用恢复/原键重投；此适配器未实现，不把它列为已验证回滚。不得恢复旧快照覆盖新消息、正文、预算或删除墓碑。当前变更可在开发分支撤回，不影响生产。
