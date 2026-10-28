# 灵感 Agent 可用性与多模型路由

日期：2026-10-28。范围：灵感对话，不改变正文、Canon、Review/Knowledge 执行器，不部署生产。

## 现状审查

Browser InspirationWorkspace → useThinking → 同源 Worker → Go thinking → PiHost → Pi SDK OpenAI completions。
已有持久会话、幂等消息、游标事件、取消、Capability、只读工具、Billing reserve/settle 可复用。
缺口：提示词无条件 Search first；工具没有按全部 scopes 筛选；耗尽轮次无收尾；错误仍直接展示代码；配置只支持单模型并绑定会话；首次发送依赖技术授权弹窗；草稿刷新丢失。
不能仅凭代码确定某次生产失败的模型实际调用序列。用隔离 HTTP Fixture 验证普通问题、工具循环、长对话和模型切换，不读取生产正文。

## 设计

1. 保留 Pi SDK，普通讨论不强制查询。默认新会话 scopes=[]。作品级 AI 资料范围独立持久保存，默认全部关闭；私人笔记单独选择，可随时撤销。Go 为每轮重签 Capability，修改设置撤销旧凭证。
2. 首次发送自动创建会话，消息和创建各有稳定幂等键。失败保留输入；不把不确定交付当新请求重发。已失败执行的再次提问明确属于新计费请求。
3. Pi 私有注册表维护完整模型配置和独立凭据；公开模型目录只返回允许字段。客户端只能提交 modelId，不能提供端点/密钥/预算。旧 consent/model 创建接口兼容；新接口不用弹窗。
4. 每条消息在 Go 会话锁内选择模型、预留该模型预算、签发模型绑定凭证。Pi 校验 Registry 与 Grant 一致后接收，保留原会话历史，记录消息模型。生成中禁止切换；模型关闭/配置失效明确失败，不回退。
5. 最后一轮强制 tool_choice=none，并加入收尾指令；重复工具请求停止实际读取，返回停止提示。硬上限仍有效。空回复、截断、协议错误、超时与主动取消分开。
6. 输入采用 UTF-8 字节的保守上界，不冒充实际 Token；有可信 Usage 时按实际累计，缺失时保守结算。所有已允许模型统一使用现有 AI 点数换算（倍率 1），不同上下文/输出预算独立预留，既不免计费也不提升全站预算。
7. 前端展示模型名称与实际托管方，隐藏端点和预算；模型切换仅影响下一条消息。草稿和会话按账号/作品隔离。工具过程默认折叠。移动端 Enter 换行，桌面 Enter 发送。

## 契约与安全

新增作者作用域 /thinking/models 和 /thinking/preferences。Create 支持 modelId；Message 支持 modelId；消息新增可选 modelId/modelLabel。旧字段保留以兼容已有存储和客户端。Registry 来自受保护配置文件，凭据由环境变量引用，绝不经健康接口返回。Go 验证作品归属；工具仍独立验证 scopes，UI 隐藏不构成权限控制。

## 验收与回滚

Fixture 覆盖普通创意问题（张居正、平行宇宙、好人品）、多轮、切模、幂等、取消、超时、预算和工具循环；Go 覆盖资料授权和隔离；Web 覆盖自动创建、草稿、模型选择及错误。真实 Smoke 仅显式运行合成输入，缺凭据标记未验证。
回滚程序版本不回滚作者文件；旧模型/消息字段兼容；新建会话仍可使用旧部署支持的 consent/model 路径。回滚时停灵感服务，保留新增设置文件与消息历史。

## 配置与验证入口

- Registry 示例：`scripts/deploy/pi-models.example.json`。运营者设置 `WRITER_AGENT_PI_MODELS_FILE` 指向受保护本地 JSON 文件；凭据只由 `keyEnv` 引用，不写入文件、不经健康接口返回。示例 Bedrock 已更新为本轮验证的 Stockholm Mantle 端点与模型 ID；部署时仍须验证目标账号权限并配置凭据，不能把 Runtime 的模型标识混用于 Mantle。实际托管方始终显示 Amazon Bedrock，不能显示为 OpenAI 官方托管。
- 未配置 Registry 时兼容旧单模型配置，仅有 `default`；不会捏造第二个可用模型。两模型各自显式 enabled；关闭或无凭据时不会回退。
- Registry 示例的轻量对话只预留一轮；开启工具后最多四轮。DeepSeek 输出 4096；GPT-OSS 输出 8192；输入保守上界 24000；所有值须结合真实 Smoke 与用量调整。四轮均满足现有 Free 300 点日额度的单次保守预留（DeepSeek 164 点，GPT-OSS 228 点），但账号已使用额度及全站上限仍可能阻止执行。没有扩大 Free 总预算。
- 资料设置按作者和作品持久化。切换模型或缩小资料范围会清除内部原始检索历史，仅以用户可见对话继续；已展示讨论不会被删除。
- `pnpm test:agent`：真实 Pi SDK + 合成 HTTP，测试十轮、同键回放、模型切换、循环收尾、限流和空回复。
- `pnpm test:thinking`：真实 Go/Pi 进程、来源核验、恢复、取消、删除与作用域边界。
- `pnpm --filter @writer-agent/web exec playwright test --config playwright.inspiration.config.ts`：桌面 Chromium + iPhone WebKit，自动建会话、切模型、刷新草稿、可撤销资料范围。
- `pnpm build:agent && node scripts/smoke-inspiration-live.mjs --confirm-synthetic`：只发合成讨论，每个已配置模型最多一次付费调用；显式提供 `WRITER_AGENT_CHAT_DEEPSEEK_KEY/URL/MODEL` 与 `WRITER_AGENT_CHAT_OPENAI_KEY/URL/MODEL`。没有凭据输出 UNVERIFIED，不是通过。
- Browser outbox 与草稿保存在按账号/作品隔离的 sessionStorage；服务端已接受消息的幂等回执继续由 Go/Pi 持久化。浏览器存储不可用时仍可聊天，但关闭页面后无法保留尚未确认交付的本地意图。

## 2026-10-28 复审修订

模型选择和 Outbox 按会话分区。历史会话默认恢复其实际模型；下架模型必须由作者显式替换，新话题可迁移过期默认偏好。每轮来源只接受本轮授权工具返回的证据，历史 source ID 不自动获得新轮次的有效来源身份。
用户消息的可选 requestKey 关联幂等回执，用于先确认送达、再决定是否原键重试；旧记录从 Pi requests 映射派生回执。全局并发与模型并发分别受控；工具去重使用规范化 JSON。
示例 Registry 已由占位 Runtime URL 更新为实测的 Stockholm Mantle URL + `openai.gpt-oss-120b`；不同 Bedrock API 的模型标识不可混用。
真实验证、费用依据、回归结果与剩余风险见[复审修复报告](../reviews/inspiration-agent-usability-review-fixes.md)。这份补充报告取代初次交付中「两个真实模型均未验证」的状态：Bedrock 已验证，DeepSeek 仍待测试凭据。
Smoke 脚本增加 `--tools`，只用合成资料、每个配置模型最多 3 次付费请求。常规 CI 仍不运行付费模型。
