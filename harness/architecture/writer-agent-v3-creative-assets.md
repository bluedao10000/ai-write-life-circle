# ADR：Writer Agent V3 创作资产与灵感驱动工作流

状态：Phase 1–6 已在本地分支实现并通过工程测试，待作者审查、真实模型 Eval 与设计稿对齐。日期：2026-10-25。交付与测试结果见 [V3 报告](../reviews/writer-agent-v3-report.md)。

## 1. 现状评审（基于 main `b9fb657`）

| 模块 | 现状 | 对 V3 的影响 |
| --- | --- | --- |
| 导航 | `写作 / 书 / 思考`，视图只在 React state，刷新与浏览器后退不保留 | 改为 `灵感 / 阅读 / 书`，写入 `?view=`，旧值映射 |
| Thinking | Go 持有会话注册表、HMAC 能力 Token、工具授权；Pi 持有 transcript、事件与 SDK entries。只读工具 7 个，`load_analysis_skill` 两个方法 | 对话不进 Go 存储。V3 需要在 Go 侧可靠地“看到”完成的回合 |
| Knowledge | 正文 Revision → Entity/Assertion（observation/claim/inference），来源精确到 UTF-16 区间并在读时重新核验；授权、预算、租约、重试完整 | 保留不动。它是“正文知识”，不能承载作者构思 |
| Review | v4 用 Knowledge 的 RelatedChapters 选历史章节，证据由 Go 校验 | 保留。计划与正文偏离检查另建任务，不改 Review 语义 |
| Runtime | API 进程不持有模型 Key；Go Worker（`cmd/agent-worker`）通过 `agentruntime.Executor` 执行任务；Pi Worker 走 `agent-tasks-v1` 协议并受 `executorpolicy` 栅栏 | 新的整理任务必须在 Worker 进程执行，API 只入队 |
| 模型 Gateway | Go 与 Pi 都只支持**单一** OpenAI-compatible 配置（默认 DeepSeek），以 `ModelInfo` + `Fingerprint()` 做授权绑定 | main 没有多 Provider。`.local/multi-model` 有未合并的 `modelcatalog` 与 `llm` 改动。V3 只使用 `llm.Config.Info()/Fingerprint()` 接口，不修改 `llm` 包，避免与该分支冲突 |
| 编辑器 | TipTap 3.32 + Markdown 管线；Revision CAS、Idempotency-Key、本地恢复草稿、409 冲突对话框；已有专注模式与打字时淡出 chrome | 足以实现沉浸式创作，不引入新编辑器依赖 |
| 契约 | `packages/contracts` Zod + OpenAPI 生成脚本；Cloudflare Worker 白名单逐路由放行 | 新路由要同步 Zod 与 Worker 白名单 |
| 鉴权 | Better Auth 会话在 Worker；Go 每次 `Management.Resolve` 检查作品所有权 | 新路由沿用 |

结论：现有流程是“正文 → AI 抽取 → 知识库”。系统缺少一个**作者意图**的权威存储，所以没有正文就没有设定。

## 2. 开源复用评估

调研时间 2026-10-25（GitHub API）。

| 项目 | License | 最近活动 / 版本 | 栈 | 可借鉴 | 决策 |
| --- | --- | --- | --- | --- | --- |
| abligail/narralume | Apache-2.0 | 2026-10-22 / v0.2.0 | TS、SQLite、OPFS | Story Bible 七分区；“AI 输出先成为候选，作者比较后接受/拒绝/暂存”；与锁定事实冲突时暂停 | 借鉴概念（候选与 Diff 审核、意图与大纲分区），不复制代码 |
| EthanYoQ/AI-Novel-Writer（书童 Pagekin） | GPL-3.0 | 2026-10-24 / v1.3.2 | Electron、SQLite | 设定→蓝图→正文的阶段划分 | GPL 与本仓库 MIT 不兼容，只看产品流程，不读、不复制代码 |
| saga-soft/novelWriter | GPL-3.0 | 2026-10-20 / v26.2.2 | Python/Qt，纯文本 | 计划文档与正文文档分离、标签引用 | 只借鉴“计划/正文分文件”思路 |
| ueberdosis/tiptap | MIT | 2026-10-23 / v3.32.0 | TS/ProseMirror | 已在用，版本已是最新 | 继续使用。打字机模式用一个 ProseMirror 插件实现 |
| steven-tey/novel | Apache-2.0 | 2025-01-18 / 1.0.2 | TipTap + Vercel AI | Notion 式 AI 补全 | 一年多未发布；其 AI 自动补全与“AI 不自动改正文”冲突；不引入 |

