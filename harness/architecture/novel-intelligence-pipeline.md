# 小说智能分析流水线（Novel Intelligence Pipeline）

状态：已接受  
日期：2026-11-08  
范围：`codex/novel-intelligence-pipeline`

## 问题

三件事同时存在：

1. EPUB 导入后章节已写入服务端，但阅读页左侧目录默认关闭，作者看不到章节结构。
2. 整本书一次性交给模型必然超出上下文；现有 `knowledge.extract` 只接受单章，且超过 64 KiB 直接拒绝。
3. 模型抽出的知识只有候选实体，作者看不到来源、无法逐条确认，也没有跨章冲突与世界模型。

本 ADR 固定数据边界、任务边界和作者可见的流程。实现按阶段提交，不回退到“缩小范围后仍一次请求整本书”。

## 现状审计（Phase 0）

### 1. EPUB 导入后 `ManagedBook` 与 `WorkspaceSnapshot` 各包含什么

`ManagedBook`（`packages/contracts/src/management.ts`）只有目录：

```ts
{ bookId, title, version, readOnly,
  volumes: [{ volumeId, title, archived? }],
  chapters: [{ chapterId, title, volumeId?, archived }] }
```

不含正文、字数、时间戳或 revision。导入提交后 Go 返回 `version: 1` 的新书（`application/imports.go`）。

`WorkspaceSnapshot`（`packages/contracts/src/index.ts`）是前端聚合：

```ts
{ projectId, projectTitle?, capabilities?,
  chapters: [{ id, volume, title, meta, wordCount? }],
  knowledge, document, markdownByChapter?, chapterVersions,
  proposals, decisions, chat, challenge, sequence,
  currentChapterId, preferences? }
```

`loadWorkspace` 把 `GET /v1/projects/:id/workspace` 与 `GET /v1/projects/:id/chapters` 合并；正文不在快照里，打开章节时再取 `GET /v1/projects/:id/chapters/:id`。

### 2. 为什么章节目录不自动显示

`useWorkspaceController` 的默认布局是 `leftOpen: false`。导入完成只调用 `open(next, firstChapterId)`，设置当前章并递增 `generation`，没有设置 `leftOpen`。`WritingSpace` 仅在 `layout.leftOpen && !focus` 时渲染左栏。

### 3. 目录由哪个 API 提供

两条来源，必须按 `chapterId` 关联，不能按下标：

- 左侧 `ManagedDirectory` 使用 `ManagedBook`，来自 `GET /v1/studio/books` 与结构变更 `PUT /v1/studio/books/:bookId/structure`。
- 阅读顺序与字数使用 `GET /v1/projects/:id/chapters`。托管书的 `DirectoryProvider` 原先只返回 `chapterId/title/order`，本阶段补上当前 head revision 的 `wordCount`；读不到时省略，不伪造 0。

### 4. EPUB 正文如何保存与读取

导入提交为每章写入一份不可变初始 revision，保存在 `chapter-drafts/<bookKey>/<chapterId>.json` 的 `DraftState.Revisions[]`。正文只在 revision 的 `markdown` 中；`ManagedBook` 只保存目录元数据。读取走 `GET .../chapters/:chapterId` 的 `headRevision`，保存走 `POST .../revisions` 的 compare-and-swap。

### 5. Knowledge Extraction 是否支持批量

不支持。每个 chapter revision 一个 job，一次只 claim 一章；队列上限 256 pending / 10000 total；单章超过 64 KiB 返回 `KNOWLEDGE_CHAPTER_TOO_LARGE`。没有 chapter range、batch id、cursor 或部分结果。

### 6. Memory、Knowledge、Creative 的关系

- Knowledge：正文观察，带 revision + 引文证据，永远是候选，不是 Canon。
- Creative：作者意图、计划、提案，有独立的作者确认/应用路径。
- Memory：从已完成任务证据中整理作者可审阅的经验候选。
- `retrieve_memory` 同时需要 knowledge 与 creative scope；三者不能互相替代，也不能新增第二个 Canon 确认入口。

### 7. AgentTask 能否承载整本书长期分析

不能。`agent-tasks-v1` 是单次、有界、绝对 deadline 的任务：一个 revision、一个 input hash、一次模型调用（Creative plan check 是固定五角色的唯一例外），attempt 上限 3，没有 cursor/resume/partial commit。整本书分析必须是 **Go 拥有的批次作业 + 多个单章/小批次任务**，而不是一个巨型 AgentTask。

### 8. 可复用的机制

- `agent-tasks-v1` envelope、claim/started/heartbeat/complete/fail、lease/epoch fencing。
- Go 预算 reserve/settle、unknown usage 保留全额 reservation。
- knowledge 的 revision stamp、supersede、按章队列、quote 证据校验（UTF-16 offset）。
- creative 的候选/作者确认模型。
- 现有 evaluation runner、deterministic graders、judge 与 dev/held-out 数据集。
- 现有 Pi `ModelGateway`、治理上下文、tool-free go-task 路径。

## 决策

### 权威边界

- Go 仍是唯一业务权威：manifest、批次、预算、证据校验、世界模型状态、作者确认。
- Node Worker 只执行一次有界模型调用并返回结构化候选；不写业务状态、不确认 Canon、不改正文。
- 不新增第二套任务队列、调度器、预算账本或 SQLite。分析状态是 `analysis/<bookKey>/state-v1.json`，用现有 `storage.Lock` + 原子写；锁不跨模型调用。
- 不改变 `thinking-v1`。`agent-tasks-v1` 只做向后兼容扩展。

