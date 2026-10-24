# Knowledge Extraction Eval

`cases.json` 是24组手工设计的合成输入和名称金标，覆盖人物/关系、别名/同名、时间、规则例外、伏笔、说谎/观点、修订、重跑、跨卷、注入与错误恢复。不是作者真实小说，也不是语义能力已经通过的证据。

## 三类证据

1. `pnpm test:knowledge`：HTTP模型替身→真实 Go 保存/任务/索引/查询。替身由固定代码产生候选；只证明工程链路。超时、坏输出、伪造引文、崩溃、权限、预算、105章回填等另由 Go Race 回归覆盖。
2. `pnpm eval:knowledge:live`：显式 `--confirm-fixtures` 只发送这里的合成输入。使用本地 WRITER_AGENT_LLM_API_KEY（DeepSeek 默认）或显式兼容服务配置。模型请求通过临时本机预算网关，最多40次、总请求1 MiB、输出每次最多8192 Token（独立 Eval 护栏，生产 DeepSeek 默认输出上限为131072）；不连接生产 API、真实状态或作者 Harness。
3. 人工语义标注：检查说谎、成长、身份未知、同名消歧、时间关系、近似事实重复等。自动名称对齐和逐字引用不能代替这一步。

用户已授权 GitHub Actions 合成 Eval，见 Synthetic Knowledge Model Eval。交付时保留仅 workflow_dispatch 手动入口；推送和普通 PR CI 不运行付费模型。此次开发已授权的一次性分支触发记录单独留在 Eval 报告。沿用 GitHub Secret WRITER_AGENT_LLM_API_KEY；可选 Variables WRITER_AGENT_LLM_BASE_URL/MODEL，无值沿用 DeepSeek 默认。报告 artifact 保留7天，仅含合成结果。模型 Secret 不打印、不写入报告。

## 指标解释

报告逐例给出 Entity Precision/Recall（名称或显式别名精确对齐金标，仍需人工复核别名）、Evidence Validity（仅已接受引用；失败 job 单独计，不能当成功）、Entity Dedup Accuracy（重复出场）、Revision Update Accuracy（修改年龄）、Stale Knowledge Rate（活动陈述缺少当前来源）、实际 Usage Token、任务耗时、尝试次数和整体调用预算。

Relation Precision / Unsupported Assertion Rate 在没有独立人工关系和语义标注前为 null。不能把空结果的引用有效率100%称为成功，必须结合 Recall、failed jobs 与样例结果。真实模型 qualityValidated 默认为 false，作者检查后才能作产品质量判断。

对 `homonyms` 额外检查两位同名人物、`rename` 检查别名来源、`relationship-change` 检查关系的时态、`foreshadowing/payoff` 检查候选与明确回收。不要只读名称平均分。

`WRITER_AGENT_KNOWLEDGE_EVAL_OUTPUT` 可指定本地报告路径；含纯合成输出，文件0600。没有实际 live run 时应报告真实模型案例0、Precision/Recall未验证，而不是复制 Mock 分数。新增用例仍须使用合成材料。
