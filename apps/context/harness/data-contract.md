# 数据契约

`context/` 下每条上下文都是**一个 markdown 文件**，用 YAML frontmatter 存元数据，正文区分「冰山之上 / 冰山之下」。本文件定义这套格式。

## 文件格式

```markdown
---
id: CHAR-001
name: 林澈
status: confirmed        # confirmed | speculative | contradicted | stale
explicitness: implicit   # explicit | implicit | unwritten
confidence: 0.9
sources:
  - type: dialogue       # dialogue | manuscript | note
    ref: 会话-2026-10-27
    quote: "他嘴上说不怕，其实一直躲着水。"
updatedAt: 2026-10-28
---

## 冰山之下（底层逻辑，仅供作者与 AI 掌握）
林澈幼年溺过水，从此怕水，但自尊心让他从不在人前承认。
这是他的核心创伤，也是结局和解的关键。

## 冰山之上（正文如何以小见大地呈现）
- 经过河边时下意识绕远路（第 3 章）
- 别人约游泳，他用工作搪塞（第 7 章）
- 从未正面解释过原因

## 未解问题
- 他是否会在结局前直面这段创伤？
```

## 通用元数据字段

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `id` | `CHAR-001` 等 | 唯一标识，条目之间用它互相引用 |
| `status` | 见下 | 确立状态 |
| `explicitness` | 见下 | 显隐程度 |
| `confidence` | 0-1 | 置信度，speculative 低、confirmed 高 |
| `sources` | 列表 | 来源，见下 |
| `updatedAt` | 日期 | 最后维护时间 |

## 状态机（status）

```
speculative ──确认──▶ confirmed
    │                    │
    │ 发现冲突           │ 被推翻 / 作者放弃
    ▼                    ▼
contradicted ◀──仲裁──  stale
```

- `confirmed`：作者确认，进入正典，可作连续性判据。
- `speculative`：AI 推断，未经作者确认，**不作定论**。
- `contradicted`：出现矛盾，等作者仲裁。
- `stale`：已被推翻或弃用，保留备查。

## 显隐程度（explicitness）

| 值 | 含义 |
| --- | --- |
| `explicit` | 正文直白写了 |
| `implicit` | 正文暗示、没明说 |
| `unwritten` | 正文还没碰，只在对话 / 笔记里 |

`implicit` / `unwritten` 占比高，正是需要 AI 主动引导建设的「海面下」部分。

## 来源（sources）

| type | 优先级 | 说明 |
| --- | --- | --- |
| `dialogue` | 主要 | 作者与 AI 的对话，拍板过的最权威 |
| `manuscript` | 次要 | 从正文提炼 |
| `note` | 次要 | 从创作笔记提炼 |

冲突时：对话 > 正文 ≈ 笔记。

## ID 规范

| 维度 | 目录 | 前缀 | 示例 |
| --- | --- | --- | --- |
| 人物 | `context/characters/` | `CHAR-` | `CHAR-001` |
| 世界观 | `context/world/` | `WORLD-` | `WORLD-001` |
| 时间线 | `context/timeline/` | `EVENT-` | `EVENT-001` |
| 剧情结构 | `context/structure/` | `STRUCT-` | `STRUCT-001` |
| 伏笔 | `context/foreshadowing/` | `FORE-` | `FORE-001` |
| 参考资料 | `references/` | `REF-` | `REF-001` |

编号从 001 递增，删除不复用。条目间引用只写 ID，不复制内容。

## 五维特有字段

| 维度 | 特有 frontmatter 字段 |
| --- | --- |
| 人物 | `name` `role` `traits` `want` `need` `fear` `arc` `relations` |
| 世界观 | `title` `category`（rule/location/faction）`hardness`（hard/soft） |
| 时间线 | `when` `sortKey` `location` `characters` |
| 剧情结构 | `structure` `beat` `current` `conflicts` |
| 伏笔 | `setup` `payoff` `state`（planted/paid/dangling/abandoned）`linked` |

## 约束

1. 每条目必须有 `id` + `status` + `sources`，缺一不可。
2. 「冰山之上」只记正文已经怎么呈现，不写 AI 脑补。
3. 「冰山之下」只记作者说过的、确认过的，AI 不编设定。
4. 改一处设定，同步改所有引用它的条目（靠 ID 定位）。
