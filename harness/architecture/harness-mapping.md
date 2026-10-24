# Harness 数据映射

本文说明 Markdown + Git 事实层到领域实体的映射，供后端（`apps/api-go`）做只读解析与投影。它不替代 Harness。Harness 的 Markdown 仍是正式知识的事实来源。

## 结论摘要

| 维度 | 现状 |
| --- | --- |
| 事实来源 | Markdown 文件 + Git 历史；正文在 `manuscript/` 默认只读 |
| 元数据格式 | 正文顶部的键值行（`ID:` / `status:` / `updated:` / `source:` / `related:`），不是 YAML front-matter |
| 稳定 ID | CHAR / THREAD / WORLD / EVENT / CH / P / REF + INTENT-001；不复用 |
| 状态机 | 正式条目 unknown / proposed / confirmed / deprecated；提案 proposed → partially-accepted / accepted / rejected / superseded |
| 来源定位 | 仓库相对路径 + 章节或段落定位 + 短引文；关键提取附 blob hash |
| 条款级状态 | 提案逐项标记，非整份一态 |

## 目录与实体映射

| 目录 | 实体 | 说明 |
| --- | --- | --- |
| `book/intent.md` | INTENT-001 作者意图 | 主题非正文事实 |
| `book/characters/*.md` | CHAR-* 角色 | 姓名、定位、欲望、关系、知识边界 |
| `book/world/*.md` | WORLD-* 世界规则 | 规则、范围、代价、例外 |
| `book/threads/*.md` | THREAD-* 情节线 | 主线、支线、伏笔 |
| `book/outline.md` 等 | 大纲、时间线、风格基线 | 当前均 unknown |
| `book/index.md` 及子索引 | 索引（投影） | 只存摘要、路径、状态、关联 ID |
| `proposals/*.md` | P-* 提案 | 逐项变更 + 冲突 + 接受依据 |
| `decisions/log.md` | 决策记录 | 作者确认依据、改动文件、被取代内容 |
| `state/current.md` | 会话状态 | 目标、已完成、待决、下一步 |
| `manuscript/*.md` | 正文 | 默认只读，Agent 不写 |
| `notes/*.md` | 提取摘要 | 可重建投影 |
| `references/*.md` | REF-* 外部案例 | 可核验案例卡 |
| `inbox/*.md` | 作者原始材料 | 作者原话的事实载体 |
| `harness/*` | 工作流规范（元层） | 非领域数据 |

## 稳定 ID 规则

前缀：CHAR、THREAD、WORLD、EVENT、CH、P、REF，另有 INTENT-001。ID 不复用，改名保持 ID。新建实体从各前缀末号 +1 递增。

## 元数据格式

实体文件没有 `---` 包裹的 YAML front-matter，而是正文开头的普通键值行：

```
ID: CHAR-001
status: confirmed
updated: 2026-09-29
source: inbox/2026-09-28-core-idea.md 末段
related: WORLD-002, WORLD-003
```

解析器不得假设 front-matter 存在。应兼容两种：正文顶部连续 `Key: value` 行；或没有任何元数据行（模板占位）。

## 来源定位与 hash

`source` 字段格式：仓库相对路径，可加锚点，多来源用 `；` 分隔。提取记录保存源文件 Git blob hash，用于外部修改检测。投影层需要「来源定位 + 内容 hash」双字段。

## 引用关系

`related:` 字段列出关联稳定 ID。引用是单向字符串引用，无双向边表。投影时扫描全库重建反向引用。

## 版本处理

单一事实源：Git 提交历史 + 文件内容。索引与摘要是可重建投影，非事实源。历史被替代条目保留来源与替代关系。引用旧版本提案的正文变化后标 stale。

## 外部修改检测

判据：`source` 指向的文件 + 记录的 blob hash 与当前 `git hash-object` 比对。不一致则标 stale，触发重新核对。不能只比较 `updated` 日期，日期可被手改。

## 与领域模型 / API 的边界

| 领域概念 | Harness 载体 | 后端投影 |
| --- | --- | --- |
| Knowledge 实体 | `book/*.md` | 只读投影 + 稳定 ID + 状态 + source hash |
| Proposal | `proposals/*.md` | 只读投影（逐项状态） |
| Decision | `decisions/log.md` | 只读投影 |
| Chapter | `manuscript/*.md` | 不可写；revision/sourceHash 属运行时数据 |

Harness 的 Markdown 是作者已确认知识的事实源。Go 后端（`apps/api-go`）的运行时数据是工作状态。二者通过稳定 ID + source hash 关联，不可互相覆盖。

## unknown 语义

`unknown` 与作者刻意留白不是错误。模板占位视为 unknown。「部分确认」等于实体存在但仅部分属性有值，不等于实体不存在。
