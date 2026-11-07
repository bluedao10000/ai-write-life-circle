# Outcome

产出一份**架构与模块级的结构化结论文档**（Markdown），面向“小说助手 Agent”的设计方案。文档必须基于 `apps/agent` 当前源码与 `harness/architecture` 现有设计文档，覆盖：

1. 目标场景
2. 必备 / 可选能力（设定管理、情节规划、角色与世界观一致性、长文本上下文、章节生成、风格控制、反馈修订）
3. Agent 子项目梳理：目录结构、核心模块、职责边界、调用链路、状态与记忆管理、扩展点、现有约束
4. 理想设计与现有架构逐项对比，并给出“当前架构是否合理”的明确判断与依据
5. 主要风险、能力缺口、可复用部分
6. 改善方向（按影响范围与改造成本排序）、优先级、验收标准

结论聚焦架构与模块级设计；不臆测缺失信息；列出假设与待确认项；不引入未提及的技术栈或代码实现。

# Scope

## Directory structure

### Created
- `harness/comet/changes/novel-agent-design-review/novel-agent-design-review.md`：结构化结论报告（交付物）

### Modified
- `harness/comet/changes/novel-agent-design-review/brief.md`：本 Brief
- `harness/comet/changes/novel-agent-design-review/comet-state.yaml`：Runtime 状态

### Deleted
- （无）

### Not created
- 不修改 `apps/agent`、`apps/api-go`、`apps/web` 任何源码；不产生新运行时依赖、新持久格式或新进程

# Spec exemption

No product behavior change: this change is documentation-only research. The deliverable is a single Markdown conclusions report; no code, schema, runtime format, or process is modified. No target Spec is required, and Runtime checks remain green because no implementation, contract, or acceptance of changed behavior is produced.

# Non-goals

- 不实现任何代码、不新增/修改技术栈（如向量数据库、编排框架）。
- 不评估 Web 前端 UI 实现细节（仅在说明 Agent 接口边界时引用）。
- 不替代 ADR 决策或 Governance 流程；结论是对现有事实的调研与判断，不是新方案落地。
- 不臆测未在本仓库代码/文档中出现的模块或能力。

# Acceptance examples

- [ ] 文档逐条覆盖用户点名的 7 项能力（设定管理、情节规划、角色与世界观一致性、长文本上下文、章节生成、风格控制、反馈修订），并标注每项在现有架构中的成熟度（已验证 / 部分覆盖 / 未实现）。
- [ ] 文档给出 Agent 子项目（apps/agent）的：目录结构、核心模块、职责边界、调用链路（Thinking 与 Worker 两条）、状态与记忆管理、扩展点、现有约束。
- [ ] 文档对“理想小说助手设计 vs 现有架构”做逐项对比，并给出“当前架构是否合理”的明确判断与依据（引用具体模块/文档）。
- [ ] 文档列出主要风险、能力缺口、可复用部分，且每条有代码/文档出处。
- [ ] 文档按“影响范围 × 改造成本”排序改善方向，给出优先级与可验证的验收标准。
- [ ] 文档显式列出假设（assumptions）与待确认项（to-confirm），尤其是“章节生成”在本项目中的边界（ADR 明确作者写正文、AI 不自动生成章节正文）。
- [ ] 不引入未在请求中出现的第三方技术栈、框架或具体代码实现要求。

# Open questions

- [ ] Q1（待确认项，非阻塞）：本项目 ADR（architecture.md）明确“正文由作者书写、不设 AI 自动发布章节/自动决定剧情/自动演化风格闭环”。因此本报告将“章节生成”解释为**章节相关的结构化生成物**（创作计划、提案、计划-正文偏离报告、评论/知识候选、讨论记忆），而非正文代写。若该目标场景已扩展为“AI 辅助起草正文”，需作为新假设补充。
