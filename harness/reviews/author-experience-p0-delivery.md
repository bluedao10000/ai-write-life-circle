# 作者体验 P0 交付记录

日期：2026-10-26。分支：`codex/author-experience-p0`。基线 `cba465a`，依赖未合并的 `codex/pricing-phase1-review-fixes`（Pricing Phase 1 与事务/权限修复）。本轮不合并、不部署、不修改生产数据，也未调用付费模型。建议本 PR 先以该修复分支为 base；基座合入 main 后再调整 base 并重跑 CI，避免把两轮改动混在一起审查。

## 交付行为与决策

| 模块 | 作者体验 | 复用与安全边界 |
| --- | --- | --- |
| 工作台恢复 | 有正文时恢复上次作品、章节、读写模式与位置；无正文默认灵感，提供“开始写作”；显式 URL 优先 | Workspace.resume 仅存元数据；账号/作品隔离；同 Revision 才恢复光标；保留本地草稿与保存屏障；较新的服务端位置优先于旧浏览器位置 |
| 历史版本 | 读取完整旧 Markdown、双栏原文、标示新增/删除/修改；复制所选文本、选段追加章末、二次确认恢复全文 | 复用 SavedRevisionAt 与原有 CAS/幂等保存队列；先保存当前修改；恢复生成新版本，不替换历史；身份/归属校验与响应 Hash 校验 |
| 审查与注记 | 两个抽屉入口：“本章设定”“审查与注记”；明显的“审查本章”；同面板查看证据、进度、历史、作者笔记和反馈 | Review 与 Note 仍独立；编辑器持续挂载；保存失败禁止发送；修改后旧结果 stale，不能错误定位；不写 Canon |
| Free 审查 | 每账号每 UTC 自然月 2 次，显示剩余次数、重置日期和点数预留，额度用尽仍能读取结果与正常写作 | 账户级持久化试用预占/已用状态，与点数和全站池在原 redo 事务提交；同 Run 重试不重复计次；并发不能绕过 |
| 成本与执行 | 逐次确认实际发送范围后运行，Free 单次最多预留 217 点，实际 Usage 结算 | 上下文最多 64 KiB、输出最多 32,768；限制进入 consent hash，Go 与 Pi 同步执行；完整预留须放入 Free 日/月/全站预算，不提高全站上限；超长目标不静默裁切 |
| 隐私指标 | Time to Writing 耗时桶、恢复 attempt/success/failure、Free started/completed、反馈 useful/other | 默认关闭，仅进程内枚举载荷，无 SDK、网络或持久身份；运行时丢弃额外字段，sink 错误不影响写作 |

完整设计、数据结构、并发与回滚约束见 [架构设计](../architecture/author-experience-p0.md)。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（Contracts、Web、Worker、Agent） |
| `pnpm lint` | 通过，0 错误、0 警告 |
| `pnpm build` | 通过（Go API/Worker、Pi、Web、SSR）；仍有主应用包大于 500 kB 的构建提示，历史 Diff 为独立按需加载包 |
| `pnpm test` | 完整通过；Go 全包 Race、Webhook、Review HTTP、Agent Runtime、Publication、Knowledge 合成 Eval、Web/Worker、Pi Review/Knowledge/故障与恢复均成功 |
| 最终 Web/Worker 单元测试 | 206 / 206 与 23 / 23 通过 |
| 最终变更相关 Go Race | billing、review、agenttasks 通过 |
| Pi Agent 单元/网关测试 | 9 / 9 通过；校验实际 provider 请求使用下调后的输出上限 |
| 原有 Review Playwright | 3 / 3 通过：明确同意、证据定位、反馈、stale、保存失败、不可用服务 |
| Management Playwright | 13 / 13 通过：作品隔离、未保存保护、CAS 冲突、EPUB、移动端、菜单与删除 |
| 新作者完整路径 Playwright | 2 / 2 通过：桌面恢复→保存→历史 Diff→选段恢复→Free 审查→反馈；390×844 移动端历史和合并抽屉 |
| `pnpm openapi:check` / `pnpm openapi:lint` | 可重现性检查与全部契约验证通过；Redocly 仍提示许可证、旧 Tag 描述、未使用组件等文档告警，未关闭规则 |
| `git diff --check` | 通过 |

新增测试覆盖 20 个并发请求争抢同账号额度、不同作者隔离、同请求/同 Run 重试、模型前取消/准备失败释放、启动后失败/超时计次、UTC 月切换、217 点完整预留、600 点无法进入 Free 日预算，以及全站 Free 池不足。另有两次真实领域审查完成后第三次被拒绝、历史继续可读、正文未修改的合成端到端测试。

测试期间修正了测试隔离与选择方式：作品菜单测试重置残留 URL；EPUB 目录操作显式定位目录内的同名章节按钮；历史对比使用已保存 Markdown，不把富文本 innerText 当作原文。无头 Chromium 的只读 textarea 方向键无法创建光标选区，选段 E2E 改用原生范围与鼠标释放事件；没有删除测试、放宽正文一致性断言或绕过恢复 API。

## 限制与后续验收

