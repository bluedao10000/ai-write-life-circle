# Writer Agent V3 · Figma Make 前端同步报告

- 日期：2026-10-25
- 分支：`v3/figma-sync`（基于 `v3/phase5-tests-docs`，未推送、未合并、未部署）
- 视觉权威：Figma Make 源码 `/Users/bruce/git/story/Writer Agent UI_UX Design`（2026-10-25 02:09 版本，只读，未修改）
- 业务权威：本仓库现有 API、Revision/CAS、自动保存、恢复、IME、Creative Asset / Proposal / ChangeSet、Knowledge、Review
- 未做：eval、付费模型调用、推送、PR（按要求不推送；`gh` 账号当前也不可用）

## 1. 结论

三个主空间（灵感 / 阅读与写作 / 书）的布局骨架已按设计稿实现，业务逻辑和存储未改变。
在 1280 px 及以上的桌面视口，「书」和「待确认」的全部共同地标（标题栏、导航、侧栏、标题、搜索框、命名按钮）与设计稿偏差 ≤ 2 px。
剩余偏差主要来自两类原因：一是真实数据和原型演示数据不同（例如原型有 12 版修订和三段续写摘要）；二是原型自身的移动端溢出问题，本实现没有照搬。
全量地标统计为 301 / 377 在 2 px 以内，本报告不声称 100% 一致。

## 2. 组件映射

| 设计稿（Figma Make） | 本仓库实现 | 数据来源 |
| --- | --- | --- |
| `App.tsx` 顶栏 | `features/vnext/StudioHeader.tsx` | workspace 保存状态、Knowledge summary |
| `App.tsx` 阅读/写作画布、页脚、选区浮条 | `features/workspace/WritingSpace.tsx`、`WritingCanvas.tsx`、`components/ManuscriptEditor.tsx` | TipTap 编辑器（保留），Revision/CAS 保存队列 |
| `Resume.tsx` | `components/vnext/Resume.tsx`（已有） | 当前章节正文尾段、下次要写的笔记、待处理注记 |
| 右侧辅助抽屉 本章设定 / 注记 / 审查 | `WritingSpace` 抽屉 + `creative/WritingContextPanel.tsx`（embedded）+ `reviews/ReviewMarginPanel` + 新 `ReviewTab` | creative context、plan-check、Review API |
| `idea/Inspiration.tsx` | 新 `features/creative/InspirationWorkspace.tsx`（替换 `InspirationOrganizer.tsx`） | `useThinking`（Pi 会话）、`creativeApi` proposals/turns/organize |
| `idea/kit.tsx` | 新 `features/creative/kit.tsx`（StatusTag、OriginTag、DiffView、Facets、Disclosure、EmptyState） | 状态映射 `proposalStatus` / `assetStatus` / `assetOrigin` |
| `idea/Inspiration.tsx` ReviewCard | `features/creative/ProposalCard.tsx` | `CreativeProposal`（CREATE / UPDATE / SUPERSEDE） |
| `BookView.tsx` 导航与分区 | `components/vnext/BookView.tsx`（`BOOK_NAV`、`SourceSwitch`） | creative overview 计数 |
| `BookView.tsx` 人物/世界观/时间线/剧情/伏笔 | `features/creative/AssetLibrary.tsx` | Creative Asset API |
| `idea/AssetDrawer.tsx` | `AssetLibrary.tsx` 内 `AssetDrawer` | asset detail、versions、links、proposals、ManuscriptMatches |
| `BookView.tsx` InboxSection | `ProposalList.tsx`（`inbox` 模式） | 待确认 proposals |
| `Works.tsx` 作品切换 | `features/management/BookMenu.tsx`（触发器样式） | Managed books |
| `ui.tsx` 图标集 | `components/vnext/ui.tsx` `IconName` / `paths` | — |

设计稿中的人物、世界观、时间线、剧情结构、伏笔五类映射到服务端九种 kind：

