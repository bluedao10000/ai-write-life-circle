# 小说智能流水线成熟度报告

- 状态：P0–P5 已实现并本地验证；P6 的失败转后台路径已实现；P7 的增量重跑与确定性评测已实现，judge/人工复核待真实模型批次执行。
- 设计边界：[novel-intelligence-pipeline.md](novel-intelligence-pipeline.md)
- 分支：`codex/novel-intelligence-pipeline`（仅本地提交，未推送、未合并、未创建 PR）

## 1. 交付摘要

| 阶段 | 交付 | 提交 |
| --- | --- | --- |
| P0 审计 | 8 个问题的现状回答、权威边界、批次/证据/失效决策 | `4d29889` |
| P1 章节目录 | EPUB 导入后自动打开目录、选中首章、展开卷、字数、搜索、空/错误/只读、500–2000 章 | `2f604e7` |
| P2/P3 分析作业 | Go 权威作业与 manifest、2–5 章批次、动态字节预算、`novel.analyze` worker、证据校验、候选落库 | `7dcbf88` |
| P5 工作台 | 「书 → 整书分析」：进度、暂停/继续/取消、逐条确认/忽略、原文定位、世界模型 | `8c2ecf7` |
| P6 大任务路由 | Thinking 因容量失败时提供「转为整书后台分析」，跳转到进度与审阅 | 本报告同一提交 |
| P7 增量与评测 | 只重跑受影响批次；dev/held-out 数据集、确定性 grader、judge 请求、人工复核表 | 本报告同一提交 |

正文（prose）仍然只存在 `DraftState.Revisions[]`。分析从不改写正文，也不自动确认 Canon。

## 2. 数据流

```text
作者点击开始
  → Go 冻结 AnalysisManifest（每章 revisionId/contentHash/wordCount/volume/order）
  → 按字节预算切成 2–5 章的批次
  → Node Worker 领取 novel.analyze（一次模型调用，无工具）
  → Go 校验 JSON schema 与每条引文（UTF-16 偏移、原文匹配）
  → 写入 proposed Finding 与 observed Entity
  → 全部章节批次完成后追加 synthesis 批次（只接收候选与证据，不接收整本正文）
  → 冲突/连续性候选
  → 作者逐条确认/忽略
```

权威分工没有变化：Go 负责身份、书籍/修订、授权、任务领取、预算预留/结算、证据校验和业务提交；Node 只执行一次有界的模型调用。

## 3. 接口

```text
POST /v1/studio/books/:book/analysis
GET  /v1/studio/books/:book/analysis
POST /v1/studio/books/:book/analysis/pause
POST /v1/studio/books/:book/analysis/resume
POST /v1/studio/books/:book/analysis/cancel
POST /v1/studio/books/:book/analysis/findings/:findingId/decision
```

契约：`packages/contracts/src/analysis.ts`；OpenAPI：`harness/contracts/analysis-api-v1.json`。

Agent 任务协议扩展：kind `novel.analyze`、claim kind `analysis`、输出 schema `novel-analysis-candidates-v1` / `novel-synthesis-candidates-v1`。旧 worker 不声明 `analysis`，不会领到新任务。

## 4. 关键不变量

- 一次请求不发送整本书；批次输入受 `MaxContextBytes - 4096` 约束，超限直接失败，不截断。
- 每条 finding 至少一条 evidence；引文必须逐字出现在同一批次、同一 `chapterId` 的正文中；找不到的 finding 被丢弃。
- 候选默认 `proposed`；只有作者 `confirm` 才变为 `author_confirmed` 并传播到实体。
- 未确认候选不进入 Canon，也不会被当作已确认事实注入 Thinking 提示词。
- 章节 revision 变化后，相关批次与 finding 标为 `stale`，作者决定保留；再次开始时只重跑受影响批次，不重跑全书。
- 运行中的旧 revision 任务在 `Prepare`/`Complete` 被 revision/hash 或 lease 拒绝，不能覆盖新结果。
- 未知模型用量保留预留额度，不当作 0 结算。

## 5. 验收证据

本地运行结果（2026-11-08）：

| 检查 | 结果 |
| --- | --- |
| `go test ./...`（apps/api-go） | 578 passed；新增分析包 5 个、分析路由 2 个测试通过 |
| `pnpm --filter @writer-agent/agent test` | 196 passed；新增 analysis worker 3 个、评测 3 个测试通过 |
| `pnpm --filter @writer-agent/web test` | 310 + 25 passed；新增分析工作台 6 个测试通过 |
| `pnpm --filter @writer-agent/web typecheck` | 通过 |
| `pnpm typecheck:agent` | 通过 |
| `pnpm eval:novel-analysis` | dev 2/2、held-out 2/2 通过；0 次模型调用 |
| `pnpm openapi:generate` / `openapi:lint` | 12 个契约生成，analysis 契约通过 lint |

