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

Knowledge读取刷新来源状态，并校验引用Revision、内容标识和引文范围；退休、过期或不可读取的来源不进入结果。Creative沿用原状态的归档、替代、提案过期和来源删除过滤。检索按分组轮流填入，最多24条且受原工具结果字节限制；遗漏明确标记，可使用已有原始查询工具读取详情。Procedural使用下文v1实现；未接入前以unavailableLayers标记，当前实现返回已审核且有效的规则。Thinking Tool Schema Version升至2；恢复仍沿用现有重新授权与执行中断规则。

无新持久格式或数据库。作者修改和版本冲突、撤销与确认继续由原Go接口处理。Go测试验证Revision替换后观察消失、资产归档后新Service不再返回、版本冲突拒绝、双scope、跨作品参数拒绝及有界输出。统一Memory Eval通过真实Thinking→Tool Gateway→Go RPC取得观察与来源；未进行语义质量或完整四层记忆验收。

## 来源删除与候选过期

会话删除沿用Creative CancelSession：未确认提案过期，原话证据清除，focus删除，作者已确认资产保留。StoryContext排除`SourceDeleted`的历史变更回执，避免Thinking上下文和统一记忆引用不可读取的会话来源；排除发生在最近记录容量选择之前，失效回执不会占用有效记录的位置。业务审计和幂等回执继续保留，不参与模型记忆检索。

验收通过实际Go/Pi流程生成候选、删除来源会话、创建新Thinking会话并调用retrieve_memory；检查过期状态、证据清除及空检索结果。Go测试同时证明新建Service仍遵循删除结果，已确认资产与业务审计没有丢失。无持久格式变化，回滚代码不会恢复被清除的原话。

## 版本冲突检索合同

retrieve_memory复用Creative ProposalView的Stale判断，新增只读reviewRequired列表：proposalId、targetAssetId、baseVersion、currentVersion、reason及原会话来源。只报告仍为proposed、未替代、来源未删除的候选；不将过期候选内容混入confirmed/observed记忆。target_version_changed与target_missing表示版本或目标冲突，不声称识别语义矛盾。作者仍通过原Creative审核与显式rebase接口解决，检索不修改候选。

检查最近24个待审核候选，最多返回8条提示，并纳入原工具字节上限；分页或遗漏均设置truncated。reviewRequired是作品级审核提示，不受query关键词过滤。没有独立持久字段或迁移，返回schemaVersion=1的新增可选信息，原消费方继续读取records。

## Procedural Memory v1

Go新增procedural领域记录，与创作设定分离，使用原StateLock/CommitBookState和原子JSON；每作品保存于creative/<book-key>/procedural-memory-v1.json。唯一新增权威是作者审核的操作经验，不复制任务状态、费用或Canon。来源为原agenttasks已完成回执，读取仅投影taskId、kind、strategyVersion、inputHash与completedAt；请求正文、能力令牌、模型凭证不进入经验记录。

候选由作者明确提交，1–8个真实已完成任务作为来源；确认至少要求两个不同taskId、不同inputHash、相同kind与strategyVersion的成功执行，并由作者执行版本绑定的confirm。成功回执证明执行成功，规则是否适用由作者审核决定，不自动泛化。reject/delete沿用显式作者操作；默认30天有效，最长90天。检索仅返回已确认、未过期且来源仍可授权读取的规则；失效记录在管理读取中仍可见。规则只是带版本的操作建议，不能授予权限、改变预算或自动执行。

新文件按需创建，旧目录读取为空，不改变现有存储schema。旧版本Creative只读取state-v1.json，回滚代码忽略新文件；不得用旧备份覆盖任务费用或业务回执。删除经验清除正文及来源，并清除其幂等请求中的正文；墓碑阻止旧请求重放复活。新文件位于原有作品Creative子目录，旧版本的作品删除和完整State备份路径也覆盖它。验收要求旧目录、重启、版本冲突、双来源限制、跨作者拒绝、过期及删除重放覆盖。


### 作者 API 与运行边界

