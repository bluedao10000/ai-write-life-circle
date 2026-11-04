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

## Semantic与Episodic检索

只读`retrieve_memory`工具同时要求`creative`和`knowledge` scope，只接受可选query，不接受作者、作品或路径参数。Pi Tool Gateway与Go私有RPC都检查权限，Go在I/O后再次校验授权。工具按当前会话作者和作品解析业务Service，直接读取Creative StoryContext和Knowledge Query；不保存独立副本。

返回`schemaVersion=1`、bookId、records、可引用sources、truncated、omitted及unavailableLayers。每条record含id、layer、status、resource、version、versionResource、content和provenance。资产version引用`creative.asset`；提案和决定引用`creative.state`；原文观察引用`knowledge.state`。来源保留资产版本、原始消息或Chapter/Revision与引文位置。只有作者已接受资产标为confirmed，原文观察为observed，提案保留proposed/rejected，历史决定为episodic并保留applied/offered/undone。计划仍是意图，不能当作已发生的原文事件。

Knowledge读取刷新来源状态，并校验引用Revision、内容标识和引文范围；退休、过期或不可读取的来源不进入结果。Creative沿用原状态的归档、替代、提案过期和来源删除过滤。检索按分组轮流填入，最多24条且受原工具结果字节限制；遗漏明确标记，可使用已有原始查询工具读取详情。Procedural尚未实现，显式列入unavailableLayers。Thinking Tool Schema Version升至2；恢复仍沿用现有重新授权与执行中断规则。

无新持久格式或数据库。作者修改和版本冲突、撤销与确认继续由原Go接口处理。Go测试验证Revision替换后观察消失、资产归档后新Service不再返回、版本冲突拒绝、双scope、跨作品参数拒绝及有界输出。统一Memory Eval通过真实Thinking→Tool Gateway→Go RPC取得观察与来源；未进行语义质量或完整四层记忆验收。

## 来源删除与候选过期

会话删除沿用Creative CancelSession：未确认提案过期，原话证据清除，focus删除，作者已确认资产保留。StoryContext排除`SourceDeleted`的历史变更回执，避免Thinking上下文和统一记忆引用不可读取的会话来源；排除发生在最近记录容量选择之前，失效回执不会占用有效记录的位置。业务审计和幂等回执继续保留，不参与模型记忆检索。

验收通过实际Go/Pi流程生成候选、删除来源会话、创建新Thinking会话并调用retrieve_memory；检查过期状态、证据清除及空检索结果。Go测试同时证明新建Service仍遵循删除结果，已确认资产与业务审计没有丢失。无持久格式变化，回滚代码不会恢复被清除的原话。
