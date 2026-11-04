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

Knowledge业务案例从实际保存的Revision执行提取，检查Go中的实体、观察、来源Revision、原稿版本和正式资产数量。Creative业务案例启动Thinking会话后由Worker整理，检查Go中的待确认提案、作者消息证据及正式资产数量。两者以第二作者身份请求同一资源，要求404。Creative usage汇总Thinking响应与Go持久任务usage；缺少任一usage时总量保持未知。模型输出仍由本地fixture提供，来源与隔离结果属于工程验收。

可靠性案例在Knowledge模型请求发出后对Worker执行SIGKILL，暂停该业务域并重启Worker，等待本地Provider完成迟到响应后读取Go任务、预算和观察；另一个案例由真实请求超时触发Go故障回执。每日任务预算限制为1，禁止评测中的自动重试扩大调用。未知usage保留null；只有Go记录的正整数token exposure在案例预算内时，才允许预算检查通过。该exposure不是已知消耗，不计入已测token指标。SIGKILL案例验证暂停后的安全重启，不将其描述为原任务自动恢复。

## Judge与校准入口

`pnpm eval:agent:judge`运行独立合成开发集，报告写入`.local/evals/agent/judge-dev.json`。`evaluation/judge.ts`定义`writing-judge-v1` rubric（遵循请求、证据、清晰度，0–4分）与`judge-prompt-v1`；pointwise返回逐维分数，pairwise返回A/B/tie。候选顺序随机化并记录，输出映射回原候选ID。严格JSON校验拒绝非法分数、缺失字段、错误版本及额外字段。确定性失败的候选即使得高分也不具备通过资格。

`evaluation.judge`是Registry独立角色，无scope、无工具、单次模型请求。`completeJudgment`复用Pi Models API、受限fetch与ModelRequestGate，最终payload先做大小和token上限检查，再授权及预留，网络返回后结算usage。没有已知usage则保留预留；不自动重试。合成运行最多10次调用、100000 tokens，每次预留10000；本地预算只约束fixture，不授予Go业务额度。报告保留失败、调用轨迹与费用；任何执行失败使命令退出非零。当前没有真实付费Judge入口。

人工标注可通过`pnpm eval:agent:judge -- --annotations=/absolute/path/annotations.json`导入JSON数组。每条包含`caseId`、`datasetVersion`（`judge-engineering-dev-v1`）、`rubricVersion`、`reviewerId`、`annotatedAt`和`label`。pointwise的label为0–4整数总体分数；pairwise为原候选ID或`tie`。校准拒绝重复标注、未知案例、错版和非法标签，输出样本数、pointwise平均绝对误差及pairwise一致率。无人工样本时指标为null；测试中的合成标注不写入报告。该合成Judge固定返回分数，仅证明治理与计算链路，不证明评审质量或抗注入能力。
