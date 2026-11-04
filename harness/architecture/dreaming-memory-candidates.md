# ADR：Dreaming 只产生作者待确认的记忆候选

日期：2026-10-29。更新：2026-11-04。状态：来源预览与作者候选审核已实现；模型提取和后台调度尚未实现。

流程：授权范围内的历史会话快照 → 候选提取 → 去重/冲突/过期核验 → 作者逐项确认 → 按既有 Go 正式写入事务生效。LLM 只产候选，Harness 管预算与恢复；正式知识 Store 与候选 Store 分离。

## 数据契约建议

```ts
type MemoryCandidate = {
  candidateId: string; bookId: string; ownerId: string;
  kind: 'author_confirmed_fact' | 'writing_preference' | 'agent_suggestion'
      | 'creative_hypothesis' | 'deprecated';
  status: 'proposed' | 'confirmed' | 'rejected' | 'superseded' | 'expired';
  content: string; version: number;
  source: { sessionId: string; messageIds: string[]; runId: string;
    checkpointId: string; snapshotHash: string; grantVersion: string };
  evidence: { sourceId: string; revisionId: string; contentHash: string }[];
  extractedBy: { provider: string; model: string; policyVersion: string };
  dedupKey: string; conflictsWith: string[]; supersedes?: string;
  validUntil?: string; authorDecision?: { actorId: string; at: string;
    action: 'confirm' | 'reject' | 'deprecate'; expectedVersion: number };
};
```

模型输出中自报 author_confirmed_fact 仅是待验证类别；服务端必须定位作者明确陈述及其确认操作。Agent 建议和假设不能因置信度、重复次数、summary、dreaming 周期而升级。写作偏好与小说事实分别存储，默认按作品隔离；跨作品偏好需要另行授权。

确认必须是作者角色的独立 Go 命令，带 expectedVersion、稳定幂等键、来源快照 hash 和授权版本；事务内重查归属、会话未删、来源未撤销、候选未过期、冲突版本未变。任何变化返回 conflict/expired，不能套用旧确认。撤销会话授权阻止后续提取与候选确认；已正式确认的资料按现有作者撤销/废弃流程处理，不自动删已出版内容。

去重按规范内容 hash + kind + book 范围，语义相似只产合并建议。冲突保留并列候选与证据，由作者裁决。弃用生成 superseded/deprecated 链，不能静默覆盖旧事实。

## 后续实施门

1. 先实现只读候选预览/引用与授权说明，再审查 schema、隐私边界和用户确认流程。
2. 构建合成样本 Eval：建议不得升级事实、矛盾保留、撤销/删除阻断、旧版本确认失败、跨作品隔离。
3. 若未来批准后台提取，复用 Go task authority 的 lease/epoch/started/预算/回执；沿本次 Run 追踪，不把 Memory 写进 Pi compaction。
4. 灰度仅启用作者主动触发；作者确认提交与回滚（追加废弃记录）先于任何自动调度。

不新增 Provider，不更改数据发送范围，不把历史讨论作为正式设定恢复机制。

## 已实现的来源边界

操作经验工作台提供按需原始来源预览。Go从已完成任务回执定位原章节Revision或Creative讨论摘录，复用原读接口，不保存第二份历史。返回精确来源身份、最多16 KiB正文及截断标记；历史Revision不替换为当前正文，讨论保留用户/助手角色。任务未成功、作者/作品不匹配、来源已清除均不可读取。公开API为`GET /v1/studio/books/{bookId}/procedural-memory/evidence/{taskId}`。

候选创建、重复候选合并、作者确认、撤回和删除已使用原业务锁与幂等回执。确认要求同策略的不同成功输入，仍由作者独立判断适用性。来源预览只说明当时输入，未提供完整执行轨迹，也不能单凭成功回执推断任务方法有效。

## 提取任务接入约束

模型提取须读取原任务来源及可验证的执行结果，声明适用情境与证据缺口，不将输入摘要包装成经验规律。作者选择来源并确认模型发送范围后才入队；发送前重读原来源，来源清除或授权撤销阻止调用与候选发布。截断输入必须在任务合同中显式记录，不能静默补全。

复用Go任务领取、started、heartbeat、费用与完成回执，Pi继续经过统一Model Gateway。提取输出只允许候选正文与所选来源的子集，不能指定作者、作品、确认状态、权限或预算。输出必须经Go验证后进入作者候选审核。新任务种类及其持久字段需要单独完成旧状态读取、版本不兼容处理、故障恢复和回滚测试；来源预览不改变任何持久格式。
