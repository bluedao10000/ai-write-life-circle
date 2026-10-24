# Figma 设计来源与同步状态

最新读取：2026-10-24（Writer Studio V2.1「书」页）。

## 来源

来源：[Writer Agent UI/UX Design](https://www.figma.com/make/kWBOdcae5utBZ6VtBHHXui/Writer-Agent-UI-UX-Design)。fileKey `kWBOdcae5utBZ6VtBHHXui`，node `0:1`，React / TypeScript。

UI 权威是当前 src/site、src/index.css 与 site handoff。旧 V0.4 文档带历史标记，只作背景。

## 已同步

稿纸、写作 / 书 / 思考导航、按需章节与注记 / 思考抽屉、续写卡、随手记、作品记忆、思考四阶段、故事冲突对照、定稿候选演示。CSS tokens、图标、暖色 Light/Dark、18px / 1.9 中文正文来自当前源码。

保留现有 Markdown + TipTap 管线、只读保护、不可变草稿版本、幂等、409、排队保存取消、恢复和内存导出。新增真实笔记列表、创建、编辑、归档。

Demo 展示模拟知识、注记、思考和候选变更，研究引用标为未核验。API 模式有真实章节与笔记，其余能力明确不可用。

## 视觉证据与限制

Playwright 检查 1440、1024、768、390px，Light/Dark、写作、抽屉、Focus。未执行 Figma 服务端截图像素差分，不能称全应用逐像素还原。

## 契约来源

完整来源 `contracts/source/api-spec-v0.4.0-figma-copy.yaml` 保留。Note 与 Capabilities 是独立工程扩展，不冒称 Figma 新 API。

## 公开站点

2026-10-17 读取同一 Make 的公开站点导出，新增 Home、Discover、Book、Reader、Publish。公开站点 SSR、SEO 与撤回语义见 [公开站点渲染 ADR](../architecture/public-site-rendering.md)。

## Writer Studio V2（2026-10-22）

读取方式：MCP `get_design_context(0:1)` 返回了资源清单，但客户端无法读取资源内容，因此改为读取作者导出的 Make 源码。已同步 V2 Tokens、作品菜单、知识状态与进度、授权布局、审查状态、思考工具时间线、EPUB 对话框、续写卡和随手记。公开站点留给单独的 PR。映射见 [writer-studio-v2-implementation-map.md](writer-studio-v2-implementation-map.md)，验证记录见 [writer-studio-v2-figma-report.md](../reviews/writer-studio-v2-figma-report.md)。1440 写作页的配色经过逐像素量化比较；其余页面没有像素级验证。

## Writer Studio V2.1「书」页（2026-10-24）

读取方式：Figma Make 导出目录 `/Users/bruce/git/story/Writer Agent UI_UX Design`，导出时间为 2026-10-24 04:14:52。当前连接器仍无法读取 Make 资源正文，因此以作者导出的源码为设计权威。主要核对 `src/components/BookView.tsx`、`src/components/book/Detail.tsx`、`src/components/book/kit.tsx` 和 `docs/design/vnext-handoff.md`。

已同步知识分类侧栏、独立主滚动区、窄屏分类选择、分类专属加载骨架、可读的错误与空状态、实体详情抽屉、时间线、剧情结构、伏笔、创作笔记和变更历史。详情中的角色说法、正文观察与 AI 推测保持可追溯，作者纠正会立即影响分类标签；原文证据只在作者主动打开时读取。实现中没有复制 Make 的演示计时器、技术 ID 或模拟知识。

性能同步包括：分类列表只请求当前分类的有限实体页，打开实体时再请求其有限事实集；切换分类不会下载整部作品知识；搜索有防抖；后台任务只做轻量摘要探测；过期的异步详情响应不能覆盖当前选择。原始 JSON、Zod 错误和 schema 字段不再显示给作者。

验证：Web 单测 169 项、Worker 测试 17 项、Web 类型检查与 lint 通过；真实 Go API + Worker Knowledge E2E 通过。集成测试先等待 Worker 将当前 Revision 写入知识页，再重载界面检查结果，避免把后台轮询间隔误判为页面错误。未执行 Figma 服务端 Make 截图像素差分，因此本次不宣称全页面逐像素一致。

### V2.1 作品菜单增量（2026-10-24）

读取 `src/components/Works.tsx` 的 `WorkMenu` 与 `Shelf` 后，将左上角原生 `<details>` 改为受控 Popover。菜单现按设计稿呈现搜索、当前作品卡、最近编辑、全部作品、新建空白作品与 EPUB 导入；点击透明外部遮罩或按 Escape 会关闭，并把焦点还给触发器。

“全部作品”打开真实作品书架，可直接搜索、切换、重命名与删除。切换、重命名和删除仍经过现有未保存正文守卫、幂等与显式删除确认，没有因菜单改版绕过数据安全。真实 Managed Book 摘要没有字数字段，因此本版只显示实际章节数，不伪造 Figma 演示中的字数与知识同步状态。

验证覆盖菜单结构、搜索、外部关闭、焦点恢复、书架筛选、跨作品重命名与删除，以及 1440px / 390px 菜单边界和不产生横向滚动。仍未执行 Figma Make 服务端截图差分，不能宣称逐像素一致。