### 数据模型

`NovelAnalysisJob`：

```ts
{
  analysisId, bookId, status: 'queued'|'running'|'paused'|'completed'|'failed'|'cancelled',
  strategyVersion, createdAt, updatedAt,
  progress: { total, pending, running, completed, failed, stale },
  batches: AnalysisBatch[],
  synthesisStatus: 'pending'|'running'|'completed'|'failed'
}
```

`AnalysisManifest` 在创建时冻结每章身份：

```ts
{ analysisId, bookId, strategyVersion, createdAt,
  chapters: [{ chapterId, revisionId, contentHash, wordCount, volumeId, order }],
  batches: [{ batchId, chapterIds }] }
```

`AnalysisFinding`：`kind`（character/place/event/rule/relationship/thread/timeline/conflict）、标题、陈述、备选解释、置信度、`evidence[]`、状态（`proposed/author_confirmed/rejected/superseded/stale`）。

`WorldEntity`：`entityId`、kind、name、aliases、description、attributes、`state`（`observed/candidate/author_confirmed/rejected/superseded`）、首末章、证据。`observed` 是模型在正文中直接看到；`candidate` 是跨章推断；只有作者确认才进入 `author_confirmed`。

### 批次与上下文

- 2–5 章一批，按估算 token 动态装箱；manifest 顺序固定。
- 不截断正文。单章超过预算时该批次失败并给出 `CHAPTER_TOO_LARGE`，作者可拆分章节后重跑；绝不静默截断。
- 每批一次模型调用，提示词内含五个抽取角色（章节分析师、人物、世界、时间线、情节/线索），输出严格 JSON。
- 跨章合并在 Go 内确定性执行：按规范化名称/类型去重，属性冲突生成 `conflict` finding，不投票决定事实。
- 全书综合任务复用同一 `novel.analyze` kind 的 `synthesis` phase，只接收候选摘要与证据索引，不接收整本正文；输出连续性观察与冲突候选。

### 作者流程

作者请求 → 冻结 manifest → 逐批后台任务 → 每批证据校验后写入候选 → 跨章合并 → 世界模型 → 作者在“书”页知识工作台逐条确认/驳回/查看原文。未确认的候选不能进入 Canon，也不能被当作已确认事实注入后续提示词。

### 修订失效

新 revision 写入后：

- 该章对应的 batch 标为 `stale`；运行中的旧 revision 任务由 Go 以 revision/hash 不匹配拒绝提交。
- 该章产生的 findings 标为 `stale`，但保留历史与作者决定。
- 其他批次不重跑；只重跑受影响章节，并在世界模型中标记依赖该章的推断为 `superseded`。

## 任务与接口

扩展 `agent-tasks-v1`：

- kind：`novel.analyze`
- output schema：`novel-analysis-candidates-v1`、`novel-synthesis-candidates-v1`
- claim kind：`analysis`（worker 声明 `analysis`，Go 映射到 `novel.analyze`）
- task 仍只携带 `request.system/input/schema`，批次身份通过 input JSON 与 `revisionId/contentHash` 绑定。

HTTP（均需作者身份与书籍所有权）：

```text
POST /v1/studio/books/:book/analysis          创建或返回同 manifest 的进行中作业
GET  /v1/studio/books/:book/analysis          读取当前作业、manifest、findings、entities、conflicts
POST /v1/studio/books/:book/analysis/:id/pause
POST /v1/studio/books/:book/analysis/:id/resume
POST /v1/studio/books/:book/analysis/:id/cancel
POST /v1/studio/books/:book/analysis/:id/findings/:findingId/decision
```

## 兼容与发布

- 新增字段全部可选；旧 worker 在 claim 前因缺少 contract hash 拒绝，不会执行新任务。
- 发布顺序：先 Go（接受新 kind 并准备任务），再 Node Worker（声明 `analysis`）。回滚先暂停分析、排空运行中任务，再换回旧二进制。
- 现有 `thinking-v1`、review、knowledge、creative、memory 路径不变。
- 分析状态与 `tasks-v1.json` 分离；清理只删除终态任务记录，不删除 findings 历史。

## 实现状态

P0–P5 与 P7 的增量重跑、确定性评测已落地；P6 的 Thinking 容量失败转后台已落地。实现证据、性能数据、部署/回滚步骤与已知限制见[成熟度报告](novel-intelligence-maturity-report.md)。

## 阶段

0. 本 ADR 与审计。
1. 导入后目录自动展开、首章选中、卷展开、搜索/字数/空/错误/只读状态、500–2000 章可用。
2. `NovelAnalysisJob`、manifest、批次持久化与 HTTP。
3. 章节批次任务、证据校验、候选落库。
4. 跨章合并、世界模型、冲突检测、修订失效。
5. 知识工作台：进度、控制、逐条审阅、证据定位、世界模型视图。
6. Thinking 大任务转后台作业与进度卡。
7. 增量更新与评测（dev/held-out、确定性 grader、judge 可选、人工复核）。

## 已知限制

- 分析状态是单机 JSON；与现有 Go 状态一致，不支持多副本并发写。
- 章节字数读取每个 draft head；2000 章目录首次加载是 O(章数) 次小文件读取，未另建索引。
- 单章超预算直接失败，不自动切段；切段需要新的证据偏移协议。
- 世界模型只从正文与作者确认构建，不把章节摘要当事实。
- 评测的模型质量结论需要真实模型与人工双标；合成 provider 只证明工程链路。
