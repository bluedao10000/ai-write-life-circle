# Agent 性能基准

## Worker吞吐量

在仓库根目录运行：

```sh
pnpm bench:agent:worker
```

命令构建当前Go API与Agent，在隔离目录和loopback端口启动真实Go/Pi Worker。模型使用本地合成HTTP响应，不读取生产作品、不调用真实Provider。报告写入 `.local/benchmarks/agent-worker.json`，包含代码提交、dirty状态、Runtime版本、策略版本、Node/Go版本、系统/CPU信息和每轮原始数据；报告不自动提交。

固定工作负载为2部作品，每部6章。比较1个与2个Worker，每个Worker限1个执行槽；各运行3轮，交替先后顺序。每轮重新创建状态，EPUB导入与Worker启动不计入执行区间。启用Knowledge前所有任务暂停，实际Provider调用数必须为0。

计量从批次启用开始，到全部Go任务回执可读取为止。吞吐为完成任务数除以该区间秒数；完成延迟为Go回执completedAt减批次启用时间，包含排队。报告P50/P95按所有任务样本计算，不能解读为单次模型延迟。API轮询间隔沿用fixture的40ms，任务回执读取开销属于这套测量方法。

每轮要求所有预期章节各完成一次、任务回执ID唯一、每个完成任务恰有一次Provider调用、usage完整、Canon未新增。输入/输出Token读取Go领域任务结果。出现任务失败、超额调用或不完整usage时基准失败，不生成成功报告。每轮完成等待上限120秒；单个本地Provider的调用数限制为12次。

该场景Provider返回空知识候选，衡量调度、协议、持久化及回执路径，不测真实模型质量、网络抖动或大正文成本。单机3轮的小样本不能用于生产容量承诺，也不代表多Agent编排的收益。调整生产并发前应补充代表性数据和真实模型预算内的授权实验。

## Memory Retrieval延迟

```sh
pnpm eval:agent:memory
```

报告位于 `.local/evals/agent/dev-memory.json`。工具耗时来自真实Thinking治理审计，覆盖网关授权、输入/输出校验及Go读取，排除此前模型等待。报告保留原始调用样本与P50/P95；无样本时返回null。其生命周期与隔离断言见 [Evaluation Platform](../architecture/agent-evaluation-platform.md)。
