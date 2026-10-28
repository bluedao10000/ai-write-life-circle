# 伏笔（foreshadowing/）

存放伏笔的埋设与回收，ID 前缀 `FORE-`。

## 条目模板

```markdown
---
id: FORE-<序号>
title: <伏笔名>
state: planted | paid | dangling | abandoned   # 已埋/已回收/断线/弃用
setup: <埋设位置，章节/段落>
payoff: <回收位置，未回收则留空>
linked: [<关联 CHAR-id / EVENT-id / WORLD-id>]
status: confirmed | speculative | contradicted | stale
explicitness: explicit | implicit | unwritten
confidence: <0-1>
sources:
  - type: dialogue | manuscript | note
    ref: <位置>
    quote: "<原文片段>"
updatedAt: <日期>
---

## 伏笔内容

## 冰山之上（正文如何埋的）

## 回收计划 / 未解问题
```

## 状态机

```
planted ──回收──▶ paid
   │
   ├─长期未回收──▶ dangling（断线风险）
   └─作者放弃────▶ abandoned
```

## 判定要点

- 埋设要有「回头看才明白」的细节，不是明示。
- `dangling` 要及时提醒作者：继续保留、近期回收，还是明确弃用。
- 回收率低是 major 缺口，见 [health-board](../../harness/health-board.md)。
