# ADR（提议）：Dreaming 只产生作者待确认的记忆候选

日期：2026-10-29。本次只有设计，无后台提取、定时任务、自动学习或正式知识写入。

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
