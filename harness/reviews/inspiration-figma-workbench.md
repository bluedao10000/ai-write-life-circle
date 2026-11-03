# 灵感会话工作台：Figma Make 集成与 Agent 收尾修订

日期：2026-11-01。分支：`codex/inspiration-figma-workbench`（基于 `99cf1bd`）。范围：只改灵感会话及其共用壳层，没有改阅读、写作或书籍管理的视觉；没有变更 API 契约；没有部署。

设计源：`Writer Agent UI_UX Design/src/components/idea/{Inspiration,Chat,History,kit}.tsx` 与 `src/index.css`（只读，原目录未改动）。

## 组件映射

| Figma Make | 生产实现 | 集成方式 |
| --- | --- | --- |
| `idea/Inspiration.tsx` 工作台（历史 · 760px 对话 · 底部输入） | `features/creative/InspirationWorkspace.tsx` | 按 Figma 重写界面；数据全部来自 `useThinking`、creative API 和 notes API |
| 落地页「每一个故事，都始于一个问题。」+ 稿纸 + 起步建议 | 同上 `landingView` | 起步建议只填入输入框；用 View Transition 把输入框移到底部 |
| `Chat.tsx` `Composer` | `features/inspiration/Composer.tsx` | 复用 `useThinking.send`；发送中只锁定输入，失败时草稿仍在 |
| `Chat.tsx` `ModelPicker`（桌面浮层 / 移动端底部弹层） | `ModelPicker` | 列表来自 `/thinking/models`，只提交 `modelId`；写明真实托管方，不可用的模型不能选 |
| `Chat.tsx` `Rich` / `AiMsg` / `AuthorMsg` | `features/inspiration/Messages.tsx` | 用 react-markdown 渲染模型输出，沿用 Figma 排版（`.chat-rich`），不渲染原始 HTML；原文引用按已核验来源编号 |
| `Chat.tsx` `Pending` / `Failed` | `Pending` / `Failure` | 生成状态只反映真实事件（思考、工具、上下文整理）；失败按 run.failure 给出能做的恢复 |
| `History.tsx` | `features/inspiration/History.tsx` | 数据来自 `/thinking/sessions`；底栏显示待确认数量和 AI 资料范围 |
| 「本次整理」抽屉、`ReviewCard` | `features/inspiration/Organize.tsx` + 现有 `ProposalCard` | 候选来自 creative proposals；确认或否决仍走现有 decide API |
| 原型的授权弹窗（Figma 已移除） | `ScopeDialog.tsx`（本作品的 AI 资料范围） | 普通对话没有弹窗；读取作品资料需要按作品显式开启，可随时撤销 |
| `useKeyboard` / `useMedia` / `pb-safe` / `h-app` | `features/inspiration/media.ts`、`styles/index.css` | 跟随 visualViewport；仅在灵感页窄屏时启用 `viewport-fit=cover` |
| App 顶栏（灵感页在移动端隐藏） | `StudioHeader.tsx` | 移动端灵感页使用自己的 56px 顶栏，作品切换和主导航放进历史抽屉 |

## 实际改动