| 设计分区 | 服务端 kind |
| --- | --- |
| 人物 | `character`、`character_arc` |
| 世界观 | `world_rule`、`place`、`organization` |
| 时间线 | `event` |
| 剧情结构 | `plot_line`、`open_question` |
| 伏笔 | `foreshadowing` |

## 3. 设计 Token

`src/index.css` 的颜色、字号、间距、容器宽度与设计稿一致。逐行 diff 只有以下差异：

- 新增设计稿的 `@keyframes grow`。设计稿组件目前没有使用它，加入是为了保持 token 一致。
- 设计稿把 `--text-hero`、`--container-site`、`--container-read` 写在主 `@theme` 中；本仓库写在后续的 `@theme` 块里，计算值相同。
- 本仓库额外保留公开站点（story2u）样式和 `.manuscript:focus-visible`。正文行高的计算值两边都是 18px / 35.1px。

关键尺寸已实测相同：顶栏 h-12、会话栏 16.5rem、整理面板 23.75rem、抽屉 22.5rem、书导航 w-56、页面最大宽 44rem、阅读宽 40rem。

## 4. 视觉对比方法

- 基线：把设计稿复制到 `/tmp/figma-ref`，`node_modules` 符号链接到 `apps/web/node_modules`，用 vite 在 `127.0.0.1:8443/#/studio` 运行。原始目录未改动。
- 实现：Go API（本地鉴权、fixture 状态目录，模型地址指向不可达端口，因此不会调用模型）加 vite（`VITE_STORY2U_PUBLIC_SITE=true`，`/studio`）。
- 工具：`apps/web/scripts/compare-figma-baseline.mjs`。它用 Playwright 截取 6 个场景 × 5 个视口，生成 baseline、实现、50% overlay 和像素 diff 图（|ΔR|+|ΔG|+|ΔB| > 48 计为不同），并记录同名地标的 DOM bbox。
- 场景：灵感首页、阅读、写作、书·人物、书·人物抽屉、书·待确认。
- 视口：1920×1080、1440×900、1280×800、768×1024、390×844。

像素 diff 主要被内容差异主导：原型是《江宁旧事》演示数据，实现是真实 API 中的《灯塔与潮汐》。因此布局一致性以 bbox 为主要判断依据，像素百分比只作参考。

## 5. 实测结果

| 场景 | 视口 | 像素差异 | 共同地标 ≤ 2 px | 超出 2 px 的地标 |
| --- | --- | --- | --- | --- |
| 灵感 | 1920×1080 | 3.31% | 14/15 | 全部待处理 Tab 宽 −13（原型显示计数「11」） |
| 阅读 | 1920×1080 | 2.75% | 6/11 | 正文 y −409（原型续写卡片有 3 段正文）；写作按钮 x +66（原型保存状态更长，另有「原型」按钮）；页脚按钮 x +12（注记圆点只在有注记时显示） |
| 写作 | 1920×1080 | 2.23% | 6/10 | 正文 y −26（原型章节有一行场景说明「永和三年秋 · 江宁柳巷」）；页脚同上 |
| 书 | 1920×1080 | 1.45% | 16/16 | — |
| 书·抽屉 | 1920×1080 | 3.08% | 16/17 | `main` 宽 +360（抽屉在本实现中位于外层 `main` 内；可见位置一致） |
| 待确认 | 1920×1080 | 2.25% | 10/10 | — |
| 灵感 | 1440×900 | 4.81% | 14/15 | 同 1920 |
| 阅读 | 1440×900 | 3.39% | 6/11 | 同 1920 |
| 写作 | 1440×900 | 3.57% | 6/10 | 同 1920；正文高度随内容不同 |
| 书 | 1440×900 | 2.32% | 16/16 | — |
| 书·抽屉 | 1440×900 | 4.48% | 16/17 | 同 1920 |
| 待确认 | 1440×900 | 3.05% | 10/10 | — |
| 灵感 | 1280×800 | 5.68% | 14/15 | 同 1920 |
| 阅读 | 1280×800 | 3.90% | 6/11 | 同 1920 |
| 写作 | 1280×800 | 4.52% | 6/10 | 同 1920 |
| 书 | 1280×800 | 2.93% | 16/16 | — |
| 书·抽屉 | 1280×800 | 5.34% | 16/17 | 同 1920 |
| 待确认 | 1280×800 | 3.52% | 10/10 | — |
| 灵感 | 768×1024 | 6.09% | 9/9 | — |
| 阅读 | 768×1024 | 6.66% | 6/11 | 同 1920 |
| 写作 | 768×1024 | 5.78% | 6/10 | 同 1920 |
| 书 | 768×1024 | 3.59% | 16/16 | — |
| 书·抽屉 | 768×1024 | 6.01% | 17/17 | — |
| 待确认 | 768×1024 | 6.11% | 9/10 | 搜索框 y −20（原型说明文字更长，折成两行） |
| 灵感 | 390×844 | 9.93% | 5/9 | 主导航 x +5、宽 +22 |
| 阅读 | 390×844 | 11.15% | 2/11 | 主导航 x +15～33 |
| 写作 | 390×844 | 12.72% | 2/10 | 同上；原型写作态滚动到正文末尾 |
| 书 | 390×844 | 7.15% | 10/14 | 主导航 x +5、宽 +22 |
| 书·抽屉 | 390×844 | 8.29% | 11/15 | 同上 |
| 待确认 | 390×844 | 8.63% | 4/8 | 同上 |

