# Writer Agent

**An author-led writing workbench for long-form fiction.** React 19 + TypeScript frontend, Go API, shared contracts, pnpm monorepo. MIT licensed.

Most AI writing tools ask you to trust the model. This one asks the model to prove it: every continuity finding must cite an exact quote from the manuscript, and the author marks it useful, false positive, intentional, or ignored. Findings go stale automatically once the text or the evidence changes. A deterministic eval harness (`pnpm eval:review`) ships in the repository, so review quality is measured rather than claimed.

- **Live:** https://www.story2u.xyz — writing studio at `/studio`
- **Run locally:** `pnpm install --frozen-lockfile && pnpm dev:local`
- **Verify:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
- **Docs:** [`harness/`](harness/) — architecture, ADRs, OpenAPI contracts

The author makes every creative decision. The AI assists; it does not write the manuscript, and it does not silently update canon.

---

作者主导的写作工作台。React + TypeScript 前端、Go API 与共享契约组成 pnpm Monorepo。

## 本地开发

```sh
pnpm install --frozen-lockfile
pnpm dev          # Demo 界面
pnpm dev:local    # 本地 API + 前端
```

默认 API 为 Go，单独运行其二进制无需 Node.js；前端工具链仍使用 pnpm。本地 API 仅提供开发身份。Go 已支持作者主动触发、固定修订与精确引文核验的连续性审查；需配置真实模型并逐次授权发送范围。通用 Agent Runtime 与正式知识写入尚未实现；Demo 模拟能力与 API 数据隔离。详情见 [Web](apps/web/README.md) 与 [Go API](apps/api-go/README.md)。

## 目录

| 目录 | 必要职责 |
| --- | --- |
| `apps/` | Web 与 API 应用 |
| `packages/` | 共享类型、数据契约与校验 |
| `scripts/` | 开发、生成、校验工具；部署配置在 `scripts/deploy/` |
| `harness/` | 唯一文档中心：架构、设计、API 规范、工作流与验证报告 |

`node_modules/` 是 pnpm 依赖，由安装命令生成；`.github/` 保存 CI/CD；隐藏的编辑器配置保留其约定路径。原 `docs/`、`design/` 已合并到 `harness/`，原 `deploy/` 已归入 `scripts/deploy/`。

## 入口与验证

- [协作入口](AGENTS.md) · [文档索引](harness/README.md) · [任务路由](harness/index.md)
- [API 规范](harness/contracts/README.md) · [前端架构](harness/architecture/frontend-architecture.md)
- [设计来源与同步](harness/design/figma.md) · [部署说明](scripts/deploy/README.md)
- [Go 迁移基线](harness/architecture/go-backend-migration.md)
- `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`
- `pnpm openapi:check`、`pnpm openapi:lint`、`pnpm test:e2e`

作者负责创意决策与小说正文。项目维护不代写正文，不自动更新正式设定；外部作品目录与本项目应用状态应分别管理。

## 连续性审查（Sprint 3）

先保存真实章节，再点击“审查本章”，核对模型、资料范围并勾选授权。完成后按需查看页边注记、两处只读证据，标记有用/误报/有意为之/忽略；所有判断仍由作者确认。正文或证据变化后旧结果标记过期。未配置模型时禁用新审查，不加载演示发现。

配置与限制见 [Go API](apps/api-go/README.md)、[审查设计](harness/architecture/sprint3-evidence-review-agent.md) 和 [评测说明](harness/evals/review-agent/README.md)。`pnpm eval:review` 运行隔离的确定性工程评测；真实模型验证按用户决定暂缓，不能据此宣称审查准确率。

### story2u 公开网站 V1

作者在 `/studio` 保存章节，通过 `/studio/publish` 预览并主动发布；访客从 `/` 发现作品，在独立作品/章节 URL 阅读。草稿自动保存不会改变公开内容。公开页面由现有 Cloudflare Worker SSR，Go Publication 保存不可变快照与历史；下架和撤回后的新请求不读取旧公开内容。

