# Writer Studio V2 设计与代码映射表

读取日期：2026-10-22。分支 `codex/writer-studio-v2-figma-sync`，基于 `origin/main` `6b663a3`。

## 1. 设计来源与读取方式

| 项 | 内容 |
|---|---|
| Figma Make | [Writer Agent UI/UX Design](https://www.figma.com/make/kWBOdcae5utBZ6VtBHHXui/Writer-Agent-UI-UX-Design)，fileKey `kWBOdcae5utBZ6VtBHHXui`，node `0:1` |
| MCP 访问 | `get_design_context(0:1)` 成功，返回 Make 项目全部源文件与图片资源的 MCP Resource 清单 |
| MCP 限制 | 当前客户端没有读取 MCP Resource 内容的工具。`get_screenshot`、`get_metadata`、`get_variable_defs`、`download_assets` 均不支持 Make 文件 |
| 实际读取的源码 | 作者导出的 Make 源码目录 `/Users/bruce/git/story/Writer Agent UI_UX Design`（文件清单与 MCP 返回一致，共 63 个源文件） |
| 对应 Figma Design 文件 | 未提供，因此没有 Design Node ID，也没有 Figma 服务端截图 |

Make 内的 `docs/` 仍是 VNext 阶段的交接文档，未更新到 V2。V2 的范围只以源码为准。

## 2. 差异方法

仓库前端是 prettier 风格，Make 是紧凑写法，行 diff 无意义。比较时忽略空白、逗号、括号，按 token 做序列比对，`Make 独有` 表示设计新增量。

| Make 文件 | 仓库对应 | Make 独有 token | 判断 |
|---|---|---:|---|
| `components/StoryConflictView.tsx` | `components/vnext/StoryConflictView.tsx` | 0 | 已一致 |
| `components/BookView.tsx` | `components/vnext/BookView.tsx` | 2 | 已一致 |
| `components/ChapterDrawer.tsx` | `components/vnext/ChapterDrawer.tsx` | 2 | 已一致 |
| `components/MarginPanel.tsx` | `components/vnext/MarginPanel.tsx` | 2 | 已一致 |
| `vnext/model.ts` | `features/vnext/model.ts` | 0 | 已一致 |
| `components/Resume.tsx` | `components/vnext/Resume.tsx` | 19 | 微调 |
| `components/QuickNote.tsx` | `features/notes/QuickNote.tsx` | 110 | 引文条，微调 |
| `components/ManuscriptEditor.tsx` | `components/ManuscriptEditor.tsx` | 293 | 实现细节为主 |
| `components/ThinkingSession.tsx` | `components/vnext/ThinkingSession.tsx` | 567 | 工具时间线、停止/重试、授权门 |
| `components/ui.tsx` | `components/vnext/ui.tsx` | 2287 | 新变体与新图标 |
| `index.css` | `styles/index.css` | 见 §3 | 配色、字体、宽度全面更新 |
| `components/Works.tsx` | 无 | 全新 | 多作品、EPUB |
| `components/Agents.tsx` | 无 | 全新 | 授权、知识维护、审查、工具时间线 |
| `components/Safety.tsx` | 部分在 `workspace/SaveConflictDialog.tsx` | 全新 | SaveStatus、Banner |
| `components/ProtoMenu.tsx` | 无 | 全新 | 仅原型控制，不进生产 |
| `components/SpecView.tsx` | 无 | 全新 | 仅开发预览，不进生产 |
| `site/Publish.tsx` | `site/Publish.tsx` | 4120 | 重构 |
| `site/kit.tsx` | `site/kit.tsx` | 847 | 公开站点组件 |
| `site/Discover.tsx` | `site/Discover.tsx` | 743 | 分类筛选 |
| `site/Reader.tsx` | `site/Reader.tsx` | 319 | 阅读器 |
| `site/Book.tsx` / `Home.tsx` | 同名 | 139 / 96 | 微调 |

## 3. Design Token 变化（`src/index.css`）

V2 的 token 名与 VNext 相同，值全部更新。改动集中在 `apps/web/src/styles/index.css`。

| 类别 | VNext（当前仓库） | V2（Make） |
|---|---|---|
| 色调 | 暖纸色画布，靛蓝品牌色 | 暖纸画布 + 冷灰墨色 + 石板蓝品牌色 |
| `--bg` / `--paper` | `#f6f4ef` / `#fbfaf7` | `#f8f7f4` / `#fdfcfa` |
| `--ink` | `#23211d` | `#22252a` |
| `--accent` | `#3f4fbf` | `#596b91` |
| `--ai` | `#6e539c` | `#5a5fa6` |
| `--conflict` | `#a8561c` | `#b05a4e` |
| 深色 `--bg` | `#171614` | `#141517`（冷灰，非暖棕） |
| UI 字体 | Noto Sans SC 优先 | Inter 优先，其后 PingFang SC、Noto Sans SC |
| 正文行高 | 1.9 | 1.95 |
| 新增 token | 无 | `--shadow-sm`、`--shadow-raise`、`--text-h2`(20/30)、`--text-h3`(17/26)、`--container-toc`(15.5rem)、`--container-aside`(23.75rem)、`--container-prose`(42.5rem)、`--container-sessions`(16.5rem) |
| 新增工具类 | 无 | `.font-mono-num`、`.tip`/`data-tip`、`.bar-indeterminate`、`.spin`、`.studio-prose`、`.meter` |

不引入的内容：Make 的 `@theme { --container-site; --text-hero }` 已在仓库中，保持不动。仓库独有的 `.site-markdown` 与 `.authenticated-workspace` 规则必须保留。

## 4. 页面映射

标记说明：S = 仅样式；L = 布局与交互；R = 组件重构；W = 前端 API 接线；C = API 契约扩展；G = Go 后端；F = 暂不支持。

| 设计页面 | Figma 来源 | 现有 React 组件 | 业务数据 | 所需工作 | 备注 |
|---|---|---|---|---|---|
| Design Tokens | `src/index.css` | `styles/index.css` | 无 | S | §3 |
| 基础组件 | `components/ui.tsx` | `components/vnext/ui.tsx` | 无 | S + R | 新增 `accent`、`danger-outline` 变体，`lg` 尺寸，`IconBtn size`，`Dialog size/footnote`，`Choice`，新图标。保持现有导出 `buttonClassName`、`TextArea disabled/maxLength` |
| 写作 · 稿纸 | `components/ManuscriptEditor.tsx`、`App.tsx` | `workspace/WritingCanvas.tsx`、`components/ManuscriptEditor.tsx` | Chapter Revision | S | 继续使用 TipTap 与 Markdown 管线 |
| 写作 · 顶栏 | `App.tsx` header | `vnext/StudioHeader.tsx` | 保存状态、作品 | L | 新增知识 Chip，发布按钮已有 |
| 写作 · 保存状态 | `components/Safety.tsx` | `StudioHeader.tsx`、`workspace/SaveConflictDialog.tsx` | SaveState | R | 抽出 `SaveStatus`、`Banner` 展示组件，状态来源不变 |
| 写作 · 右抽屉 | `App.tsx` drawerRight | `workspace/WritingSpace.tsx` | Review、Thinking | L | **见 §5-A**：Make 为 注记/审查/思考 三 Tab，仓库为 注记/思考 |
| 写作 · 注记 | `components/MarginPanel.tsx` | `components/vnext/MarginPanel.tsx`、`reviews/ReviewMarginPanel.tsx` | Review 结果 | S | 设计已一致 |
| 写作 · 续写开场 | `components/Resume.tsx` | `components/vnext/Resume.tsx` | Notes | S | |
| 写作 · 随手记 | `components/QuickNote.tsx` | `notes/QuickNote.tsx` | Notes API | S | 引文条样式 |
| 写作 · 冲突对照 | `components/StoryConflictView.tsx` | `components/vnext/StoryConflictView.tsx` | Demo 专有 | 无 | 已一致 |
| 书 | `components/BookView.tsx` | `knowledge/BookSpace.tsx`、`KnowledgePanel.tsx`、`vnext/BookView.tsx` | Knowledge API | S | 设计已一致 |
| 知识维护 | `components/Agents.tsx` `KnowledgeSheet`、`KnowledgeChip` | `knowledge/KnowledgePanel.tsx` | Knowledge View/Jobs | R + W | **见 §5-B**：进度百分比无真实数据 |
| 模型授权 | `components/Agents.tsx` `ConsentDialog` | `reviews/ReviewConsentDialog.tsx`，Knowledge/Thinking 内授权 | settings.consent、model | R | 抽出统一展示，授权语义不变 |
| 连续性审查 | `components/Agents.tsx` `ReviewPanel` | `reviews/ReviewMarginPanel.tsx`、`useReviewController.ts` | Review API | L | **见 §5-A**：Make 是计时器模拟，只借鉴视觉 |
| 思考 · 会话 | `components/ThinkingSession.tsx` | `thinking/ThinkingPanel.tsx`、`useThinking.ts`、`vnext/ThinkingPage.tsx` | Thinking API | R + W | 工具时间线需对接真实事件 |
| 思考 · 工具时间线 | `components/Agents.tsx` `ToolTimeline` | 无 | Thinking 流式事件 | W | **见 §5-C** |
| 作品菜单 | `components/Works.tsx` `WorkMenu` | `management/BookMenu.tsx` | Management API | R + W | |
| 书架 / 新建 / 重命名 / 删除 | `components/Works.tsx` | `management/BookMenu.tsx`、`ManagedStudio.tsx` | Management API | R + W | 删除需输入作品名确认，当前是否一致需核对 |
| 空书架 | `components/Works.tsx` `NoWorks` | `ManagedStudio.tsx` | | L | |
| EPUB 导入 | `components/Works.tsx` `ImportPage` | `management/EPUBImportDialog.tsx` | Import API | R + W | **见 §5-D**：Make 是独立页面，仓库是对话框 |
| 公开站点 | `site/*` | `site/*` | Public API | S + L | 差异大，**单独阶段，见 §6** |
| 发布 | `site/Publish.tsx` | `site/Publish.tsx` | Publication API | R | 差异最大（4120 token） |
| 原型控制 | `components/ProtoMenu.tsx` | 无 | 无 | F | 不进生产。仅 Demo 模式可保留 |
| 设计规范页 | `components/SpecView.tsx` | 无 | 无 | F | 不进生产 |

## 5. 设计与业务冲突，需要决策或限定

### A. 右抽屉增加「审查」Tab 与计时器模拟

Make 把右抽屉改为 注记 / 审查 / 思考 三项，审查面板用 `setTimeout` 模拟排队与四个步骤，结果 `found` 由前端传入。

处理方式：
- 保留仓库真实 Review 流程：`ReviewConsentDialog`、`ReviewPlanHash`、证据校验、Revision 新鲜度、反馈、取消、排队与幂等。
- 视觉上采纳 Make 的排队/执行步骤、取消按钮、"正文已在审查后修改"提示。步骤文案只用真实任务状态驱动，不显示虚构步骤。
- **作者决定（2026-10-22）**：不新增「审查」Tab，入口继续放在底部「审查本章」按钮。

### B. 知识维护进度没有真实数据

Make 展示"已处理 N / M 章"与百分比。真实 `memoryView` 仅有 `pending`、`running`、`failed` 三个计数，`workerStatus`、`dailyTokenBudget`、`budgetTokens`，以及分页的逐章 `jobs`。没有已完成总数。

处理方式：
- **作者决定（2026-10-22）**：需要百分比。Go 知识 `view` 新增 `completed` 与 `chapterTotal`，契约与 OpenAPI 同步，见报告 §9–11。
- Make 的"回填范围：全部 / 最近 30 章"和"预计 N 分钟 / Nk tokens"在后端没有对应参数与估算，同样标 F。

### C. 思考工具时间线

Make 的 `ToolTimeline` 是 4 个固定步骤的计时器动画。仓库 Thinking 有真实 Tool Activity 与流式事件。时间线只渲染真实事件，不渲染固定的 4 步。

### D. EPUB 导入页面形态

Make 把导入做成独立页面 `#/studio/import`，含 4 个示例文件。仓库是 `EPUBImportDialog`，走真实上传、解析、章节预览、确认导入，具有原子持久化与幂等保障。

处理方式：保留对话框承载的业务流程与状态机，调整视觉与布局到 Make 的分步样式（解析中进度、警告块、章节预览、统计卡）。示例文件选择器不进入 API 模式。

**作者决定（2026-10-22）**：保留对话框，不改为独立路由。

### E. 原型标记与 Demo 隔离

Make 到处是 `Proto` 标记，说明"模拟/不发起请求"。仓库规则：
- Demo 模式继续展示 `Proto` 标记与模拟数据。
- API 模式不出现模拟数据。API 失败显示真实错误与重试入口，不降级为 Mock。

## 6. 范围分期

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | Tokens、基础组件 | 完成 |
| 2 | 写作工作区、顶栏、保存状态 | 完成 |
| 3 | 知识维护、授权、审查、思考 | 完成 |
| 4 | 作品菜单、EPUB 导入 | 完成 |
| 5 | 公开站点与发布 | **作者决定**：拆到单独的 PR，本 PR 不包含 |

交付结果、测试记录与未完成项见 [writer-studio-v2-figma-report.md](../reviews/writer-studio-v2-figma-report.md)。

## 7. 无法验证项

- 没有 Figma Design 文件，所有视觉对比只能对照 Make 本地预览，不能做 Figma 服务端像素 diff。
- 当前 MCP 客户端不能读取 Make 资源内容，只能依赖导出的源码。导出源码是否与云端最新版一致，无法通过 MCP 交叉校验。