关于 390 px 的偏差：原型在 390 px 下顶栏溢出。它显示 `story2u` 链接，原因是 `hidden md:inline-flex` 被按钮自身的 `inline-flex` 覆盖；主导航因此被挤成「灵 / 感」两行，右侧「原型」按钮被裁掉。本实现按原型类名所表达的意图修正了这几处：用 `max-md:hidden` 隐藏 `story2u`，主导航不换行，移动端只显示作品封面字。实测 `scrollWidth` 在 390 和 768 都等于视口宽度，顶栏最右按钮在 390 px 时 right = 382.6。

## 6. 对比过程中修正的问题

- **书的标题区**：来源切换（作者设定 / 正文观察 · AI）从标题下方移到面包屑行右侧，占用原型「知识维护」按钮的位置。标题 y 从 +40 降到 0。
- **书·人物**：增加「档案 / 关系 · N」切换。关系来自资产之间的真实 link。只有一种 kind 时不再显示分组标题。
- **人物抽屉**：操作按钮移到底部，并加上设计稿的说明文字；「版本历史」改名为「变更记录」，与设计稿一致。
- **待确认**：增加搜索、说明横幅，以及「存在冲突 / 修改草案 / 新的候选」三组；空状态改用设计稿的 EmptyState。
- **灵感左栏**：刷新按钮不再撑高第一行（原来偏差 8 px）。快捷键提示改为「Enter 或 ⌘ Enter 发送」，这与实际行为一致。
- **专注模式**：只在写作中生效，进入写作时重置。原来布局中持久化的 `focus: true` 会在阅读态隐藏「继续写作」卡片。
- **保存状态**：在 < 640 px 时隐藏（与原型一致）。原实现中 `hidden` 被 `inline-flex` 覆盖，导致移动端仍显示。
- **页脚**：「注记」在有注记时显示圆点。字数改为独立元素，供读屏器和测试读取。
- **DiffView**：恢复 `<del>` / `<ins>` 语义，视觉样式仍按设计稿。
- **用户主动取消**：主动取消的回复不再显示错误提示。
- **离线历史**：会话快照读取失败时，仍可以在标题栏删除该会话，与改版前的「离线仍可删除」保持一致。

## 7. 未解决的差异（如实列出）