- `apps/agent/src/runtime/pi-host.ts`、`tools/registry.ts`：修订收尾与预算规则，见[架构修订](../architecture/inspiration-agent-usability.md#2026-11-01-收尾与预算修订turn_budget_exceeded)。新增测试 `apps/agent/test/turn-budget.test.ts`。
- `apps/web/src/features/inspiration/*`（新）与 `features/creative/InspirationWorkspace.tsx`（重写）：上表所列的组件。
- `apps/web/src/features/thinking/{errors,useThinking}.ts`：网络断开、服务不可用和 5xx 有了明确的中文提示；计费和方案限制直接显示 API 返回的说明；带数字的错误码会保留在“查看详情”里。
- `CreativeConsent.tsx`：服务和模型直接显示，接收地址与每日上限收进可展开的“技术细节”，同意流程和请求内容不变。
- 壳层：`App.tsx`、`AuthGate.tsx`、`ManagedStudio.tsx` 改用 `h-app` 高度，键盘弹出时页面整体跟随可见区域（同时修正了登录态下多出一条账号栏高度的问题）；`StudioHeader` 在移动端灵感页隐藏；`BookMenu` 新增可选的 `wide` 参数。
- 测试与工具：`e2e/inspiration.integration.spec.ts` 重写；`start-inspiration-stack.mjs` 和 `scripts/lib/thinking-fixture.mjs` 增加可选的合成 Markdown 回复、推送节奏和一次性失败；`scripts/test-thinking-funnel.mjs`、`e2e/api.integration.spec.ts` 改用新界面的定位方式；`scripts/compare-figma-baseline.mjs` 增加灵感场景和 375×667 视口。

## 会话、授权与模型

- 首次发送：先用稳定幂等键创建会话（`{modelId}`，没有 consent 字段），再用另一个幂等键发送消息。界面先把问题显示为“正在发送…”，服务端确认后才进入正式对话。失败时草稿保留；送达不确定时显示“恢复待确认问题”，重试使用同一个键。
- 资料范围：新会话默认 `scopes=[]`。各项范围按作品保存在服务端，变更时 Go 会重新签发凭证并撤销旧凭证。私人笔记需要单独勾选。没有新增任何绕过路径，Go 和 Pi 仍会验证身份、作品归属、凭证和每轮的工具范围。
- 模型：Pi Runtime 已支持按消息切换模型（Go 为每条消息签发绑定模型的凭证，Pi 核对 Registry）。界面切换只影响下一条消息；每条回复显示它实际使用的模型名称；托管方与名称不一致时会写明（“由 Amazon Bedrock 托管”）。生成中不能切换。原模型下线后，界面会提示作者自己选择，不会自动替换。
- 失败：「重新尝试 / 继续回复」调用 `resume` 并带上 `confirmAdditionalCost:true`。按钮旁写明会再次请求模型、按实际用量计点，作者点击即视为确认；恢复使用同一条消息，不会重复出现问题。已停止或不能安全重放的回复改为“重新提问”，把原问题放回输入框。错误码和追踪编号只在“查看详情”中显示。
- 不支持的原型能力没有伪造：已完成回复的“重新生成”、“有帮助”标记、“可以继续想”追问，以及“已想清楚 / 未完成”状态都没有后端支持，本次没有实现。

## 视觉验收（Screenshot → Compare → Fix）

方法：Figma Make 源码在临时副本 `/tmp/figma-make` 中构建（复用生产依赖，原目录未改动）；生产端是真实 Go + Pi 加合成模型。脚本为 `apps/web/scripts/compare-figma-baseline.mjs`，场景包括 `idea`、`idea-thread`、`idea-models`、`idea-drawer`，视口包括 1440×900、1280×800、768×1024、390×844、375×667。

| 轮次 | 发现的差异 | 修复 |
| --- | --- | --- |
| 1 | 回复小标题用了 UI 字体加粗；发送后输入框失焦；会话标题过长 | 小标题改为继承衬线 500；请求结束后桌面端重新聚焦输入框；标题限制最大宽度 |
| 2 | 流式回复会跑到首屏以下；移动端抽屉里看不到作品名；资料范围弹窗在手机上的按钮折行 | 作者没有滚动时，让问题逐步停到顶部；BookMenu 在抽屉里显示作品名；说明文字移进正文 |
| 3 | 桌面落地页多出“更多”按钮；抽屉标签内边距比 Figma 少 4px | 落地页侧栏展开时不显示“更多”；抽屉内标签使用 `px-3` |

最终像素差异为 0.14%–6.10%（`|ΔRGB|>48` 计为不同）。剩余差异来自内容：示例作品、历史列表、Figma 模拟回复里的“可以继续想”区块、模型菜单的托管方说明行，以及生产端顶栏的账号和点数控件。所有共同地标（顶栏、主导航、侧栏、标题、输入框、发送按钮、模型按钮）的位置差都不超过 4px。所有视口都没有水平溢出，Noto Serif SC 已加载。

## 测试结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`、`pnpm lint` | 通过 |
| `pnpm --filter @writer-agent/web test`（Vitest） | 32 个文件，236 项通过（新增 `inspiration.test.tsx` 13 项） |
| `pnpm --filter @writer-agent/agent test` | 46 项通过（新增 5 项收尾与预算测试） |
| `go test ./...`（apps/api-go） | 通过 |
| `playwright.inspiration.config.ts`（桌面 Chromium + iPhone 13 WebKit） | 18/18 通过 |
| `scripts/test-thinking-funnel.mjs`（Worker/D1 → Go → Pi） | 通过 |
| `test-thinking-agent.mjs`、`test-thinking-terminal-crash.mjs`、`test-agent-runtime.mjs`、`test-creative-workflow.mjs`、`test-agent-task-contract.mjs`、`test-pi-review-worker.mjs`、`test-webhook-security.mjs`、回复风格检查 | 通过 |
| `eval:reliability` | 与基线相同（taskCompletionRate 0.667，分母包含故意不恢复的故障） |
| `playwright.config.ts`（演示工作台）、`run-api-e2e.mjs`、`run-author-experience-e2e.mjs` | 通过 |
| `run-creative-e2e.mjs` | 1 项失败：`toHaveURL(/view=read&compose=1/)` 遇到额外的 `book`、`chapter` 参数。未改动的基线同样失败，与本次修改无关，未处理 |
| `pnpm --filter @writer-agent/web build` | 通过 |
| `smoke-inspiration-live.mjs --confirm-synthetic` | DeepSeek、OpenAI 均为 UNVERIFIED：本机没有 Smoke 凭据，没有发起付费调用 |

覆盖的场景：新用户首次发送、恢复历史、连续十轮、DeepSeek / OpenAI 按消息切换和 A→B→A 模型归属、有工具与无工具讨论、持续请求工具的模型、模型失败后恢复、断网、刷新、停止、送达不确定时的回执对账、资料范围开关、作品与账号隔离（Go 测试与 funnel）、用量计量（快照 usage 和点数变化）、移动端输入字号、浮层和抽屉的位置与关闭、输入框不遮挡回复。

## 2026-11-01 代码审查后的修复（基于 `38b5c46` 的审查）

| 审查项 | 结论 | 处理 |
| --- | --- | --- |
| P0 Web 自动部署失败 | 与本次修改无关，也不是这次才出现：`deploy-web.yml` 自仓库初始化以来的 10 次运行（#1 `b9fb657` 至 #10 `38b5c46`）全部失败，每次耗时 33–40 秒。生产 Web 此前一直通过 wrangler 手动发布（见 `.local/deployment-records`）。从本机执行同一段门禁脚本可以全部通过：公开首页返回 200、契约校验通过、`x-writer-agent-identity-mode: per-user-v1`、没有签名用户的 Bearer 返回 401。因此失败原因只可能在 Runner 一侧：`WRITER_AGENT_API_TOKEN` Secret 缺失；Runner 无法访问 `api.story2u.xyz`（直连 EC2 `13.60.251.155`，可能受安全组限制）；或者真实 Token 被接受（安全问题）。日志必须登录才能查看，而账号被停用，无法读取 | 没有放宽或跳过任何检查。门禁脚本现在会把检查项和网络原因写进日志：哪项失败、状态码、连接错误码。下一次运行即可判断属于哪种情况。`38b5c46` 的前端没有通过 Actions 上线 |
| P1 草稿串会话 | 属实 | 草稿按“账号 + 作品 + 会话”分开保存，新话题有单独的草稿位置；创建会话时，新话题草稿转到该会话，发送失败时不会丢失；删除会话时一并删除其草稿；旧版按作品保存的草稿迁移到当时打开的会话 |
| P1 加载更早讨论后跳回最新 | 属实（未修复时实测位移 402px） | 区分“在顶部插入更早消息”和“新消息到达”：插入前记录滚动位置，插入后恢复；关闭浏览器自带的 `overflow-anchor`，避免与手动恢复重复修正 |
| P1 原文定位不完整 | 属实；API 模式下阅读页只接收审查定位，`书` 中来源跳转设置的段落高亮同样不会显示 | 新增 `openEvidence`：已核验的引文会打开对应章节并高亮唯一匹配的段落；旧版本引文不做段落跳转，只提示作者核对；引文找不到或出现多处时同样提示，不会猜测位置。阅读页在没有有效审查定位时显示证据定位，审查定位仍然优先 |

新增测试：`thinkingController.test.tsx` 2 项（A→B→A、新话题与刷新后的草稿归属，旧版草稿迁移）；`inspiration.integration.spec.ts` 2 项（草稿隔离；22 轮、两页历史时，加载更早讨论后可见消息位移小于 40px）；`test-thinking-funnel.mjs` 增加“查看原文”后唯一段落高亮的检查。结果：Vitest 238 项、灵感 E2E 22/22（桌面 + iPhone WebKit）、Worker funnel、review、API、author-experience 与演示工作台套件均通过。

## 仍需解决

- 真实模型没有验证（缺凭据）。部署前需要用 `smoke-inspiration-live.mjs --confirm-synthetic [--tools]` 分别验证 DeepSeek 和 Bedrock，重点确认 `tool_choice=none` 加上 tools 的收尾轮在两家 API 上都被接受。
- 真机键盘：Playwright 无法弹出 iOS 软键盘，visualViewport 逻辑只有单元测试覆盖。上线前需要在 iPhone Safari 和常见 WebView 中人工确认。
- 输入上界按 UTF-8 字节计算（设计要求的保守估计），中文对话会比实际 Token 早得多触发压缩。如需更长的上下文，应在 Registry 中调整 `maxInputTokens`，不应修改计费口径。单个工具结果上限（24000 字节）与输入上限相同，读取超长章节后的下一轮仍可能 `INPUT_BUDGET_EXCEEDED`。
- 会话列表接口没有消息数，历史条目无法像 Figma 那样显示“N 轮”。已完成回复的“重新生成”需要服务端新增能力。
- `run-creative-e2e.mjs` 中与 URL 参数有关的既有失败。
- Web 自动部署门禁（见上节 P0）。需要能登录 GitHub 的人查看下一次运行日志，再决定是补 Secret 还是调整 EC2 入站规则；在此之前，生产 Web 仍要按部署流程手动发布，并且需要明确授权。
- 2026-11-01 已按作者要求将 `38b5c46` 合并到 main 并推送（没有创建 PR）。GitHub API 仍返回 403，只能通过网页查看运行状态。
