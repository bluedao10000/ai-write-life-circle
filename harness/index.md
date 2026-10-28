# 任务路由

先读根入口 AGENTS.md，再读本目录 [README.md](README.md)，然后按任务选择工作流。

| 任务 | 工作流 | 最小上下文 |
| --- | --- | --- |
| 部署 Go API 到 EC2 | [deploy](workflows/deploy.md) | [deploy-guide.md](deploy-guide.md)、scripts/deploy/、.github/workflows |
| 新书建档 | [bootstrap](workflows/bootstrap.md) | [data-contract.md](data-contract.md)、proposals/ |
| 写前准备 | [prepare](workflows/prepare.md) | intent、目标章节、相关设定与前文 |
| 写后同步 | [ingest](workflows/ingest.md) | 目标正文、notes/、proposals/ |
| 连续性审查 | [review](workflows/review.md) | 正文、风格基线、审查范围 |
| 灵感整理 / 创作资产（V3） | [ADR](architecture/writer-agent-v3-creative-assets.md) | apps/api-go/internal/creative/、apps/web/src/features/creative/、[交付报告](reviews/writer-agent-v3-report.md) |
| Pi Thinking Agent | [pi-agent](workflows/pi-agent.md) | [ADR](architecture/pi-agent-runtime.md)、[私有协议](contracts/thinking-internal-v1.md)、apps/agent/ |
| Pi 后台 Review / Knowledge | [pi-worker](workflows/pi-worker.md) | [统一 Runtime ADR](architecture/pi-unified-agent-runtime.md)、[迁移报告](reviews/pi-worker-migration-report.md)、私有任务协议 |
| EPUB 导入 | [epub-import](architecture/epub-import.md) | 导入 ADR、管理 API、相关 Go/Web 测试 |
| 表达研究 | [inspire](workflows/inspire.md) | references/、notes/ |
| 接受提案 | [accept](workflows/accept.md) | proposals/、decisions/ |
| 会话交接 | [handoff](workflows/handoff.md) | state/current.md |

规则：默认只读 1 个工作流、相关索引和至多 5 个相关文件。上下文不足时按需扩大并说明。

- 作者体验 P0（恢复、历史正文、审查与注记、Free 审查额度）：[设计与一致性](architecture/author-experience-p0.md)
- 灵感对话可用性与多模型：[设计](architecture/inspiration-agent-usability.md)、[实现与验证](reviews/inspiration-agent-usability-report.md)
