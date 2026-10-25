# Harness 文档中心

本目录存放项目文档。读取原则：按需读取，不一次加载全部。

## 入口

- 任务路由：见 [index.md](index.md)。先选任务，再读对应工作流。
- 领域数据契约：[data-contract.md](data-contract.md)
- 生产部署：[deploy-guide.md](deploy-guide.md)
- 安全红线：[security.md](security.md)
- Google 登录：[google-login.md](google-login.md)

## 架构

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture/architecture.md) | 架构决策与 Harness 职责 |
| [frontend-architecture.md](architecture/frontend-architecture.md) | 前端与 API 边界 |
| [adapters.md](architecture/adapters.md) | 编辑器与模型接入 |
| [harness-mapping.md](architecture/harness-mapping.md) | Markdown 到领域实体的映射 |
| [go-backend-migration.md](architecture/go-backend-migration.md) | Go 后端迁移基线 |
| [publication-domain.md](architecture/publication-domain.md) | 出版领域 |
| [public-site-rendering.md](architecture/public-site-rendering.md) | 公开站点渲染 ADR |
| [ai-knowledge-memory.md](architecture/ai-knowledge-memory.md) | 私有 AI 作品记忆、授权与增量维护 |
| [writer-agent-v3-creative-assets.md](architecture/writer-agent-v3-creative-assets.md) | V3 创作资产、灵感整理、计划与正文差异 |
| [sprint3-evidence-review-agent.md](architecture/sprint3-evidence-review-agent.md) | 证据审查 Agent |
| [author-workspace-management.md](architecture/author-workspace-management.md) | 作品管理 ADR |
| [ADR-0002](architecture/adr/ADR-0002-vnext-author-notes.md) | 作者笔记 ADR |

## 设计

- [figma.md](design/figma.md)：设计来源与同步状态
- [sync-workflow.md](design/sync-workflow.md)：Figma 同步工作流
- [figma-v3-sync-report.md](design/figma-v3-sync-report.md)：V3 Figma Make 同步的组件映射、实测视觉差异与未解决项
- [pricing-plans.md](design/pricing-plans.md)：Free / Plus / Pro 付费方案、AI 点数计量与分阶段实施规划

## 契约

- [contracts/README.md](contracts/README.md)：API 契约与生成说明

## 原则

1. 按需读取。
2. 按任务路由。
3. 最小上下文。
