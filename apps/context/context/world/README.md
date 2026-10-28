# 世界观（world/）

存放世界规则、地点、势力，ID 前缀 `WORLD-`。

## 条目模板

```markdown
---
id: WORLD-<序号>
title: <名称>
category: rule | location | faction   # 规则/地点/势力
hardness: hard | soft                 # 仅 category=rule 时填
status: confirmed | speculative | contradicted | stale
explicitness: explicit | implicit | unwritten
confidence: <0-1>
relations: [<关联 WORLD-id 或 CHAR-id>]
sources:
  - type: dialogue | manuscript | note
    ref: <位置>
    quote: "<原文片段>"
updatedAt: <日期>
---

## 冰山之下（底层逻辑）

## 冰山之上（正文呈现）

## 未解问题
```

## 判定要点

- 至少有一条 `hardness: hard` 的规则作为故事边界。
- 硬规则：绝对不能违反，违反即逻辑漏洞。
- 软规则：可弹性解释，重在氛围。
- 主题（这个世界想探讨的命题）可写在 `未解问题` 或单独 WORLD 条目里。
