# Thinking Eval

隔离的三章人物关系材料，永远不从真实作品目录取数据。Fixture 的实际保存由 `scripts/lib/thinking-fixture.mjs` 创建，顺序分别代表第1/5/12章；章节标签只是合成元数据，不代表已实现全书推理。

- `pnpm eval:thinking`：真实 Pi SDK、Go 进程、HTTP 替身。测试工程与来源定位，不测试模型智能。
- `pnpm eval:thinking:live`：手动付费选择，仅一个合成问题，四轮上限，无重试，64,000 保守 Token 预留上限。需要本地 WRITER_AGENT_LLM_API_KEY，可选 BASE_URL / MODEL；默认 DeepSeek。该命令不会部署、不会读取线上 Secret。
- 输出：`.local/evals/thinking-agent/{mock,live}-report.json`。含合成回答、实际工具事件与指标，默认不提交。CI 只执行 Mock，并可上传此隔离 Artifact。没有自动付费工作流。

自动指标：Citation Validity（引用 marker 是否属于 Go 验证来源）、Relevant Chapter Recall（预期三章命中）、工具次数/每相关章开销、Completion Rate、报告/保守预留 Token。无引用的 Citation Validity 为 null，不以空集合充当 100%。SDK 缺少用量时按预留收取；货币费用不能从虚构的 SDK 零单价推导，按提供商账单独立核对。

人工指标必须单独标注：Evidence Precision（被引用原文是否支持解释）、Unsupported Claim Rate（分析中的事实性断言是否有依据）。引文存在不等于推断成立。对每个断言标记 observation / character-claim / inference，记录被支持的引文、替代解释和意图判断；重点复核人物说谎、成长和视角变化。保存标注者、日期、理由及 blind answer 标识，不让同一个模型给自己评分。

初始 `qualityValidated=false`；即使真实 API 成功返回也不修改。需要真实文学语义人工复核，且三章小样本不能证明对长篇整体的理解。预算、工具白名单、取消、离线删除、崩溃恢复由独立工程测试保证，不混入语义分数。
