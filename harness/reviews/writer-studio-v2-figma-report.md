# Writer Studio V2 · Figma 同步报告

日期：2026-10-23。分支 `codex/writer-studio-v2-figma-sync`，基于 `origin/main` `633c295`。设计到代码的映射见 [writer-studio-v2-implementation-map.md](../design/writer-studio-v2-implementation-map.md)。

## 1. Figma Make URL

[Writer Agent UI/UX Design](https://www.figma.com/make/kWBOdcae5utBZ6VtBHHXui/Writer-Agent-UI-UX-Design)，fileKey `kWBOdcae5utBZ6VtBHHXui`，node `0:1`。

## 2. 是否通过 MCP 获取了真实设计

部分获取。

- `get_design_context(0:1)` 成功，返回了 Make 项目全部源文件和图片资源的 MCP Resource 清单。
- 当前客户端没有读取 MCP Resource 内容的工具。`get_screenshot`、`get_metadata`、`get_variable_defs`、`download_assets` 都不支持 Make 文件。
- 实际读取的是作者从 Make 导出的源码目录 `/Users/bruce/git/story/Writer Agent UI_UX Design`。它的文件清单与 MCP 返回的一致，但无法通过 MCP 交叉校验它是否与云端最新版逐字相同。
- 没有提供对应的 Figma Design 文件，因此没有 Design Node，也没有 Figma 服务端截图或变量。

## 3. 读取的 Make 文件与 Figma Node

- Node：仅 Make 根节点 `0:1`。
- 源文件：`src/index.css`、`src/components/ui.tsx`、`Agents.tsx`、`Works.tsx`、`Safety.tsx`、`ThinkingSession.tsx`、`MarginPanel.tsx`、`BookView.tsx`、`ChapterDrawer.tsx`、`Resume.tsx`、`QuickNote.tsx`、`ManuscriptEditor.tsx`、`StoryConflictView.tsx`、`src/App.tsx`、`src/Root.tsx`、`src/vnext/*`、`docs/design/vnext-handoff.md`。
- `src/site/*` 只做了差异统计，按决定留给单独的 PR。

## 4. 更新的页面

| 区域 | 内容 |
|---|---|
| 全局 | V2 Design Tokens，Light/Dark |
| 写作 · 顶栏 | 作品菜单（封面字、V2 弹层）、知识状态芯片、保存状态图标、保存失败横幅 |
| 写作 · 续写卡 | "上次停在第 N 章「标题」" |
| 写作 · 随手记 | 选中原文的引文条，Esc 提示 |
| 书 · 知识维护 | 状态卡、真实进度条与"N / M 章"、授权卡 |
| 连续性审查 | 授权弹窗、排队与执行卡片、失败与过期提示 |
| 思考 | 授权卡、工具时间线 |
| EPUB 导入 | 上传区、解析中进度、统计卡、警告块、目录预览 |

## 5. Design Token 变化

在 `apps/web/src/styles/index.css` 中保留全部 token 名，只改值并新增：

- 配色：暖纸画布、冷灰墨色、石板蓝品牌色。例如 `--accent` `#3f4fbf` → `#596b91`，`--ink` `#23211d` → `#22252a`，深色 `--bg` `#171614` → `#141517`。
- 字体：UI 改为 Inter 优先，其后是 PingFang SC 和 Noto Sans SC。
- 正文行高 1.9 → 1.95。
- 新增：`--shadow-sm` / `shadow-raise`、`text-h2`（20/30）、`text-h3`（17/26）、`container-toc` / `aside` / `prose` / `sessions`、`.font-mono-num`、`.tip`、`.bar-indeterminate`、`.spin`、`.studio-prose`、`.meter`。
- 仓库独有的 `.site-markdown` 和 `.authenticated-workspace` 规则保持不变。

## 6. 复用的组件

`Btn`、`IconBtn`、`Dialog`、`Dot`、`Icon`、`Heading`、`TextInput`、`Seg`、`MarginPanel`、`SaveConflictDialog`（已与 Make 一致，未改）、`KnowledgePanel`、`ThinkingPanel`、`ReviewMarginPanel`、`ReviewConsentDialog`、`BookMenu`、`EPUBImportDialog`、`Resume`、`QuickNote`。

基础组件的扩展：`Btn` 新增 `accent`、`danger-outline` 变体和 `lg` 尺寸；`IconBtn` 新增 `size`；`Dialog` 新增 `size` 和 `footnote`；新增图标 `tool`、`shield`、`upload`、`file`、`info`、`clock`，路径取自 Make。

## 7. 新增的组件

- `features/knowledge/KnowledgeStatus.tsx`：知识状态卡与 `backfillProgress()`。
- `features/knowledge/KnowledgeChip.tsx` 与 `useKnowledgeSummary.ts`：顶栏芯片。只在有任务时轮询，页面隐藏时停止。
- `features/thinking/ToolTimeline.tsx` 与 `toolActivity.ts`：工具时间线。
- `components/vnext/ConsentFacts.tsx`：三处授权共用的展示组件。

没有引入新的 UI 框架或依赖。

## 8. 业务 Hook 是否保留

全部保留：`useStudioController`、`useWorkspaceController`、`useReviewController`、`useThinking`、`useNotes`、`useManagement`。`useThinking` 只新增了 `steps` 状态；切换会话和新一轮提问被接受时会清空它，失败重试时保留。

## 9–11. Go API 修改与契约同步

改动的是知识 `view`，新增 `completed`（最新任务已完成的章节数）和 `chapterTotal`（有正文、可分析的章节数）。

修改原因：作者确认需要百分比进度。原有 API 只返回 `pending`、`running`、`failed` 三个计数，无法得出进度。

实现：

- `chapterTotal` 由 `sync()` 写入 `State`，只在数值变化时写盘。如果每次读取都重算并写回，会额外递增 `Version`，作者的变更请求会因此出现多余的 409。
- `view()` 中 `completed` 不会超过 `chapterTotal`。
- 修改已完成的章节后，旧任务变为 `superseded`，进度相应回落。

契约已同步：`packages/contracts/src/knowledge.ts` 中两个字段都是 `optional`，`harness/contracts/knowledge-api-v1.json` 已重新生成。`openapi:check` 和 `openapi:lint` 通过。

部署注意：`memoryViewSchema` 是 `.strict()`，旧前端不认识新字段，会解析失败。必须先部署前端，再部署 API。新前端在旧 API 上不显示进度，也不会虚构数字。

测试：`TestViewReportsBackfillProgressFromAnalysableChapters` 覆盖空章不计入分母、逐步完成和编辑后回落。

没有修改 `apps/agent/`，没有修改 Worker 协议，没有修改 Go/Pi 任务归属、租约或模型配置。

## 12. Thinking / Review / Knowledge 是否接入真实数据

是。

- 知识芯片和进度来自 `GET /knowledge/jobs` 返回的 `view`。
- 工具时间线只由真实的 `tool_started` 和 `tool_completed` 事件生成。Make 中固定 4 步的计时器动画没有采用。
- 审查仍走 `ReviewPlanHash` 授权、证据校验、Revision 新鲜度、反馈、取消和排队。Make 中的计时器模拟只借鉴了视觉。
- 审查入口按决定保留在底部"审查本章"按钮，右抽屉仍是"注记 / 思考"两项。

## 13. Demo / API 是否严格隔离

是。知识芯片只在 API 模式且有托管作品时挂载，请求失败时直接不显示，不会降级到 Mock。没有新增任何 Mock 数据。Make 的原型菜单（`ProtoMenu`）和设计规范页（`SpecView`）没有进入生产代码。

## 14. 完成了哪些视觉对比

方法：在本地运行导出的 Make 源码（端口 5401）和本分支的 Demo 模式（端口 5402），用 Playwright 在相同视口下截图，并在 Chromium canvas 中逐像素比较。

- 1440×900 写作页，Light 和 Dark：页面底色、主按钮、冲突色点、顶栏底色的取色与 Make 完全一致（例如 Light `#fdfcfa` / `#22252a` / `#b05a4e`，Dark `#18191c` / `#e4e1da` / `#e0998e`）。正文列像素差异：Light 0.23%，Dark 0.22%，差异来自 Demo 文案措辞。
- 横向溢出：1440、1280、768、390 四个视口 × Light/Dark × 写作/书/思考，共 24 种状态，均无横向滚动。
- 1280、768、390 三个视口已截图，但没有做逐像素比较。

## 15. 没有完成的视觉对比

- 书、思考、知识维护卡、审查面板、授权弹窗、EPUB 对话框、作品菜单：没有与 Make 的对应状态截图比较。原因是 Make 中这些状态需要通过原型菜单触发，而仓库里这些界面在 API 模式下才出现。
- API 模式的界面没有截图。
- 没有 Figma Design 文件，无法做 Figma 服务端像素 diff。

因此不能宣称全应用达到像素级还原，只有上述 1440 写作页的配色和布局经过了量化验证。

## 16. 通过的交互测试

在 rebase 后的最终代码上运行：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 error，1 个 warning，`main` 上原本就有 |
| `pnpm openapi:check` / `openapi:lint` | 通过 |
| `pnpm build` | 通过 |
| `pnpm test` | 通过：前端 156 个、Worker 16 个、Go `-race` 全部包，以及 9 个集成脚本（Review、Knowledge、Thinking、Pi Worker、EPUB 10/100/500 章等） |
| `pnpm test:e2e` | 通过：7 组 Playwright 共 28 个用例，加上 Thinking 漏斗 |

新增测试共 25 个：`knowledgeStatus`（9）、`knowledgeChip`（8）、`toolActivity`（7），以及 Go 的 1 个。没有删除或放宽任何已有测试。

开发过程中，EPUB 单测发现新的章节序号把 "1." 改成 "1"，与统计卡 "2" 冲突导致查询到多个元素。已经恢复为 "1." 修复，没有改动测试。

## 17. 暂不支持的设计功能

- 回填范围"全部 / 最近 30 章"，以及"预计 N 分钟 / Nk tokens"：后端没有对应参数和估算。
- 删除作品时输入书名确认：会改变现有删除流程和测试，没有做。
- 模型变更后的"重新确认"提示：只有知识维护已有 `needsModelConsent` 信号，审查和思考没有对应的后端信号。
- 书架网格（`Shelf`）和空书架页面：作品菜单内的列表已可切换，没有新增网格视图。
- 公开站点与发布页（`src/site/*`）：按决定拆到单独的 PR。

## 18. 影响已有功能的风险

- 部署顺序，见 §9–11。
- UI 字体改为 Inter 优先后，西文和数字的宽度会变化。中文仍回落到 PingFang SC 和 Noto Sans SC。
- `KnowledgeChip` 每个作品会多一次 `/knowledge/jobs` 请求。有任务时每 8 秒轮询一次，页面隐藏时停止。

## 19. 是否调用了付费模型

没有。所有知识、审查和思考测试都使用仓库现有的 HTTP fixture。

## 20. PR 地址

见 PR 描述。PR 保持 Open，不自动合并，不部署。
