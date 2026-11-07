# Creative 计划核对配对评测

## 数据集

开发集与保留集各有独立版本，均使用严格 JSON 合同及合成案例。每个案例提供唯一 `caseId`、完整计划核对请求、期望判断和可核对的证据片段。加载器拒绝重复 ID、重复请求、split 或版本错误，以及开发集和保留集之间相同的 ID 或案例内容。评测报告保留实际 split 与数据集版本。

运行器只接受 `dev` 或 `held-out`，通过既有真实 Go API 与 Pi Worker 执行同一个案例的单角色和五角色任务。两个任务必须引用相同章节修订、正文内容版本、输入、provider/model、截止策略和父 token 额度。单角色执行一次调用；多角色须由 Go 回执证明五个登记角色均已完成。缺少或不匹配的回执作为工程失败保留，不能进入 Judge 或质量统计。

## 预算与任务权限

Go 为两个模式各预留当前单角色单次额度。多角色总父额度不得按角色数倍增，五个模型步骤的 `maxTokens` 合计恰等于父额度，平均分配的整数余数分配给 Coordinator。Go 保持预留、准入、Usage 结算和未知 Usage 保留权威；未知 Usage 仍保留全部父预留。

五个角色继续无工具调用能力。评测可以在现有 Go 计划核对任务中保存 Divergence 业务结果，但不得产生工具调用、章节 Revision、计划 Asset 或 Canon 修改。取消、deadline、Go started 和 Pi Worker 生命周期沿用现有合同，不创建额外调度或任务状态。

## 确定性评分与配对报告

评分只读取真实 Go task/job 终态、Pi 持久角色步骤及本次合成案例的期望。检查任务完成、角色齐全、模型调用数、相同修订和输入、父预算一致、五个子预算之和、实际 Usage、引用证据是否属于本章、判断是否符合期望、问题/解释是否存在，以及工具与正文/设定写入数。

配对失败保留失败与已观测费用，`null` 表示 Usage 未知。报告包含数据集与 Runtime 版本、策略和输出合同版本、Go task/job ID、Pi 角色及调用轨迹、模型、截止时间、预留和实际 token、调用数、工具/业务写入数、任务与角色耗时、单角色/多角色确定性结果和失败。P50/P95 仅按实际有样本的运行计算。货币成本在没有权威价格时为 `null`。

## Pairwise Judge

Creative 计划核对 Judge 使用专用 rubric `creative-plan-check-pairwise-v1` 与独立 prompt 版本，评分证据支持、判断准确、保留不确定性和对作者的有用程度。它只比较满足配对确定性准入的两个输出；候选输入视为不可信内容。候选顺序随机化，结果映射回原 Go Job ID 并保存顺序。Judge 使用现有 `evaluation.judge` Model Gateway 治理身份、费用预留、超时和取消，不开放工具，每个合格配对最多调用一次；失败不重试。

Judge 不能改变确定性结果或使不合格配对通过。构建与验收仅使用 localhost 合成 Provider；报告标记 `realLLMCalled=false`、`qualityValidated=false`。合成 Judge 输出是治理与 schema 测试证据，不代表语义质量。

## 人工双评

标注是单独导入的严格 JSON 数据。每条标签绑定 `datasetVersion`、`split`、`caseId`、single/multi 两侧的 Go `jobId`、策略版本、输出合同版本、provider/model、Runtime 版本、Judge rubric/prompt 版本，以及 reviewer 和时间。Judge 结果与人工标注不会复制或改写业务源数据。

导入时按报告中的配对逐项核对所有绑定字段；拒绝重复 reviewer/case、未知配对、不匹配版本、无效赢家或确定性不合格配对。至少两名不同 reviewer 的有效配对才计入双评一致性及人类偏好统计；不足双评的样本只计入标注覆盖数。没有有效双评时，质量字段均为 `null`。即使有人工标签，合成 Provider 的结果仍标记 `qualityValidated=false`。

## 报告与运行

命令 `pnpm eval:agent:creative-plan -- --split=dev|held-out [--annotations=<path>]` 运行所选数据集并在 `.local/evals/agent/` 写出本地 JSON 报告。报告保留失败、未知 Usage、Judge 与人工标签证据，不提交到 Git。评测不得自动修改多角色开关；该功能仍由作者显式 opt-in。

## 验收映射

| Brief 验收项 | Spec 行为 |
| --- | --- |
| A1 | 预算与任务权限 |
| A2 | 数据集、单角色与多角色配对身份 |
| A3 | 确定性评分、配对报告与报告运行 |
| A4 | Pairwise Judge 与人工双评 |
| A5 | 预算与任务权限、Pairwise Judge、报告运行 |
