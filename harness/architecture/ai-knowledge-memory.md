# ADR：私有 AI 作品记忆（Sprint 4A）

## 权威与来源

正文 Revision 是创作原文的权威；AI 记忆是可重建的衍生索引，不是作者 confirmed 设定。既有只读 Harness、作者笔记、Publication Snapshot 不改写。公开 DTO 不包含本领域。

Entity（人物、地点、组织、规则、事件、剧情候选、伏笔候选）与 Assertion 分离。人物的不同属性/关系/事件独立持有来源、说话者、时间原话与认识等级。Relation 是有 targetEntityId 的 Assertion，Event 保留相对或不确定时间，不构造日期。实体简介由有来源的陈述组成，不存不可追溯的大段人物传记。

每条 Source 绑定 book/chapter/revision/hash、逐字引文、原 Markdown UTF-16 左闭右开位置与 narration/dialogue/thought 分类。服务端严格校验未知字段、必填字段、大小、枚举、实体引用、别名证据、唯一引文及实际 Revision Hash。模型不能提供路径、所有权、正文修改指令或任意来源 ID。原文证据只说明文字存在，不能证明模型推断成立。

- observation：正文陈述的 AI 观察，不宣称叙述一定客观可靠。
- claim：角色说法、主观认知；模型给出的 dialogue/thought 强制降为 claim。
- inference：AI 解释。剧情和伏笔默认保守地归入推测；explicit_mystery/explicit_resolution 保留原文明示的悬念及回收，与 AI 候选分开；明确回收可以通过有证据陈述表达，但不把候选当作作者确定的大纲。
- 纠错 dispute：保留争议，允许继续写作，不要求处理。

源分类及理解本身仍可能出错，需真实模型 Eval 和作者按需纠错；精确引文不是语义事实验证器。未揭示身份和动机应未知，不补全。

## 授权与发送范围

默认禁用。启用前展示实际 provider/model/endpoint、范围和费用，并要求作品级一次授权。启用涵盖已有已保存章节回填及后续保存；不用逐章授权或逐条审核。暂停取消执行，恢复沿用同一模型范围；服务商/模型/端点变化要求重新确认。

每次只发送目标保存版本全文，以及最多80条已有实体的名称、别名、身份区分（优先正文提及者）和最多50条纠错。不会拼接全书历史正文。输入超预算明确失败，不截去目标正文后冒充完整分析。模型 Client 仍是既有无工具 OpenAI-compatible Client；SchemaName、Prompt、输出 Schema 与 Review 独立。API Key 只在 Go。

## 调度与持久化

保存 Revision 时，KnowledgeExtractionIntent 与草稿在同一原子状态提交，保存失败没有新 Intent；不做保存后的第二个必须成功的知识写入。后台每秒发现受信任注册表中已授权作品，核对实际保存 head。这也恢复重启中断及授权前的历史章节。最近保存等待约2秒稳定窗口；快速新版本会淘汰旧 pending/running 结果。原文保存不等待模型或知识锁。

全局最多两个执行槽，作品轮转；每作品一个持久租约，网络调用不持有正文/状态锁。完成时核对 job/lease、授权、模型和保存版本，在既有只读的正文 Revision 锁内原子提交知识状态（不触发 Harness 采纳或改写草稿元数据）。旧 worker 在暂停/替代后取消上下文，不能覆盖新结果。进程崩溃后等待有界 deadline 再恢复；锁文件继承既有保守协议，未知持有者不自动抢锁。

每章任务 pending → running → completed，失败 retry（2/4秒退避）最多3次后 failed；另有 cancelled/superseded。队列最多256个活动项，分批补入；历史任务和幂等回执各上限10000，达到上限需运维评估归档，不能悄悄删历史。已完成同版本/策略/模型不会重跑；作者可明确重新分析一章或全书。

每天 UTC Token 保守预留与调用次数双预算，跨进程原子扣除，重试也收费，可靠 Usage 返回后按实际 Token 结算释放预留余量；未知 Usage 不退预算，重试累计 Usage 并标记不完整。预留按输入字节预算、上下文余量和最大输出 Token 估算上界，不是精确币种费用。记录模型 Usage、调用时长与尝试次数；定价不硬编码。默认每日100000000 Token，UI默认每日200次；调用前有保守预留，超预算的长篇回填可能等待次日或作者调整预算。模型失败、预算到顶均不影响正文保存。

启用时服务端要求每日 Token 预算至少覆盖一次保守预留（上下文字节上限 + 输出上限 + 固定余量），否则该书启用后第一个任务永远无法执行。低于一次预留的预算返回 422，而不是静默接受一个永远空转的配置。

