# ADR：Agent Memory

日期：2026-11-04。状态：Phase 3 部分实现。

Working Memory 复用当前 Run/attempt 与讨论摘要。长期 Episodic、Semantic、Procedural 统一使用带来源和审核状态的记录，不把 Discussion Memory 摘要当作已确认事实。

Go 保持作者、作品、来源权限、确认/拒绝/撤销和删除权威。优先复用 creative 决定、proposal、asset versions 与 knowledge 检索；Pi 仅提交候选整理结果。不得另建可以独立确认 Canon 的 SQLite 记忆库。

记录除 id/type/content/status/version/time 外，包含 authorId、bookId、来源资源/版本/消息身份、授权范围、有效期和替代链。每次检索重新按当前授权过滤来源。来源删除或撤销后立即不可见，不能依靠时间衰减完成权限撤销。

检索顺序为 Working、已确认 Semantic、相关 Episodic、经验证 Procedural；按现有检索相关性、时间、来源与预算截断，返回证据与缺失原因。置信度不是授权，也不替代人工确认。候选与已确认记忆必须显式区分。

整理仅产生合并/冲突/替代候选。同一来源与操作使用既有业务回执去重，version冲突拒绝覆盖；过期不静默删除审计。单次成功不能生成已验证 procedural 规则，需独立重复证据与审核。

先完成单作者完整生命周期，再验证两个作者/作品的负向隔离。验收覆盖撤销后检索、删除后重启、并发确认冲突、污染输入、来源追溯与检索延迟。新持久格式在实现前提供迁移和兼容回滚测试，不能只增加类型就宣称完成记忆能力。

## Working Memory来源合同

`memory/working-memory.ts`复用原Session保存讨论摘要。`provenance.schemaVersion=1`与有序`messageIds`绑定摘要覆盖的可见消息前缀：用户消息和已完成助手消息，失败助手内容不进入来源。压缩和显式恢复都验证该前缀；来源缺失、顺序变化或助手消息失效时不复用摘要。摘要仍是未确认讨论上下文，不授予工具权限或成为Canon。每个新Run记录`memorySchemaVersion=1`。

原消息在Session内不可变，删除由Store墓碑清除消息、摘要与检查点。来源不复制正文，不计算额外哈希，也不建立独立状态权威。

旧格式`through/summary`已定义来源为本Session连续前缀，下一次授权运行可直接派生来源ID并写入原检查点，无需模型调用。打开旧目录不修改或重新付费。新增字段可选，旧实现仍读取`through/summary`；回滚保留当前状态文件，不恢复旧费用或回执快照。Storage layout保持不变。

验收覆盖45轮真实Pi对话压缩与重启、来源元数据持久化、旧格式启动零请求、正常执行补齐来源、来源替换/移除/状态失效及原消息保留。长期Episodic、Semantic、Procedural的统一适配、冲突/过期/整理审核和完整检索验收仍未完成。
