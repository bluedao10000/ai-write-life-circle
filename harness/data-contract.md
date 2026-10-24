# 领域数据契约

## 稳定 ID

| 前缀 | 含义 |
| --- | --- |
| CHAR-001 | 人物 |
| THREAD-001 | 情节线 |
| WORLD-001 | 世界规则 |
| EVENT-001 | 事件 |
| CH-001 | 章节 |
| P-001 | 提案 |
| REF-001 | 外部案例 |

规则：ID 不复用。改名保持 ID。

## 正式资料

每条正式资料包含：ID、status、更新时间、内容、证据 source、关联 ID。

status 取值：unknown / proposed / confirmed / deprecated。模板占位均为 unknown。

source 格式：仓库相对路径 + 章节或段落定位 + 必要短引文。提取记录额外保存章节 Git blob hash。这样原文变化后，旧提取不再生效。

作者直接指令：保留日期和与决策相关的作者原话。标明这是作者确认，不是正文事实。

## 章节正文

正文用 Markdown，存放在 `manuscript/CH-001.md`。文件名以稳定章节 ID 开头。

正文标题用一级标题。标题后写 `Key: value` 元数据。`ID: CH-001` 必须与文件名一致。

V0.4 使用可选 `volumeId` 分卷，可选正整数 `order` 排序。未提供 `order` 时按稳定章节 ID 排列。

正文保持 Markdown，不保存为 TipTap JSON。API 保存只产生 Harness 之外的应用草稿。作者决定后自行提交正文到 Git。Agent 对 `manuscript/` 始终只读。

## 提案状态

proposed → partially-accepted / accepted / rejected / superseded。

每个提案条目独立标记状态。已接受条目不重复执行。正文变化后，引用旧版本的提案标为 stale，重新核对后才能接受。

## 冲突

正文、已确认设定、作者新指令互相矛盾时，建立冲突记录。作者明确裁决后更新。历史被替代的条目保留来源与替代关系，不悄悄删除。

## 索引

索引只存摘要、路径、状态与关联 ID，不复制整份资料。章节摘要是可重建投影，不是事实来源。

风格基线必须来自作者认可的自身样本，不从单章或参考作家自动推导。

## AI 衍生知识

在线知识独立于上述正式资料 status。Entity / Assertion / Source 分离，观察、角色说法、推测保留各自来源与可信等级，不写为作者 confirmed。来源绑定作品、章节、Revision、Content Hash 和 UTF-16 精确原文。章节修改后旧来源失效，历史保留；日常自动整理不要求逐项确认。正式裁决仍由作者决定。见 [AI 作品记忆](architecture/ai-knowledge-memory.md)。