覆盖的关键场景：

- 600 章目录搜索、卷折叠、当前章高亮、导入后自动展开与首章选中、布局偏好保留。
- 6 章 manifest 切成 4+2；幂等键复用；暂停/继续/取消；取消后不再被领取。
- 伪造引文、跨章引文、越界章节引文被丢弃；合法引文保存 UTF-16 偏移、revision、contentHash。
- 章节批次完成后自动排队 synthesis；synthesis 输入只含候选，不含正文。
- 作者确认传播到实体；忽略不影响其他已确认 finding。
- 正文改动后 finding/batch 标为 stale；再次开始只重跑受影响批次并读取新 revision。
- 运行中 revision 变化时 `Prepare` 返回 `ANALYSIS_REVISION_CHANGED`，批次标 stale。
- 评测 grader 拒绝未落原文的引文与 schema 外字段；dev/held-out 共享用例或内容会报污染。

## 6. 性能与规模

- 批次：每批 2–5 章，按 `MaxContextBytes - 8192` 动态装箱；5+1 的尾批会重平衡为 4+2。
- 目录：首屏读取 head revision 字数；600 章测试覆盖搜索与折叠。目录 API 的 `wordCount` 只读最后一个 revision，不解析全部历史。
- 失效检测：只 stat「未完成批次」和「未决 finding/entity 证据涉及的章节」，不扫描全部 2000 章，也不解析 JSON。
- 分析状态：单机 JSON `analysis/<bookKey>/state-v1.json`，与现有 Go 状态一致；写入走 `StateLock` + 原子写。
- 响应：分析视图剥离 lease、meter、manifest 指纹与 draft stat 字段，避免泄露执行器内部状态。

## 7. 部署与回滚

发布顺序：

1. 部署 Go API（接受 `analysis` claim、准备 `novel.analyze` 任务、暴露分析路由）。
2. 部署 Node Worker（`kinds` 声明 `analysis`，加载新执行契约）。
3. 部署 Web（「整书分析」入口与 Thinking 失败转后台）。

回滚：

1. 先暂停分析作业，等待运行中批次结束或过期。
2. 回滚 Web 不影响已产生的分析数据；回滚 Worker 后 Go 不再有执行者，批次保持 pending。
3. 回滚 Go 前删除/保留 `analysis/` 状态均可；旧二进制不会读取该目录。
4. `tasks-v1.json` 中的 `novel.analyze` 记录不会被旧 worker 领取。

未执行生产部署；需要用户明确授权后才推送/部署。

## 8. 使用说明

1. 打开作品 → 「书」→「整书分析」。
2. 点击「开始整书分析」；进度按批次更新，可暂停、继续或取消。
3. 在「候选发现」逐条查看标题、陈述、置信度、另一种解释与原文引文；点「查看原文」跳转章节。
4. 「确认」把候选和关联实体标为已确认；「忽略」保留记录但不采纳。
5. 「世界模型」按人物/地点/组织/物品/规则/事件/线索分组，显示状态、别名、属性与来源章节。
6. 正文改动后重新进入会看到失效标记；再次点击「重新分析」只重跑受影响章节。

Thinking 中如果一轮问题因容量失败，失败卡片会提供「转为整书后台分析」，创建作业后跳转到同一工作台。

## 9. 已知限制

- LLM judge 只提供请求构造与评分解析（`novelAnalysisJudgeCase`），未在 CI 中调用真实模型；人工复核表 `--review-sheet` 生成后仍需作者/编辑填写。合成 provider 只证明工程链路，不证明模型质量。
- 世界模型目前按名称/别名与类型做确定性合并；跨语言别名、同名不同人仍需作者在审阅时区分。
- 单章超预算直接失败，不自动切段；切段需要新的证据偏移协议。
- synthesis 输入上限 200 条候选；超出部分按标题排序截断，属于已知取舍。
- 分析状态为单机 JSON，不支持多副本并发写；与现有 Go 状态模型一致。
- Thinking 的容量失败转后台是显式恢复动作，不是自动意图识别；避免在作者未同意时产生整书模型费用。
- EPUB 导入本身未改动；P1 只修复导入后的目录打开与首章选中。

## 10. 后续建议

1. 用真实模型跑 dev/held-out，记录 judge 分数与人工双标，形成质量基线。
2. 为 2000 章真实书稿做一次端到端性能记录（manifest、批次、synthesis、视图）。
3. 评估把已确认世界模型以「已确认事实」注入 Thinking Context Builder；未确认候选保持不注入。
4. 章节超预算时提供「按场景切分」协议，而不是失败。