## 索引与增量维护

状态位于 `<STATE_DIR>/knowledge/<安全编码bookId>/index-v1.json`，schemaVersion=1、CAS version、Entity/Assertion/Job/Correction/Change、幂等回执、名称/别名倒排索引在同一跨进程锁 + fsync/rename 事务。状态校验拒绝跨作品来源和悬空实体/关系引用。

每个章节成功结果替代该章旧活动来源；旧 Source 标 retired，保留历史。查询重新核验 Revision/hash/引文/位置，尚未重提取或失败时上一份结果仍显示旧版本，不冒充最新。缺失/归档章节 unavailable，无关章节的来源保持有效。同版本重跑中被省略的旧陈述也退出活动索引，不因相同 Hash 复活。衍生条目都直接依赖原文，不以未核验的多跳 AI 总结建立事实链。

实体新 ID 由作品、章节、类型、名称及身份区分生成，不依赖模型临时 key；重复分析稳定。跨章仅在模型提出合法已有 ID、名称/显式别名相容、身份不矛盾、且该实体仍有至少一个当前有效来源时关联；没有明确关联就保留独立候选，不强合并。完全失去有效证据的旧实体不再作为合并目标，避免后续同名不同人物被折叠进已失效身份。已校验的同实体/谓词/文本/关系/时间陈述合并多来源。语义近似的不同措辞不做未经证实的自动合并，远距离消歧仍有模型质量限制。

作者纠错可将陈述标为角色说法或争议，也可指明某章同名者不是此人。Correction 有稳定 ID、作者、理由、版本、撤销。分离规则在服务端后续重建中强制执行，不仅依赖 Prompt；原实体与旧来源保留。撤销解除限制，不偷偷合并既有实体，后续重分析决定候选关联。

## 私有 API 与 UI

`/v1/studio/books/:bookId/knowledge` 下：

- GET 根目录：type/name（含别名）/chapterId/status/limit/cursor，以及 assertionCursor；实体最多100，陈述每页100。
- GET related（必需 chapterId）、entities/:entityId、jobs、history、corrections。
- POST enable/pause/resume/rebuild/correct/undo：作者、注册表所有权、Idempotency-Key、baseVersion CAS；每作品每分钟最多20个新动作。同键重试不重复执行。

全部 no-store，仅作者可读写。Worker 保留会话、同源/CSRF 和动态作品二次所有权检查，白名单只开放查询与维护动作，不开放通用知识 CRUD。OpenAPI/Zod 见 knowledge-api-v1.json。

沿用 BookView 原分区与暖色布局。真实模式读取私有 API，按分区/章节分页；后台状态每3秒刷新，无全屏阻塞。创作笔记不改。引文可打开保存版本原文并标记精确位置；版本已变化则显示旧引文，不在新版本强行定位。可以打开对应章节继续写作。切作品/章节取消旧请求，旧响应不得改当前界面。历史是 AI 更新记录，作者纠错另列，不能伪装为作者确认。

## 与 Review 的连接

`Retrieve`/`RelatedChapters` 是只读接口，返回保持认识等级的当前原文来源。Review v4 用它优先寻找相关历史章节，最终仍从实际保存 Revision 构造来源，遵循全局卷序、最多64个候选和最终4章、原有完整预览和单次同意。AI 摘要不成为 confirmed Harness 文档，不把 inference 输入当作事实。索引不可用时回退旧历史检索，不影响既有 ReviewRun；既有 v1/v2/v3 不改写。真实 Go 集成测试覆盖抽取→检索→ReviewPlan 原文来源及失败回退。

## 备份、回滚与验收

完整备份现有 StateDirectory，必须包含 knowledge 和含 Intent 的 chapter-drafts；不迁移或覆盖 Harness。部署时先 Go 私有新路由，再 Worker/Web 白名单与 UI。回滚仅程序，保留新状态，绝不用旧备份覆盖新正文。先暂停自动维护再切换执行器。

本 Sprint 在独立分支交付 Open PR，不自动部署。新增合成用例24组，工程 Mock 与真实模型报告分别产出，禁止用 Mock 的 Precision 充当模型质量。真实 Eval 只在明确授权后使用 GitHub Secret，临时目录隔离，最多40次远程调用、总请求1 MiB、每次最多8192输出 Token（独立 Eval 护栏，生产 DeepSeek 默认输出上限为32768），无真实作品。名称匹配是自动金标代理指标；Relation Precision、Unsupported Assertion Rate 与文学叙事判断必须独立语义标注，未标注保持 null。