`GET /v1/studio/books/{bookId}/procedural-memory/evidence`返回最近100条本作者本作品的成功任务元数据。`POST .../procedural-memory`接受content、taskIds及可选expiresAt，创建candidate。`POST .../procedural-memory/{id}`接受baseVersion和confirm/reject/delete；写请求需要Idempotency-Key。`GET .../procedural-memory`返回当前记录及available/unavailableReason，过期和来源不可用是读取投影，不重写历史确认事实。公开契约见`harness/contracts/procedural-memory-v1.json`。

统一retrieve_memory仍要求creative与knowledge scope，只加入available规则，按query关键词过滤并受原24条/字节上限约束。每条记录包含规则版本、审核作者、有效期和任务来源。确认依赖不同输入的成功执行与作者审核；这些证据不代表统计验证或跨任务泛化。v1不允许模型自动创建或确认规则，管理入口包括API及书页「操作经验」；后台经验提取尚未实现。

存储上限为每作品1000条记录（含删除墓碑）、10000条幂等回执、8 MiB编码JSON；写入前检查字节预算。删除清除正文与其历史回执内容，仍保留最小墓碑防止重放。旧版本回滚忽略新文件并继续使用原任务和业务状态；再次升级按schema=1读取原文件。不得恢复旧状态快照覆盖后来产生的任务、费用或回执。


### 作者工作台

书页新增「操作经验」分区，列表和最近100条任务来源并行读取。作者可选择1–8个来源保存候选，查看任务类型、完成时间与方法版本，再执行确认、撤回或删除。确认按钮要求全部来源同类、同方法版本且输入不同；Go在提交时重新读取回执并作最终判断。过期、来源不可用和撤回状态直接使用服务端投影。

经验内容遵守4000 UTF-8字节上限。每次决定绑定当前version；同一失败请求重试复用幂等键，编辑输入后使用新键。冲突后刷新权威状态并保留未保存草稿。按作品重建面板，卸载时中止读取，迟到响应不进入新作品；演示模式显示连接说明，不构造经验或来源。

验证命令为 `pnpm --filter @writer-agent/web exec vitest run src/test/procedural-memory.test.tsx` 和 `pnpm --filter @writer-agent/web test:memory`。浏览器测试启动真实Go/Pi Worker生成两个不同输入的任务回执，在桌面与手机布局完成创建、确认、刷新、撤回和删除，并读取Go状态核验结果。模型为本地合成服务；身份断言使用隔离测试密钥，未执行生产登录流程。界面接入不改变持久格式，回滚Web构建即可保留已审核经验。

### 操作经验的统一评测

Memory Eval通过真实Go/Pi Worker完成两个输入不同的Knowledge任务，以原任务回执创建操作经验，并由作者API确认。每个样本保留一条未确认候选作为负向对照。Thinking经统一Tool Gateway调用retrieve_memory，评分器核对已确认规则的正文、版本及两条完整来源；候选不得进入可检索规则。

三个独立dev场景覆盖撤回、自然到期、删除。状态变更后重启Go API，在新Thinking会话中再次检索；要求权威管理状态不可用、工具执行成功且返回未截断，再判定失效规则数量为零。删除场景额外核对正文已从持久记录和历史幂等请求清除，旧创建请求重放返回410。所有场景验证跨作者拒绝、正文未改写和Canon无新增。

每次探测只观察该会话产生的模型请求，工具调用按探测分别计数，避免不同会话复用Provider tool call ID影响统计。工程通过率只衡量生命周期、授权和数据完整性；语义质量与经验泛化仍未验证。

### 重复候选整理

作者工作台对正文完全相同的candidate提供显式合并。Go在原状态锁内核验每条候选的版本、状态、正文、有效期与任务来源；保留一条candidate、去重合并最多8条任务来源，并采用所有候选的最早有效期，其余候选在同一提交中标为rejected。合并不确认经验，也不改变Canon。

合并请求绑定目标与各来源候选的版本，复用现有幂等回执、存储预算及作品删除栅栏。只使用现有candidate/rejected状态，回执记录merge操作及来源ID/版本，不增加记录字段或迁移旧状态。旧代码可读取合并结果；回滚不恢复已撤回项或覆盖新回执。不同正文的语义合并、已确认规则替代和后台提取不属于这个确定性操作。

