# Sprint 3：基于证据的连续性审查

单作者、Go HTTP/JSON 文件状态，复用现有修订和 VNext。保持生产身份保护和逐次发送授权。

## 运行架构

作者主动点击 → 安全保存队列确认 → 只读预览上下文 → 展示服务、模型、来源范围 → 明确确认 planHash → 重新验证修订及上下文 Hash → 有界异步模型调用 → 严格结构解析 → 确定性引用校验 → 原子保存 ReviewRun → 按需查看注记与反馈。

LLM Client 只暴露 Generate(ctx, request)。服务端显式配置 endpoint、model、JSON 输出模式。无配置时能力不可用，但历史记录仍可读。

## 固定版本与上下文

目标来自已保存 Chapter Revision，核对 revisionId 与 contentHash。只读审查快照不触发 Draft、Note、Audit 写入。历史范围使用目录的全局卷序与卷内顺序，仅选择目标之前的章节。相关性计算读取已保存的 Revision 正文；最多64个候选，小作品覆盖全部前文，更大作品保留最近32章与更早范围32个均匀样本，最终最多4章。选取和片段使用同一次读取的修订，候选限制仍可能遗漏远距离证据。可靠知识仅选 book/ 中 status: confirmed、来源可解析的条目。

目标完整保留。历史章节与确认知识截取有界片段，存原始偏移、完整内容 Hash、源文件 Hash 和片段 Hash。预览和提交绑定相同 planHash。

## 数据与证据

ReviewPlan/Run 包含 strategyVersion、project、chapter、revision、contentHash、reviewTypes、ModelInfo、上下文快照引用、planHash、预算、状态和诊断。

模型候选必须含：标题、AI 推断、作者问题、其他可能解释、至少两条不同来源引文，其中至少一条来自目标正文。严格 JSON 拒绝未知字段。每条引文必须逐字存在于允许的片段，服务端重新计算 Hash。

TextAnchor 的 start/end 定义为原始 Markdown 的 UTF-16 code units，左闭右开。重复原文标 ambiguous。

## 持久化与权限

独立 review-runs/<project>.json，复用原子 Write、fsync 与跨进程锁。快照、结果、幂等映射、反馈在同一事务提交。

只有作者可预览、发起、取消、读取、反馈。反馈记录作者、时间、版本，有 CAS 与幂等保护。不写正文或正式设定。

## 范围

不做多用户认证、部署、自动生成正文、Canon 写回、向量库、多 Agent 或工具循环。真实模型联调独立进行。

策略版本为 continuity-review-v4。私有知识索引仅优先提供当前原文所在章节，最终仍核验实际 Revision；不可用时回退历史检索，AI 推测不提升为 confirmed。既有 v2/v3 记录不改写；缺少版本字段的旧持久化记录按 continuity-review-v1 读取，保留原审查和反馈。
