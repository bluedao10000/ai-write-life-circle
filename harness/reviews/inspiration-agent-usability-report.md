# 灵感 Agent 可用性交付报告

日期：2026-10-28。基线：main `ebfef0e`；开发分支：`codex/inspiration-agent-usability`。
本次不部署生产、不创建 PR。main 的 push 会触发自动部署，因此交付停在独立远端分支。

## 审查结论与根因边界

实际代码确认：旧 prompt 无条件要求 Search first；Story Tools 只按 creative 筛选，其他未授权工具仍会展示给模型（Go 仍会拒绝执行）；工具循环遇到轮次上限直接终止，没有总结机会；会话绑定唯一配置模型；首次发送必须先通过技术授权弹窗；输入草稿和未确认交付的幂等意图仅在内存中。
这些问题使普通创意讨论容易进入无用的工具链、浪费预算，并在错误后缺少自然的恢复路径。已用真实 Pi SDK + HTTP Fixture 复现预算耗尽路径，并建立张居正/好人品/平行宇宙的单次完成回归。
没有获取那一次生产请求的完整轮次 Trace，也没有对历史真实小说发起付费模型调用；因此不能断言其唯一原因是模型协议错误、某一个特定工具或实际 Token 用量。Fixture 证明执行行为，不证明创作回复的语义质量。

## 已实现

- 普通对话默认无作品读取权限，无强制工具调用，只允许单次 completion 并只预留一次费用；显式压缩保留完整预留。
- 工具任务保留有界执行，重复查询不重复读取，最后一轮移除工具并要求收尾。空回复、截断、超时、主动取消有不同终态；保留部分文字和历史上下文。
- 私有模型 Registry 支持独立 ID、名称、实际托管方、凭据引用、协议参数、上下文、输出限制、工具能力、点数政策及 enabled。Go 只接受 Registry ID；不接受任意 Endpoint/Key。旧单模型部署仍兼容。
- 同一讨论按下一条消息切换模型，生成中禁止切换；每条消息记录实际模型，历史继续存在。切换模型清除内部原始检索历史，以可见对话继续；不静默回退。
- AI 资料范围按账号/作品持久化，章节、知识、创作设定、私人笔记可单独开启/撤销。新客户端不继承旧会话的私有授权；Go 的 Capability 与工具权限仍是最终边界。
- 首次发送自动建会话，立即显示发送中的用户消息，失败保留输入；草稿、所选模型、会话 ID、创建/消息 outbox 按账号/作品隔离，刷新后重试使用原幂等键。
- 主工作台和紧凑面板移除技术授权步骤、端点、Token 统计和原始错误码。工具过程默认折叠；桌面 Enter 发送，手机 Enter 换行，按钮发送。
- 费用仍用现有 Billing Ledger reserve/settle 和全站/账号限额；相同键不重复预留，不提升 Free 总成本上限。当前两模型均采用现有 standard-points-v1 政策（倍率 1），按实际 Usage 结算；未知用量保守处理。

## 提交

- `2bfcfb4`：现状审查与架构设计。
- `b1a77c2`：有界执行、Registry、消息模型路由、API 契约与 Go/Pi 测试。
- `1a0ee77`：隐私撤销、模型预算及 Billing 回归。
- `c74ed2b`：自动建会话、模型选择、持久重试、移动端与 E2E。
- 后续交付提交包含最终配置、Smoke 入口、报告与补充检查。

## 验证

- 完整 `pnpm test` 退出码 0：Go race、业务 HTTP 契约、权限、Billing、Web/Worker、Pi Review/Knowledge、24 场景兼容及 10/100/500 章回填与故障恢复。
- 最新 Agent 单元/真实 SDK Fixture：11/11 通过，包括普通讨论、十轮历史、切模型与独立凭据、幂等、循环收尾、429、空结果、超时和取消。
- Web 全量 209/209、Worker 全量 23/23 通过；随后补充模型切换拒绝回滚用例，ThinkingController 最新 7/7 单独通过。
- 新增 Go race 回归通过：作品读取范围、旧权限撤销、错误模型拒绝、按所选模型预留（GPT-OSS 单次 57 点）、相同键不重复预留。
- Playwright 桌面 Chromium、iPhone WebKit：2/2，通过首次发送、切模、刷新历史/草稿、私人笔记默认关闭、保存范围与无横向溢出。
- Typecheck、Lint（0 warning/0 error）、完整 build、Go vet、OpenAPI 检查及 diff 检查通过。build 仍有既有大 chunk 提示，本次没有做视觉或打包架构重构。
- 真实 DeepSeek/OpenAI Smoke：**UNVERIFIED**，没有显式提供本次测试凭据；没有付费请求。脚本只发合成问题并输出状态/用量，不输出密钥或小说。

## 文件清单

运行时：`apps/agent/src/config.ts`、`runtime/pi-host.ts`、`server/http.ts`、`tools/registry.ts`、`agents/thinking/prompt.ts`。
Go：`apps/api-go/internal/thinking/{model,http,service_test}.go`。
前端：`apps/web/src/features/creative/InspirationWorkspace.tsx`、`features/thinking/{useThinking,ThinkingPanel,errors}`、`services/api/thinkingApi.ts`、`worker/index.ts`。
契约：`packages/contracts/src/thinking.ts`、`scripts/build-thinking-openapi.mts`、`harness/contracts/thinking-api-v1.json`。
测试：`apps/agent/test/{chat,config,runtime}.test.ts`、`apps/web/src/test/thinkingController.test.tsx`、`apps/web/e2e/{inspiration.integration.spec.ts,start-inspiration-stack.mjs}`、`apps/web/playwright.inspiration.config.ts`、`scripts/lib/thinking-fixture.mjs`。
运维/文档：`scripts/deploy/pi-models.example.json`、`scripts/smoke-inspiration-live.mjs`、本报告、`harness/architecture/inspiration-agent-usability.md`、`harness/index.md`。

## 上线条件与局限

1. 同版本部署 Go API、Pi Thinking、Web；当前不会自动操作生产。
2. 配置受保护 Registry 文件和两组环境变量凭据。示例的 Bedrock REGION/模型名需实际核实，不可直接复制上线；未注册第二个模型时只显示现有模型。
3. 显式运行合成真实 Smoke 后再进行少量真实写作验证；工程 Fixture 成功不替代真实模型质量验收。
4. 回滚程序不回滚作者状态，不删除新增消息/权限记录；部署前备份原配置和状态。
5. 浏览器禁用 sessionStorage 时无法跨刷新恢复尚未确认交付的本地意图，服务端已接受消息和幂等回执仍持久存在。
6. 暂无跨标签页草稿同步；超过上下文/会话硬上限时提示新话题，不自动丢弃作者历史，也不在后台付费压缩。
