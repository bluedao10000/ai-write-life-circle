# Writer Agent V3 交付报告

日期：2026-10-25。基线 `main` `b9fb657`。设计见 [ADR](../architecture/writer-agent-v3-creative-assets.md)。

## 1. 分支与提交（按阶段堆叠，均未合并、未部署）

| 分支 | 内容 |
| --- | --- |
| `v3/phase1-architecture` | 现状评审、开源对比、领域模型、可靠性与安全设计（ADR） |
| `v3/phase2-creative-domain` | Go `internal/creative`：资产/版本/关联/候选/决定、对话 outbox、Worker 整理与计划核对任务、`/creative` 路由、thinking 钩子与只读工具 |
| `v3/phase3-agent-workflow` | Zod 契约、Pi 工具与提示词、Cloudflare Worker 路由白名单 |
| `v3/phase4-frontend` | 灵感 / 阅读 / 书、阅读与创作模式、候选审核、书中创作设定、本章设定与计划核对 |
| `v3/phase5-tests-docs` | 全栈工作流脚本、浏览器 E2E、Eval、文档 |

每个分支在前一个之上，可逐个审查。

## 2. API（`/v1/studio/books/:bookId/creative`，仅作品作者，全部 no-store）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `` | 设置、授权披露、计数、待审核数、决定计数 |
| GET/POST | `assets` | 列表（kind、status、q、分页）/ 作者直接创建（draft 或 accepted） |
| GET/PATCH | `assets/:id` | 详情（版本、关联、相关候选）/ 带 `baseVersion` 的修改或状态变更 |
| POST | `links`、`links/:id/remove` | 资产与资产、章节、正文知识实体的关联 |
| GET | `proposals` | status、sessionId、assetId、changeSetId 过滤；附带当前版本与采纳后结果，供 Diff |
| POST | `proposals/decide` | 批量 accept / accept_edited / reject，原子提交 |
| GET | `turns`、`turns/excerpt` | 每轮整理状态；截取的对话片段（需会话归属） |
| POST | `organize` | 作者手动整理某一轮 |
| GET | `context?chapterId=` | 写作上下文：只含作者确认的设定 |
| POST/GET | `plan-checks`、`divergences` | 计划核对入队 / 结果（旧 Revision 标为 stale） |
| POST | `divergences/:id/decide` | update_plan / adjust_future / intentional / dismiss |
| POST | `settings/enable|pause|resume|auto` | 作品级授权与自动整理开关 |

写操作要求 `Idempotency-Key`，同键重放返回原结果。

## 3. 测试结果（本机，2026-10-25）

| 检查 | 结果 |
| --- | --- |
| `go test -race ./...`（含新包 creative 10 个测试、transport/thinking 新测试） | 全部通过 |
| Web `vitest run`（24 文件 181 测试，含 creative.test.tsx） | 通过 |
| Worker 代理测试（含 creative 白名单） | 18 通过 |
| `pnpm typecheck`、`pnpm lint` | 通过（1 条既有 warning，App.tsx 135 行） |
| Agent `tsx --test` | 9 通过 |
| `scripts/test-creative-workflow.mjs`：真实 Go API + Pi + Go Worker + 本地 fixture 模型 | 通过：场景 A、C、D、E、F；3 次整理调用、1 次核对调用 |
| Playwright：`creative`（新增）、`api`、`review`、`management`、`knowledge`、默认视觉、public、thinking funnel | 全部通过；management 4 次运行中 1 次有单个用例失败，重跑通过，未复现，记录为疑似既有时序抖动 |
| 既有集成脚本：thinking、agent runtime、review、knowledge eval、agent task contract、Pi review worker、Pi knowledge worker（100/500 章） | 通过 |
| `pnpm eval:creative`（fixture 模式，6 例 8 轮） | 指标管道与服务端校验通过，`qualityClaim=false` |

未运行：live 模型 Eval（未获授权调用付费模型）；生产部署。

### 场景覆盖