作者界面只在存在可合并候选时提供按钮，展示合并数量、来源汇总和最早有效期语义。合并失败重试复用原幂等键，版本冲突刷新不清除未保存草稿。每次最多合并8条记录和8个任务来源；再次确认沿用原独立证据检查。

验收覆盖Go事务与来源重读、浏览器操作及真实Thinking检索。`scripts/test-procedural-memory.mjs`在合并后重启Go并重放原请求，确认前检索为空，作者确认后只检索到目标及完整来源，删除后旧合并请求返回410。测试使用本地合成模型，语义整理与经验泛化另行评测。

### 经验提取的来源预览

作者主动检查任务来源时，Go从原任务回执定位执行所用的章节Revision或Creative讨论摘录。来源预览返回任务身份、原资源身份和有界正文；最多16 KiB UTF-8正文，截断显式标记。章节读取精确历史Revision并核对已有contentHash，不替换为最新正文。讨论沿用Creative原摘录保留与删除规则，保留用户/助手角色；不存在、已清除或未成功完成的来源返回不可用。

预览仅是输入来源，不冒充完整执行轨迹或模型输出。它不调用模型、不写状态、不延长原文保留期限、不创建候选。后续受治理提取任务须在发送前再次读取来源，不能相信浏览器提交的正文或把截断预览当作完整历史。作者按需读取，不随最近100条任务列表自动加载。API按原作品权限解析，响应不含租约、Capability、模型Key、原始请求或费用字段。

### 经验提取的结果证据

来源预览配套提供只读结果证据。审查按原Run读取发现与作者反馈；Creative按Job读取提案或计划核对；Knowledge按原Job对应Revision读取仍保留的观察。Knowledge观察可被多个同版本任务复用，必须标记为revision_observations，不宣称是该次调用的原始输出。其他结果标记task_result。结果返回原业务版本、当前审核/失效状态、固定来源ID，最多20条及16 KiB正文，遗漏或正文截断均显式标记。

结果仍从Go原业务状态读取，不另存模型响应或学习轨迹。读取前核验作者、作品、成功任务与原来源可用性；源讨论删除后不返回派生结果。反馈变化保留在当前业务版本中，提取执行和候选发布必须重新核对该版本及来源当前有效性。空结果、未审核提案、过期观察和一次成功都不能直接推导出有效经验规律。


结果证据入口为`GET /v1/studio/books/{bookId}/procedural-memory/evidence/{taskId}/outcome`。它是独立的新增读接口，原来源预览合同保持不变。工作台在展开原始来源后按需读取关联结果；关闭后再次打开会重新读取作者反馈。显示观察/推断/角色陈述、提案立场与计划核对类别，过期、异议和作者拒绝不转换为有效经验。

Knowledge复用原freshen规则校验Revision、引用及作者纠正，只更新本次返回值；Creative按原ChangeSet/Job定位提案和计划核对，计划或正文版本变化使核对结果标为stale。Review复用原Run读取与反馈版本。文本总上限与结果条数上限独立实施，缺失或不可读取返回错误，不能转换为“成功但零结果”。这些投影不修改业务状态、任务回执或费用。

### 作者主动模型提取

操作经验工作台已接入受治理模型提取：作者选择1–4个成功任务并同意发送，专用 Thinking 会话固定任务及结果版本、零工具，复用原费用和取消/恢复机制。Go从已完成Run读取严格候选输出，只允许所选任务子集；作者保存后仍为candidate，需要独立确认。`extractions`保留模型、会话、Run、提示与授权版本，合并不丢弃来源；确认与检索重查原授权和结果版本。

来源/反馈变化、授权撤销、取消与删除阻断候选生效。原记录只增加可选元数据；回滚须撤回相关候选并清理专用会话后再回退Go/Pi，保留已收费点数及业务回执。合同、验证与回滚步骤见[经验提取ADR](dreaming-memory-candidates.md)。后台整理、语义冲突与跨任务质量证据仍待完成。
