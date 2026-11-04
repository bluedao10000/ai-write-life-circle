# ADR：统一 Agent Evaluation

日期：2026-11-04。状态：Phase 2 实现中。

任务由 Request、Environment、StoppingCriteria、Scorer 组成。严格 schema 包含 taskId、能力、难度、合成 fixture、初态、期望与禁止行为、时间/token/tool预算、确定性评分器及可选 judge/human rubric。Fixture 由 runner 安装，执行结果必须来自实际 Agent 入口；不得把期望输出作为模拟执行结果。

Dataset 有独立版本与 split，五类 task-success/reliability/memory/safety/performance 各有 dev 和 held-out。优化仅使用 dev；held-out 不暴露给提示生成。报告记录样本来源和使用目的；修改过的 held-out 样本退出最终能力集，不再声称独立。

优先适配现有 thinking-fixture、pi-worker-fixture、可靠性子进程与攻击测试。runner 限制并发、deadline、总费用；停止时取消并等待资源回收。事件查询必须按 cursor 排空，不能只读200条首批事件。严格区分无法测量、没有发生与通过。

确定性 grader 检查工具参数、授权、最终业务状态、重复提交和费用。质量指标只在有可核验标签时计算；分母、失败样本和未知 usage 一并报告。费用没有价目依据时仅报告 tokens/reservation，币种金额为 null。延迟报告 p50/p95、样本量与冷/热条件。

可选 Judge 走同一模型治理入口，固定 rubric 与结构化结果，pointwise/pairwise 分别记录版本；被评内容作为不可信数据，不允许调用工具、网络或变更评分规则。随机化 pairwise 顺序，人工标注独立保存并报告一致性/样本数。无人工样本时一致性为 null。确定性拒绝不能被 Judge 分数覆盖。

报告包含 commit（含dirty标记）、Pi版本、Provider/Model、prompt/tool/dataset版本、配置、逐项得分、轨迹、失败与费用。CI 默认 mock/deterministic；真实模型需显式参数与合成材料、调用/token硬上限，禁止自动读取生产凭证。

统一命令 eval:agent 及 reliability/memory/safety/performance 在 Phase 2 实现后登记。原评测保留，用适配器汇总，不能将 shell exit0 直接转为真实任务成功率。

## 实现进度

基础Schema、split校验、Runner、程序评分、聚合报告与五类命令已落地。默认 `pnpm eval:agent` 构建Go API与Agent后使用dev；分类命令通过 `--category` 选择，`--split=held-out` 显式选择保留集。适配器覆盖生产PiHost、Worker候选解析、Tool Gateway、EventStore和讨论压缩算法。Review业务适配器启动真实Go API和Pi Worker，读取Go终态、usage、候选数与拒绝数，核对原稿未变；覆盖正常完成、完成回执丢失和伪造来源。每份报告将工程通过率与真实质量分开，未测结果为null。

CI执行合成dev数据，不调用真实Provider。Review fixture按评测调用数与token上限拒绝超额输出，失败或取消后的未知usage不记为零。进程在每个案例结束或取消后关闭，临时目录随fixture回收。报告仅写入本地`.local/evals/agent/`，不自动提交。Judge、其他业务终态与完整故障评测仍在后续范围。具体证据和剩余验收见 [成熟度报告](agent-maturity-report.md)。