1. **保存状态文案**：设计稿是「已保存 · 第 12 版 · 20 小时前」，本实现是「已保存 HH:MM」。API 的 revisionId 是不透明字符串，没有递增版本号。
2. **续写卡片**：缺少「· 20 小时前」，因为前端没有可靠的「上次编辑时间」。只在当前会话中保存时才有时间。
3. **灵感左栏**：没有「未完成的构思」分组（需要服务端标记未决会话）。灵感首页没有「还没想清楚的」列表，也没有「想一想」问题，后端没有对应数据。
4. **会话视图**：本地对比环境中思考服务离线，所以没有与设计稿逐像素对比会话视图。会话界面通过 thinking funnel 全链路测试截图（`apps/web/test-results-thinking/thinking-desktop.png`）人工检查，没有 bbox 数据。
5. **工具时间线**：只在回复进行中显示，完成后只保留「原文引用」折叠区。改版前完成后仍可展开工具步骤；设计稿完成态没有该区域，这里按设计稿处理。
6. **人物卡片**：设计稿把「性格 / 欲望 / 动机」做成固定栏位，本实现显示作者自由填写的字段（最多 3 个），因为资产字段是作者自定义的。
7. **原型专用控件**：「原型」菜单、「模拟」开关、知识维护「模拟」状态是原型专用，没有实现。
8. **额外控件**：写作态顶栏多了「打字机模式」和「历史版本」（已有功能，保留）。

## 8. 需要作者确认的产品决定

- **「审查」抽屉 Tab**：V2 时作者决定（2026-10-22）不加「审查」Tab；V3 设计稿有这个 Tab。本分支按设计稿加上了，内容是已有的、经同意的证据审查流程。原页脚的「审查本章」按钮已移除，审查入口在抽屉的「注记 / 审查」中。如果要坚持 V2 的决定，只需去掉这一个 Tab。
- **专注模式**：改为不持久化（设计稿行为）。
- **移动端顶栏**：按第 5 节修正后与原型不同。

## 9. 兼容性

- **未改动**：API、Go 代码、契约包、存储格式和迁移。TipTap、Revision/CAS、自动保存、本地草稿恢复、冲突处理、只读保护、IME（`isComposing`）逻辑都没有改。
- **入口变化**：`openThink` 在 API 模式下跳到「灵感」空间并带上引用，不再打开抽屉内的灵感 Tab；演示模式保留抽屉灵感 Tab。
- **「书」默认分区**：改为「人物 · 作者设定」。旧的 `chapter` 分区仍可从顶栏知识按钮进入。
- **按钮文案变化**（影响自动化脚本）：

| 原文案 | 新文案 |
| --- | --- |
| 进入创作 / 完成创作 | 写作 / 阅读 |
| 接受 / 拒绝 / 接受所选 / 编辑后接受 / 保存并接受 | 确认 / 否决 / 确认所选 / 编辑 / 保存并确认 |
| 人物设定 / 新建人物 | 人物 / 添加人物 |
| 剧情规划中的事件 | 时间线 |
| 发送问题 / 取消思考 / 历史思考会话（下拉框） | 发送 / 停止 / 创作探索记录（列表） |

## 10. 测试

全部在本地运行，没有调用付费模型：

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 error；1 个 `App.tsx` 中原有的 warning |
| `apps/web` vitest | 24 个文件，181 个测试通过 |
| `pnpm --filter @writer-agent/web build` | 通过 |
| `node e2e/run-api-e2e.mjs` | 2 通过 |
| `node e2e/run-review-e2e.mjs` | 3 通过 |
| `node e2e/run-management-e2e.mjs` | 13 通过（含 390 px 菜单不越界） |
| `node e2e/run-creative-e2e.mjs` | 1 通过 |
| `playwright.config.ts`（visual） | 9 通过 |
| `playwright.knowledge.config.ts` | 连续 3 次通过 |
| `node scripts/test-thinking-funnel.mjs` | PASS（Worker/D1 → Go → Pi fixture） |
| `node scripts/test-creative-workflow.mjs` | ok |
| `go test -race ./...` | 通过 |

测试改动及原因：

