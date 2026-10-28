# 人物（characters/）

存放人物条目，ID 前缀 `CHAR-`，编号从 `CHAR-001` 递增。

## 条目模板

```markdown
---
id: CHAR-<序号>
name: <姓名>
role: protagonist | antagonist | supporting | minor   # 主角/反派/配角/龙套
status: confirmed | speculative | contradicted | stale
explicitness: explicit | implicit | unwritten
confidence: <0-1>
traits: [<性格标签>]
want: <表面欲望>
need: <深层需求>
fear: <核心恐惧>
arc: <起点 → 终点，转变 + 催化剂>
relations: [<指向其它 CHAR-id 的关系说明>]
sources:
  - type: dialogue | manuscript | note
    ref: <会话/章节/笔记位置>
    quote: "<原文片段>"
updatedAt: <日期>
---

## 冰山之下（底层逻辑，仅供作者与 AI 掌握）

## 冰山之上（正文如何以小见大地呈现）

## 未解问题
```

## 判定要点

- 主角（protagonist）必须填 want / need / fear 与 arc，否则人物扁平。
- relations 只写 ID 引用，不复制他人档案。
- 「冰山之上」只记正文已怎么呈现，不写脑补。

## 示例

见 [harness/data-contract.md](../../harness/data-contract.md) 里的 CHAR-001 示例。
