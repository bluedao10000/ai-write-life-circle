# 时间线（timeline/）

存放按时间排序的事件，ID 前缀 `EVENT-`。

## 条目模板

```markdown
---
id: EVENT-<序号>
when: <故事内时间坐标>
sortKey: <数字，用于严格排序，可选>
location: <地点，可引用 WORLD-id>
characters: [<涉及 CHAR-id>]
status: confirmed | speculative | contradicted | stale
explicitness: explicit | implicit | unwritten
confidence: <0-1>
sources:
  - type: dialogue | manuscript | note
    ref: <位置>
    quote: "<原文片段>"
updatedAt: <日期>
---

## 事件摘要
<发生了什么>

## 冰山之上（正文呈现）

## 未解问题
```

## 判定要点

- `sortKey` 控制严格先后；缺省时靠 `when` 描述。
- 事件之间要能自洽，出现冲突标 `contradicted` 并请作者仲裁。
- 时间线是连续性审查的判据，宁缺毋滥，只记影响前后一致的事件。