Google 登录、公开站点与在线作品管理已合并并部署。正式入口为 https://www.story2u.xyz，写作入口为 `/studio`。Cloudflare Worker 提供 SSR、Better Auth/D1 会话和同源代理；Go API 位于 https://api.story2u.xyz。任何已验证邮箱的 Google 账号都可登录，每个账号是独立作者：Worker 为每个请求签发 Ed25519 用户声明，Go 同时校验它和服务端 Bearer（见 [Google 登录](harness/google-login.md)）。部署兼容条件、版本核对和回滚见 [生产部署指南](harness/deploy-guide.md)。

本地公开站点可使用 `WRITER_AGENT_PUBLIC_SSR=1 VITE_STORY2U_PUBLIC_SITE=true VITE_WRITER_AGENT_MODE=api VITE_WRITER_AGENT_PROJECT_ID=local pnpm dev:local`（开发环境既有本地身份）；生产构建必须配置 Google 登录，禁止开发身份。`pnpm test:publication` 运行隔离真实 HTTP 契约检查，`pnpm test:e2e` 包含公开站点全链路、SEO和四种宽度截图。

[出版事务](harness/architecture/publication-domain.md) · [渲染 ADR](harness/architecture/public-site-rendering.md)

### 开始写作与在线作品管理（Sprint 3.5）

Go API 支持在 Studio 内创建在线作品，无需创建 Markdown 文件。没有作品时点击“开始写作”即可进入空白第一章；顶部作品菜单切换/创建/改名/删除，左侧目录创建章节和可选卷、原位改名、排序、移动、归档与恢复。自动保存继续使用已有 Revision/CAS/本地恢复机制；保存失败或待恢复草稿会阻止结构操作。公开发布仍需作者另行确认。

删除作品需二次确认；已公开作品须先下架。删除会永久清理正文修订、笔记、审查、知识记录及导入资料，删除最后一本后返回开始写作页。外部只读作品不能删除。

在线结构存于状态目录 `works/catalog-v1.json`；正文仍存于既有 `chapter-drafts`，外部 Harness 保持只读且不自动迁移。作品按作者隔离；per-user 之前的数据只由配置的旧所有者账号继承。详见 [架构与回滚 ADR](harness/architecture/author-workspace-management.md) 和 [管理 API](harness/contracts/management-api-v1.json)。专项浏览器验收：`pnpm --filter @writer-agent/web test:management`（只使用临时合成数据）。

### EPUB 作品导入（Sprint 4.6A/4.6B）

作者可从作品菜单上传文本型 EPUB 2/3，预览卷章、字数和警告，并在确认前修改少量书名、卷名或章名。导入只还原正文与结构，不调用模型；全部章节的初始 Revision 写入成功前，作品不会出现在书架。知识库仍须在「书」中另行授权。当前单章 Markdown 上限为 2 MiB；超限的长篇 EPUB 会在预览阶段明确拒绝，需先拆分源文件后重试。

当前会明确警告或拒绝非线性内容、固定版式、DRM、不安全 ZIP、目录部分覆盖及超限文件，不使用 OCR。详见 [EPUB 导入架构与限制](harness/architecture/epub-import.md)。

### 独立 Pi Thinking Agent（Sprint 5，尚未生产发布）

Node >=22.19.0，Pi SDK 1.3.0；Go Review/Knowledge Worker 保持不变。配置、授权与回滚见 [Pi 工作流](harness/workflows/pi-agent.md) 和 [ADR](harness/architecture/pi-agent-runtime.md)。`pnpm dev:agent` 单独启动；配置就绪后 `pnpm dev:local -- --agent` 可启动完整开发栈。无 Agent 时编辑/保存继续可用。

`pnpm test:agent`、`pnpm test:thinking`、`pnpm --filter @writer-agent/web test:thinking` 和 `pnpm eval:thinking` 均使用隔离 HTTP 模型。真实模型 Eval 仅 `pnpm eval:thinking:live` 手动选择，不读取作者目录。模型成功返回与文学语义质量分别验收。发布打包使用 `pnpm package:agent -- <新目录>`；本 Sprint 不自动部署、不合并 PR。