- 32,768 输出上限通过工程契约和网关测试验证，未用真实模型评估长章节截断率、误报率或审查价值。若目标超过完整上下文预算，将明确拒绝；不将短 Fixture 通过当作长篇质量证明。
- 大章节超出 Diff 计算上限时保留完整双栏原文，暂不生成逐字 Diff；片段恢复只支持安全追加章末，作者可复制后在任意位置自行粘贴。
- 指标默认不上传；当前页面内的 Free 启动/完成可建立激活率基础，跨刷新完整转化统计需要后续经过隐私审查的聚合实现。尚无真实运营数据。
- 上线需同版本升级 API 与 Go/Pi Worker，避免旧执行器不识别输出限制；保留所有 Revision 和计费日志。具体停机/排空和回滚步骤见设计，生产操作需另行授权。
- 开发分支已通过 Git SSH 推送至 `origin/codex/author-experience-p0`。GitHub CLI 返回 `403: Sorry. Your account was suspended`；连接器创建 PR 返回 `403: Resource not accessible by integration`，因此当前没有创建 PR，也未核验远端 CI。已保存 [PR 说明](author-experience-p0-pr.md)；可在权限恢复后以 `codex/pricing-phase1-review-fixes` 为 base 创建，不要以包含上一轮改动的大 diff 冒充本轮独立审查。

## 修改文件清单

相对基线 `cba465a`，完整清单如下（含生成契约、设计与测试，不含构建产物和私有工作目录）：

- `.github/workflows/ci.yml`
- `.gitignore`
- `apps/agent/src/runtime/model-gateway.ts`
- `apps/agent/test/gateway.test.ts`
- `apps/api-go/internal/agenttasks/service.go`
- `apps/api-go/internal/application/application_test.go`
- `apps/api-go/internal/application/validation.go`
- `apps/api-go/internal/billing/billing.go`
- `apps/api-go/internal/billing/billing_test.go`
- `apps/api-go/internal/billing/integration_test.go`
- `apps/api-go/internal/billing/plans_test.go`
- `apps/api-go/internal/billing/recovery_test.go`
- `apps/api-go/internal/billing/review_trial_test.go`
- `apps/api-go/internal/llm/client.go`
- `apps/api-go/internal/llm/client_test.go`
- `apps/api-go/internal/llm/openai_compatible.go`
- `apps/api-go/internal/review/context.go`
- `apps/api-go/internal/review/cost_policy.go`
- `apps/api-go/internal/review/service.go`
- `apps/api-go/internal/review/types.go`
- `apps/api-go/internal/review/worker.go`
- `apps/api-go/internal/transport/http.go`
- `apps/api-go/internal/transport/managed_test.go`
- `apps/web/e2e/author-experience.integration.spec.ts`
- `apps/web/e2e/management.integration.spec.ts`
- `apps/web/e2e/review.integration.spec.ts`
- `apps/web/e2e/run-author-experience-e2e.mjs`
- `apps/web/package.json`
- `apps/web/playwright.author-experience.config.ts`
- `apps/web/src/app/App.tsx`
- `apps/web/src/features/account/AccountMeter.tsx`
- `apps/web/src/features/management/ManagedStudio.tsx`
- `apps/web/src/features/reviews/ReviewConsentDialog.tsx`
- `apps/web/src/features/reviews/ReviewMarginPanel.tsx`
- `apps/web/src/features/reviews/useReviewController.ts`
- `apps/web/src/features/vnext/StudioHeader.tsx`
- `apps/web/src/features/vnext/useStudioController.ts`
- `apps/web/src/features/workspace/ComposeBar.tsx`
- `apps/web/src/features/workspace/RevisionHistory.tsx`
- `apps/web/src/features/workspace/WritingSpace.tsx`
- `apps/web/src/features/workspace/revisionDiff.ts`
- `apps/web/src/features/workspace/useWorkspaceController.ts`
- `apps/web/src/observability/authorExperience.ts`
- `apps/web/src/services/api/accountApi.ts`
- `apps/web/src/services/api/chapterApi.ts`
- `apps/web/src/services/api/client.ts`
- `apps/web/src/services/mappers/workspaceMapper.ts`
- `apps/web/src/services/workspaceResume.ts`
- `apps/web/src/test/App.test.tsx`
- `apps/web/src/test/apiWorkspaceController.test.tsx`
- `apps/web/src/test/authorExperience.test.ts`
- `apps/web/src/test/management.test.tsx`
- `apps/web/src/test/revisionDiff.test.ts`
- `apps/web/src/test/revisionHistory.test.tsx`
- `apps/web/src/test/workspaceResume.test.ts`
- `harness/architecture/author-experience-p0.md`
- `harness/contracts/agent-tasks-v1.json`
- `harness/contracts/api-spec-v0.4.0-proposed.yaml`
- `harness/contracts/author-workspace-extension.json`
- `harness/contracts/review-engineering-extension.json`
- `harness/design/pricing-plans.md`
- `harness/index.md`
- `harness/reviews/author-experience-p0-delivery.md`
- `harness/reviews/author-experience-p0-pr.md`
- `package.json`
- `packages/contracts/src/agent-tasks.ts`
- `packages/contracts/src/billing-review.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/resume.ts`
- `packages/contracts/src/reviews.ts`
- `packages/contracts/src/v04.ts`
- `pnpm-lock.yaml`
- `scripts/build-author-workspace-openapi.mts`
- `scripts/build-openapi-candidate.mjs`
- `scripts/build-review-openapi.mts`
