# 前端与 API 边界

Writer Agent 使用 React + TypeScript + Vite + Tailwind + TipTap。

## 目录结构

- `app/App.tsx`：加载工作区，组合各空间与弹窗。
- `components/vnext/`：展示组件与基础控件。
- `features/vnext/useStudioController`：导航、抽屉、选区、当前会话。`usePrototype`：隔离的 Demo 状态。
- `features/workspace/`：保存控制器、正文画布、只读服务端冲突预览。
- `features/notes/`：笔记加载、创建、编辑、归档、重试。
- `features/knowledge/`：书空间和旧版演示记录的只读兼容。
- `hooks/useManuscriptBridge`：读取字数与段落投影。投影不参与 Markdown 保存。
- `services/api/`：HTTP 路由。`services/mappers/`：DTO 映射。`mocks/`：仅 Demo 使用。
- `packages/contracts/`：共享 Zod、TypeScript、Note 与 Workspace 能力声明。

## 两种模式

Demo 展示原型，使用独立浏览器笔记命名空间。API 模式必须配置 `VITE_WRITER_AGENT_PROJECT_ID`，读取真实 Workspace、Chapter、Revision、Notes，响应均做运行时校验。API 不加载 Demo 数据或 Agent。

## 正文安全

Markdown 是保存源。保留原始 Markdown、revisionId、contentHash、baseRevisionId、Idempotency-Key、失败输入、本地恢复、内存导出。HTTP 409 暂停自动保存并取消旧版本排队请求。故事冲突使用独立模型和暖色，无正文写入动作。

查看服务器版本是只读 GET。使用服务器版本需二次确认与勾选。失效或多处匹配的引文不静默定位。

## 笔记

真实链路：Notes UI → NotesAdapter → Zod → 作者权限 API → 文件型应用状态。笔记与正式知识隔离。更新用版本 CAS，创建和更新都用稳定重试键。

## 证据审查

`features/reviews/useReviewController` 管理预览、授权、异步轮询、取消、反馈与历史。`ReviewConsentDialog` 显示服务端冻结的模型与来源范围，授权绑定 planHash。`ReviewMarginPanel` 区分核验引文与未确认的 AI 推断。

`lib/reviewAnchor` 先核对原始 Markdown 的 UTF-16 唯一位置，再映射到 ProseMirror 文档。多处匹配或无法精确映射时不定位。本地编辑、固定修订或历史来源改变均使旧结果失效。

## 公开阅读与出版

`src/site` 与 Studio 私有模型分离。`server.tsx` 在 Worker 输出真实 HTML 与安全 hydration。阅读器使用只读 Markdown，不加载 TipTap 或 AI 管理功能。草稿、笔记、审查不会成为站点数据源。

`/studio/publish` 复用 AuthGate。四步向导调用 publicationApi，选择最新保存版本、服务端固定预览、双重人工确认、CAS 与幂等提交。更新、撤回、下架追加出版版本，不改原始草稿。

## 作品管理

`App` 通过 API adapter 发现受信任作品。`ManagedStudio` 拥有作品选择、幂等回执、结构版本和安全操作。空作者显示「开始写作」。`BookMenu` 在顶栏，`ManagedDirectory` 在章节抽屉位置。

创建、切换、重排、归档前，`ManagedStudio` 等待现有保存队列确认，并让 Studio 在请求期间 inert。保存失败或 CAS 保留当前编辑器。选择只使用服务端返回的 owned ID。

签名 Better Auth 会话在 Worker 中是权威。动态作品 ID 必须匹配生成格式、通过路由白名单，并先收到所有权 GET 才代理。Go 在每次应用和出版操作上再次检查所有权。