- A 从零创建：新书无正文 → 灵感对话 → 候选 → 作者接受 → 书中可见（Go 单测、全栈脚本、浏览器 E2E 的作者直建路径）。
- B 连续讨论：创建 → 补充动机（修订未审核候选，不重复）→ 否定（SUPERSEDE，历史保留旧值）；之后同名 CREATE 自动转为 UPDATE（Go 单测、Eval B）。
- C 不确定性：三个互斥方案同组、探索性；批量全部接受返回 409 且不部分提交（Go 单测、全栈脚本、Eval C）。
- D 进入创作：阅读 → 本章设定 → 进入创作 → 自动保存 → 返回灵感继续对话（浏览器 E2E、全栈脚本）。
- E 正文偏离计划：核对得到 diverged 与精确引文；作者选择“保留这种变化”；计划与正文均未改动；再保存后结果标为过期（Go 单测、全栈脚本）。
- F 可靠性：重复 accept 幂等、回复中断跳过、回复进行中等待、会话删除使迟到结果失效并清除片段、模型故障重试后失败与手动重试、版本冲突需显式 rebase、作品删除阻断迟到提交（Go 单测、全栈脚本）。

## 4. Agent Eval

`apps/api-go/cmd/creative-eval` 与 `harness/evals/creative/cases.json`。指标：创作意图识别准确率（逐轮候选集合完全匹配）、候选 precision/recall、重复实体数、作者否定识别率、未确认内容误提升率（期望为假设/建议/问题却被标为作者决定）、来源可追溯率、跨轮信息保留率；作者接受率在生产中由 overview `decisions` 计数得出，Eval 中只是模拟。

fixture 模式回放脚本化输出，只验证管道与服务端校验。真实质量需要：`pnpm eval:creative:live`（需模型 Key，`--confirm-fixtures`，最多 40 次调用，输出上限 8192），并由人工评估文学质量。用例目前只有 6 组，需要扩充并做独立语义标注。

## 5. 迁移与回滚

- 新增状态 `<STATE>/creative/<bookKey>/state-v1.json`；现有 `knowledge/`、`chapter-drafts/`、thinking 注册表格式不变（注册表只多出可选字段 `lastMessageId`）。
- 现有会话没有 `creative` scope：照常对话；自动整理仍可用（发生在 Go），但 Agent 不能调用资产工具。新会话默认包含该 scope。
- 部署顺序：备份完整 StateDirectory → Go API 与 Go Worker 一起更新（Worker 增加 creative 执行器，无新环境变量）→ Pi Thinking → Web/Worker 白名单。
- 回滚：程序回退即可，旧版本忽略 `creative/`；保留新状态，不用旧备份覆盖正文。作品删除会一并删除 `creative/`。
- 用户可见变化：默认空间从“写作”变为“灵感”，阅读默认只读，需要点“进入创作”。旧链接 `?view=write/think` 自动映射。

## 6. 已知限制与后续

- 没有收到新版 Figma 设计；UI 使用 V2 设计 Token 与组件，需要设计稿后做视觉对齐。
- 模型接入：main 只有单一 OpenAI-compatible 配置。`.local/multi-model` 中的 `modelcatalog` 未合并；本次只通过 `llm.Config.Info()/Fingerprint()` 接入，没有修改 `llm` 包。合并多模型分支后，creative 授权需要绑定所选模型指纹。
- Pi Worker 未接入整理任务，只在 Go Worker 执行；接入需在 `executorpolicy` 注册新 kind 与任务协议。
- 去重基于名称/别名规范化与模型给出的 ID；语义近似的不同名称仍可能成为两个候选。
- 新增工具与提示词使每次 Pi 请求的保守预留增加约 2 KiB（实测工具定义 4224→5854 字节，提示词 +约 470 字节），同一会话预算会更早耗尽；测试 fixture 会话预算由 200000 调为 260000，生产默认值未改。
- 历史版本面板只列出版本元数据；旧版本正文查看需要新的只读 Revision 详情接口。
- 自动整理依赖 API 进程每 2 秒对账一次 Pi 快照；Pi 长时间离线超过 15 分钟的回合标记为 expired，可手动重试。
- 专注布局保存在工作区偏好中，创作中关闭页面后，下次打开阅读时仍处于专注布局（导航可见）。
- GitHub CLI 账户被暂停，未能创建 PR；分支只在本地。