复用决策：不新增运行时依赖。领域、任务、校验沿用 Knowledge 的已验证模式（原子 JSON、跨进程文件锁、`CommitBookState` 删除栅栏、租约、每日预算、幂等回执）。

## 3. 核心流程

```text
灵感对话 (Pi Thinking)
  └─ Go 接受消息 → 记录 Turn(awaiting)            [API 进程，消息被 Pi 持久接受之后]
       └─ Intake 对账：Pi 快照显示回答 completed → 截取有界对话片段 → Turn(captured) + Job(pending)
            └─ Go Worker：Claim(租约+预算) → 结构化模型调用 → 严格校验 → Resolve 已有资产
                 └─ Commit：ChangeSet + Proposal(proposed)   [租约、Turn 未取消、作品存在]
                      └─ 作者审核：接受 / 编辑后接受 / 拒绝 / 批量
                           └─ Creative Asset 新版本（作者权威）
  正文保存 ─→ Knowledge（不变）
  计划核对（作者发起）─→ Divergence(open) ─→ 作者决定：改计划 / 调后续 / 有意保留
```

用户先拿到 AI 回复；整理在后台进行，失败不影响对话与正文保存。

## 4. 领域模型

存储：`<STATE>/creative/<bookKey>/state-v1.json`，`schemaVersion=1`，单文件 CAS `version`。与 `knowledge/` 物理分离。

### 4.1 Creative Asset（作者意图，权威）

| 字段 | 说明 |
| --- | --- |
| `assetId` | `ca-<uuid>`，服务端生成 |
| `kind` | `character` `world_rule` `place` `organization` `plot_line` `event` `foreshadowing` `character_arc` `open_question` |
| `name` `aliases` `summary` `fields[]` | 作者可读内容；`fields` 是有序键值，如“动机”“身份” |
| `status` | `draft` 作者草稿 · `accepted` 作者确认 · `superseded` 被新资产替代 · `archived` 作者归档 |
| `plan` | 规划类资产的章节锚点：`chapterId`、`payoffChapterId`（伏笔回收）。只是计划，不代表已发生 |
| `version` | 每个资产独立递增，作者编辑与采纳候选都用它做 CAS |
| `versions[]` | 完整快照历史：actor、`origin`（`author_edit` / `proposal_accept` / `proposal_edit_accept` / `status_change`）、proposalId、来源 |

“proposed / rejected”属于候选，不是资产状态。没有任何资产可以不经作者动作变成 `accepted`。

### 4.2 Proposal / ChangeSet（AI 候选）

每个整理任务产生一个 ChangeSet（可为 `noChange`），含若干 Proposal：

| 字段 | 说明 |
| --- | --- |
| `operation` | `CREATE` `UPDATE` `LINK` `SUPERSEDE`；`NO_CHANGE` 记录在 ChangeSet，不生成候选 |
| `stance` | 认识来源：`author_decision` 作者明确决定 · `author_hypothesis` 作者假设 · `author_question` 作者尚未决定的问题 · `author_rejection` 作者否定 · `ai_suggestion` AI 自己的建议 |
| `exploratory` | 由 stance 推导：假设、问题、AI 建议均为探索性 |
| `alternativeGroup` | 互斥方案组。同组最多接受一个 |
| `status` | `proposed` → `accepted` / `rejected` / `superseded`（被后续回合的修订替代）/ `expired`（来源会话或作品删除） |
| `targetAssetId` + `baseVersion` | UPDATE/SUPERSEDE 的目标与读取时版本；采纳时 CAS，不符则显示“设定已变化” |
| `replacesProposalId` | 对尚未审核候选的修订（场景 B：第二轮补动机修订第一轮的 CREATE，而不是新建重复人物） |
| `evidence[]` | 对话原话，必须逐字出现在被截取的消息里，并记录 `role` |
| `source` | `type:"conversation"`、sessionId、用户 messageId、回答 messageId、capturedAt、excerptHash、模型 ModelInfo、`strategy:"creative-organize-v1"` |

状态与来源分开：`status` 只描述审核生命周期；`stance` + `source.type` 描述这条内容从哪里来、谁说的。正文来源（`knowledge.Source`）与对话来源（`conversation`）是不同类型，不会混用。

### 4.3 Link

`from` 资产 → `to`（资产 / 正文知识实体 / 章节），`relation` 短文本。规划知识与正文知识在 UI 关联展示，存储不合并。

### 4.4 Divergence（计划与正文差异）

