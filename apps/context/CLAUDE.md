# Novel Context Harness - Claude Code 入口

本目录（`apps/context`）是基于 **Harness 架构** 的**小说上下文协同建设工作区**。

完整协作规范请首先阅读 [AGENTS.md](AGENTS.md)，并根据 [harness/index.md](harness/index.md) 路由任务。

## 🔑 核心法则速览

1. **人机分工**：
   - **人类**：在 `manuscript/` 编写小说正文，在 `notes/` 编写创作笔记，并与 AI 对话探讨设定。
   - **AI**：维护 `context/` 下的五大上下文（**人物 `characters/`、世界观 `world/`、时间线 `timeline/`、剧情结构 `structure/`、伏笔 `foreshadowing/`**）。**严禁 AI 代写或修改 `manuscript/` 正文**。
2. **上下文来源优先级**：
   - **主要依据**：人类与 AI 的对话（通过启发式提问挖掘小说“以小见大”背后的深层人物弧光、世界底层逻辑、暗线与伏笔）。
   - **次要依据**：人类在 `manuscript/` 和 `notes/` 中创作的内容（逆向提炼细节并补充进上下文）。
3. **更新机制**：
   - **对话确认即直接更新**：在对话中与人类达成一致后，直接写入 `context/` 对应文件并更新索引。
4. **联网辅助**：
   - 当人类不确定如何建设某块缺失的上下文时，主动调用联网搜索工具查询历史、行业、科学、民俗或叙事结构资料，提供可落地的选项并将资料归档至 `references/`。
5. **固定尾声看板**：
   - **每次对话或同步结束时**，必须按照 [harness/health-board.md](harness/health-board.md) 输出简短的**「📊 小说上下文健康度看板」**（展示整体情况、优势项、缺失项及下一步引导建议）。

## 🧭 快速路由

- 任务路由表：[harness/index.md](harness/index.md)
- 数据契约与元数据格式：[harness/data-contract.md](harness/data-contract.md)
- 健康度看板模板：[harness/health-board.md](harness/health-board.md)
- 当前进度状态：[state/current.md](state/current.md)
- 上下文总索引：[context/index.md](context/index.md)