- **单元测试**（`App.test.tsx`、`bookView.test.tsx`、`creative.test.tsx`）：只改文案和定位方式；断言的行为不变。
- **`creative.integration.spec.ts`**：事件资产改到「时间线」分区创建；页脚「本次 +N」替代原工具栏断言。
- **`api.integration.spec.ts`**：知识维护提示改为在「正文观察 · AI」下检查；灵感区地标改为 `main「灵感对话」`。
- **`review.integration.spec.ts`**：先打开「注记」抽屉，再点「审查本章」。
- **`workbench.visual.spec.ts`**：专注模式改为断言主导航透明度为 0（设计稿行为是淡出而不是移除）；390 px 下没有专注按钮，跳过该步；「灵感」按钮改为「去灵感」。
- **`knowledge.integration.spec.ts`**：
  - 改为通过顶栏知识按钮进入本章知识，并展开「原文依据」。
  - 新增一步：等待 `lastChapterId` 持久化后再刷新页面。
  - 背景：在 `v3/phase5-tests-docs` 的基线上，原断言之所以通过，是因为刷新期间仍显示上一分区（本章相关）的旧内容，而不是人物分区本身包含第 2 章文字。
- **`test-thinking-funnel.mjs`**：改为驱动新的灵感空间。完成判断加强为「轮数 +2 且最后一条没有进行中或失败状态」。

## 11. 变更文件

新增：

- `apps/web/src/features/creative/InspirationWorkspace.tsx`
- `apps/web/src/features/creative/kit.tsx`
- `apps/web/scripts/compare-figma-baseline.mjs`
- `harness/design/figma-v3-sync-report.md`

删除：

- `apps/web/src/features/creative/InspirationOrganizer.tsx`

修改：

- `apps/web/src/components/ManuscriptEditor.tsx`：选区坐标回调
- `apps/web/src/components/vnext/BookView.tsx`：导航分组、来源切换、计数
- `apps/web/src/components/vnext/ui.tsx`：设计稿图标集；Seg 不换行，移动端内边距
- `apps/web/src/features/creative/AssetEditor.tsx`、`AssetLibrary.tsx`、`ProposalCard.tsx`、`ProposalList.tsx`、`WritingContextPanel.tsx`
- `apps/web/src/features/knowledge/BookSpace.tsx`、`KnowledgePanel.tsx`
- `apps/web/src/features/management/BookMenu.tsx`：触发器样式
- `apps/web/src/features/thinking/ToolTimeline.tsx`：创作工具名称
- `apps/web/src/features/vnext/StudioHeader.tsx`、`ThinkingPage.tsx`、`useStudioController.ts`
- `apps/web/src/features/workspace/ComposeBar.tsx`（只保留 RevisionHistory）、`WritingCanvas.tsx`、`WritingSpace.tsx`
- `apps/web/src/styles/index.css`：`@keyframes grow`
- 测试：`apps/web/src/test/{App,bookView,creative}.test.tsx`
- e2e：`apps/web/e2e/api.integration.spec.ts`、`creative.integration.spec.ts`、`knowledge.integration.spec.ts`、`review.integration.spec.ts`、`workbench.visual.spec.ts`
- 脚本：`apps/web/scripts/test-thinking-funnel.mjs`

## 12. 复现

1. 复制设计稿到临时目录，例如 `/tmp/figma-ref`，并把 `node_modules` 链接到 `apps/web/node_modules`。
2. 启动设计稿：`FIGMA_DEV_SERVER_HOST=127.0.0.1 PORT=8443 vite`。
3. 启动本地 Go API：指定 fixture 状态目录，`WRITER_AGENT_LLM_BASE_URL` 指向不可达地址，避免调用模型。
4. 启动本仓库 web：`VITE_WRITER_AGENT_MODE=api VITE_STORY2U_PUBLIC_SITE=true pnpm exec vite --port 5199`，并通过 creative API 写入示例资产。
5. 运行对比：`cd apps/web && OUT=test-results-figma node scripts/compare-figma-baseline.mjs`。
