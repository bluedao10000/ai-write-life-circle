# 剧情结构（structure/）

存放结构骨架、情节点、冲突，ID 前缀 `STRUCT-`。

## 条目模板

```markdown
---
id: STRUCT-<序号>
structure: three-act | four-act | hero-journey | custom   # 结构模型
beat: <情节点名，如 激励事件/中点反转/高潮/结局>
beatStatus: planned | written | revised   # 情节点进度
current: true | false   # 是否为当前进度
conflicts: [<冲突描述>]
status: confirmed | speculative | contradicted | stale   # 设定确立状态
explicitness: explicit | implicit | unwritten
confidence: <0-1>
sources:
  - type: dialogue | manuscript | note
    ref: <位置>
    quote: "<原文片段>"
updatedAt: <日期>
---

## 节点说明

## 冰山之上（正文呈现）

## 未解问题
```

> 说明：`beatStatus` 表达「情节点进度」，`status` 表达「设定确立状态」，二者含义不同。

## 判定要点

- 关键节点（激励事件、中点反转、高潮、结局）应齐备。
- 至少登记一个冲突，否则剧情缺驱动力。
- `current: true` 只允许一个，标记当前写到哪。