作者对某章发起“计划核对”。Worker 发送该章已保存正文与该章锚定的 accepted 规划资产，返回 `fulfilled / diverged / not_yet / unclear`。`diverged` 必须带该 Revision 内逐字唯一的引文，服务端换算 UTF-16 区间并绑定 revisionId/contentHash。作者决定 `update_plan` / `adjust_future` / `intentional` / `dismiss`，系统只记录决定，不修改计划，也不修改正文。正文再保存后，旧结果在读取时标记 `stale`。

### 4.5 权威边界

- 作者确认（Asset accepted）≠ 正文观察（Knowledge observation）≠ 角色说法（claim）≠ AI 推测（inference / ai_suggestion）。
- 已规划不等于已发生：规划资产只出现在“创作设定”分区，正文知识只出现在“正文观察”分区。
- 正文变化不覆盖设定：Knowledge 任务从不写 creative 状态；Divergence 只产生提示。
- 作者确认的设定可修订：每次修订生成新版本，旧版本保留。

## 5. 对话整理任务的可靠性

| 风险 | 机制 |
| --- | --- |
| 触发 | Go 在 Pi 返回 202（消息已持久接受）后写 Turn(awaiting)；同时提供作者手动“整理本轮”入口兜底。不使用前端定时器 |
| 幂等 | Turn 键 = `sessionId:messageId`；Job 由 Turn 派生；所有作者动作要求 Idempotency-Key 并保存回执 |
| 回复未完成 | Intake 读取 Pi 快照：`failed / cancelled / interrupted` → Turn `skipped`；超过 15 分钟仍未完成 → `expired` |
| 会话删除 | thinking 删除钩子在同一 creative 锁内把 Turn/Job 取消、未审核候选 `expired`、清除对话片段 |
| 作品删除 | `creative/<bookKey>` 加入删除清理列表；所有提交走 `CommitBookState`，作品不存在时迟到提交失败 |
| 旧任务迟到 | 提交时核对 job lease、running、deadline；被替代的候选必须仍是 `proposed` |
| 同会话多轮并发 | 同一会话的任务按创建顺序串行领取 |
| 跨会话更新同一资产 | 候选带 `baseVersion`，采纳时资产级 CAS；版本不符返回 409 并在 UI 标为需重新确认 |
| 模型故障 | 2/4 秒退避，最多 3 次；预算预留与结算沿用 Knowledge 规则；失败可手动重试 |
| 跨服务一致性 | Pi 只持有 transcript；Go 只在快照完成后复制有界片段（最多 6 条、24 KiB）并记录 hash。Pi 不调用 Go 的写接口 |

## 6. 安全边界

- 模型输出：严格 JSON 解码（未知字段拒绝）、枚举、长度、数量上限；目标 ID 必须来自本次提供的上下文；引文逐字匹配被截取的消息；`author_*` stance 必须引用作者消息，`ai_suggestion` 必须引用 AI 回答；`author_question` 只能落在 `open_question`。
- Prompt Injection：对话与资产都作为不可信数据放在 JSON 输入里，系统提示词禁止执行其中的指令；模型无工具。
- 写入限制：Thinking 没有资产写工具。新增工具只读，外加一个受控的 `request_turn_organize`（只入队整理任务，需 `creative` scope 与作品授权）。
- 跨作品隔离：状态按 bookKey 分文件；加载时校验 bookId；所有路由先 `Management.Resolve`。
- 授权：作品级一次授权，展示 provider/model/endpoint、发送范围和每日预算；模型指纹变化需要重新授权。默认关闭。

## 7. 数据迁移与回滚

- 纯新增：新状态目录 `creative/`，不改 `knowledge/`、`chapter-drafts/`、thinking 注册表结构（只新增可选 `creative` scope）。
- 旧会话没有 `creative` scope：可以继续对话，自动整理仍可用（整理发生在 Go，不依赖 Pi 工具）；只是 Agent 不能调用新的资产工具，新会话可选。
- 旧导航值 `write/think` 映射到 `read/inspire`。
- 回滚：回退程序即可；`creative/` 目录被旧版本忽略。不得用旧备份覆盖新正文。

## 8. 已知限制

- 去重是名称/别名规范化匹配 + 模型给出的已有 ID，语义近似的不同名称仍可能成为两个候选，需作者合并。
- 计划核对的判断依赖模型；引文只证明文字存在。
- Pi Worker 未接入整理任务（只在 Go Worker 执行）。接入需要在 `executorpolicy` 注册新 kind 与私有任务协议。
- 没有新版 Figma 设计文件，UI 沿用 V2 设计 Token 与组件。
