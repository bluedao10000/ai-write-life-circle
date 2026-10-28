# 任务路由

先读 [AGENTS.md](../AGENTS.md) 与 [README.md](../README.md)，再按任务选工作流。

| 任务 | 工作流 | 最小上下文 |
| --- | --- | --- |
| 对话共建 / 启发引导 | [dialogue-co-build](workflows/dialogue-co-build.md) | [data-contract](data-contract.md)、state/current.md |
| 正文 / 笔记同步 | [sync-manuscript-notes](workflows/sync-manuscript-notes.md) | [data-contract](data-contract.md)、context/index.md |
| 全局盘点 / 缺失诊断 | [diagnose-gaps](workflows/diagnose-gaps.md) | [health-board](health-board.md)、context/index.md |
| 联网查询辅助 | [web-research-assist](workflows/web-research-assist.md) | [data-contract](data-contract.md)、references/ |
| 健康度看板规范 | [health-board](health-board.md) | 无 |
| 上下文数据契约 | [data-contract](data-contract.md) | 无 |

规则：默认只读 1 个工作流、相关索引和至多 5 个相关文件。上下文不足时按需扩大并说明。

每次对话或同步尾声，都要输出一次健康度看板（见 [health-board.md](health-board.md)）。
