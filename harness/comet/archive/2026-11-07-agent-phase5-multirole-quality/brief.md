# Outcome

为默认关闭的 Creative 五角色只读计划核对建立公平、可复现的单角色与多角色配对评测。两种模式使用同一章节修订、模型、截止时间和现有单角色父预算；评测报告分别呈现确定性正确性、执行成本、Judge 判断与人工双评。合成 Provider 的运行只作为工程证据，不作为真实模型质量结论。

# Scope

保留 Planner、Researcher、Analyst、Critic、Coordinator 五个既有角色及 Go AgentTask / Pi Worker 执行路径。多角色父任务沿用单角色现有单次预留额度，五个角色平均分配，整除余数归 Coordinator。

新增独立版本的开发集与保留集、Go/Pi 同输入配对运行器、确定性评分、Creative 计划核对专用 pairwise Judge、精确绑定运行版本的人工双评导入，以及报告和工程回归测试。无有效双评标签时，人工质量字段为 `null`；合成 Provider 的运行始终标记 `qualityValidated=false`。

本 Change 的开发与验收只使用本机 localhost 合成 Provider，不请求远端或付费模型。多角色功能继续显式 opt-in，评测结果不自动改变作者设置。

## 目录结构

### Created

- `apps/agent/scripts/evaluate-creative-plan.ts` — 按开发集或保留集运行配对评测并写本地报告。
- `apps/agent/src/evaluation/creative-plan-benchmark.ts` — 配对身份校验、确定性评分、专用 Judge、人工标签验证和结果汇总。
- `apps/agent/src/evaluation/fixtures/creative-plan-dev.json` — 版本化合成开发案例。
- `apps/agent/src/evaluation/fixtures/creative-plan-held-out.json` — 与开发集内容独立的版本化合成保留案例。
- `apps/agent/test/creative-plan-benchmark.test.ts` — 覆盖配对、预算、Judge、标签版本和空标签结果。
- `harness/comet/changes/agent-phase5-multirole-quality/specs/creative-plan-paired-evaluation/spec.md` — 配对评测行为规范。

### Modified

- `apps/api-go/internal/creative/jobs.go`、`settings.go`、`query.go` — 两种计划核对模式使用相同的父预留额度。
- `apps/api-go/internal/creative/readonly_orchestration_test.go`、`settings_test.go` — 验证预算不因多角色倍增且五个子预算完整受限。
- `scripts/lib/evaluation-business.mjs` — 采集同修订上的 Go Job、Pi Worker、角色结果和候选证据。
- `apps/agent/src/evaluation/task-schema.ts`、`report.ts` 与 `package.json` — 接入配对评测命令和版本化报告。
- `apps/agent/test/creative-orchestrator.test.ts` — 验证五角色总子预算符合父预算。
- `harness/architecture/agent-controlled-orchestration.md`、`agent-evaluation-platform.md`、`agent-maturity-report.md`、`agent-runtime-governance.md`、`agent-security-threat-model.md` — 记录预算策略、评测证据与质量限制。

### Deleted

None

### Not created

- 独立任务队列、数据库、费用账本或 Agent Runtime — 复用 Go AgentTask、Pi Worker 和现有治理入口。
- 远端 Provider 评测通道 — 本 Change 的运行限制为 localhost 合成 Provider。
- 自动启用多角色或自动写入业务状态的规则 — 评测只产出证据，作者仍控制 opt-in 和正式提交。
- Phase 6 自主规划与执行 — 不属于本 Change。

# Non-goals

- 增加动态 Agent 角色、子任务、工具或写入权限。
- 改变 Go 对身份、授权、费用、任务和正式业务提交的权威。
- 使用远端或付费 Provider，或将合成输出解释为真实模型质量。
- 由评测结果自动开启、关闭或调整作者的多角色设置。
- 启动 Phase 6 自主执行。

# Acceptance examples

- **A1 — 相同父预算：** 单角色与五角色计划核对各预留当前单角色单次额度；五个角色的子预算总和恰等于父额度，任何一个子预算都不扩额，未知 usage 保留整笔预留。
- **A2 — 有效配对：** 开发集与保留集具有独立版本且没有重复 ID 或相同案例内容；每个配对的 Go 回执证明两种运行使用相同输入、修订、模型、Provider、截止策略和父预算。缺少或不匹配的运行不能进入 Judge 评分。
- **A3 — 可追溯报告：** 报告从 Go 任务回执与持久化的 Pi 角色结果生成确定性结论、工具/写入数、模型调用、已知/未知 token、预留暴露和耗时；金钱成本无权威价格时为 `null`。报告记录数据集、策略、输出合同、Runtime、Judge rubric/prompt 版本及 Go/Pi 运行 ID。
- **A4 — Judge 与人工双评：** 专用 pairwise Judge 使用固定 Creative 计划核对 rubric、无工具治理入口和随机候选顺序；确定性失败不得被 Judge 翻转。人工标注必须绑定数据集版本、案例、两侧 Go Job ID、策略与输出合同版本、rubric/prompt 版本；重复标注者或版本/候选不匹配会被拒绝。只有至少两位不同评审者的有效标签进入双评一致性与偏好统计；缺少有效双评时质量值为 `null`。
- **A5 — 合成与权限边界：** 验收只访问 localhost 合成 Provider，报告明确 `realLLMCalled=false` 和 `qualityValidated=false`。多角色保持默认关闭、五个角色无工具且没有业务写入，评测不得自动更改作者设置或执行 Phase 6。
