# 灵感 Agent 复审修复

日期：2026-10-28。审查基线：`ae6e0d9`。仍在 `codex/inspiration-agent-usability` 分支，不合并、不部署、不创建 PR。

## 四项 P1

| 审查项 | 修改 | 验证 |
| --- | --- | --- |
| 历史会话串用模型 | 模型意图按账号/作品/会话分区；历史会话默认使用最后实际模型。新话题的偏好不影响历史会话。发送期间不允许更换模型。 | Hook A→B→A 检查 POST 的 modelId；桌面/手机 E2E 检查真实 Go/Pi 请求和消息实际 modelId。 |
| 撤权后复用旧来源卡片 | 新轮次 sources Map 初始为空，只有本轮通过当前授权工具取得的来源能附加到新回复。历史卡片保留原消息中。引用旧 ID 的纯文本不被升级为本轮证据。 | 先有合法卡片，撤销章节权限、再撤销知识权限；真实 Pi SDK 回归确认新卡片为空，原历史卡片保留。Go 原有作品/Revision/引文复核继续有效。 |
| 跨会话重试键丢失 | 持久 Outbox 改为 sessionId 分区；每个会话保留未确认意图，不被另一个会话覆盖。未确认消息先读权威快照，精确回执证明送达才清除；无法确认时复用原键，不以相同正文推断送达。 | A 交付不确定→B 成功→刷新→A 重试的 Hook 和浏览器回归；确认只有一条 A 用户消息、Usage 不增加。 |
| Registry 更新残留旧模型 | 新话题的过期偏好可迁移到当前可用默认模型；历史原模型下架时保留其 ID，显示不可用选项和提示，禁用发送，直到作者主动选择。 | 旧 default 偏好迁移、历史 removed-provider 不自动切换、显式选模型后才发送的回归。 |

用户可通过「恢复待确认问题」找回 Outbox 中的原输入。对同一会话尚未确认的意图，不允许用不同输入覆盖它。会话创建与消息发送继续使用各自幂等键。明确的模型拒绝保留草稿，但允许重新选择模型，不把它当作网络交付不确定。

### 回执契约

消息新增可选 `requestKey`（只给作者自己的用户消息，用于交付关联，不是 Capability 或认证密钥）。Pi 接受消息时与已有请求回执一起持久化。旧存储中的消息可以从 `requests[key].messageId` 恢复该字段；没有字段的旧后端仍使用相同幂等键重放，绝不按正文匹配认定送达。OpenAPI 已同步。模型选择和 Outbox 都使用账号/作品命名空间，保留旧单槽 Outbox 的原键并迁移到对应会话。

## 两项 P2

- 全局并发改为独立的 `WRITER_AGENT_PI_GLOBAL_MAX_CONCURRENT`（默认 8，最大 32），每个模型仍有自己的并发上限。不再将默认模型的并发配置同时当作整个 Registry 的上限。没有显式全局配置的构造实例采用已启用模型并发之和，最多 8。测试覆盖两个模型各允许一个、同模型拒绝第二个，以及显式全局上限仍生效。
- 工具去重改用规范化 JSON，递归排序对象属性，保持数组顺序。真实工具执行测试确认属性顺序不同的同一查询只读取一次。

浏览器回归还发现新会话标题未同步到历史列表，现已随权威快照更新；因此 A/B 可以立即从真实历史列表重新打开。

## 真实 Bedrock Smoke

应用 `amazon-bedrock` 技能，使用用户先前配置的 Demo 本地凭据，在独立临时 Pi 会话中运行。没有读取作者作品、生产账本或修改线上配置。真实模型 + 受控合成 Story Tool 替身，不冒充真实小说或真实 Go 资料检索质量验证。

- 已验证端点：`https://bedrock-mantle.eu-north-1.api.aws/v1`。
- 实际模型：`openai.gpt-oss-120b`；实际托管方 Amazon Bedrock Mantle，不是 OpenAI 官方托管。
- 普通创意讨论：completed，回复 1078 字符，输入 487 / 输出 924 Token，Usage incomplete=false。
- 工具场景：completed，实际 Story Tool 调用 1 次，回复 232 字符，累计输入 1802 / 输出 340 Token，Usage incomplete=false。
- 两种场景均通过 Pi SDK 的文本流事件写入回复。使用显式 `max_completion_tokens`，无自动付费重试。工具 Smoke 最多允许 3 次模型调用，普通 Smoke 最多 1 次；脚本可输出文本事件计数和参数，便于后续重跑。
- 示例 Registry 已更新为此次验证的 Mantle 端点和模型标识；部署时仍必须由运营者配置自己的受保护凭据。
- DeepSeek：没有本轮显式测试凭据，仍为 **UNVERIFIED**，不能将 Fixture 成功称为真实 DeepSeek 通过。

## 费用核对

读取 [AWS 官方 EU (Stockholm) 区域价格清单](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/eu-north-1/index.json)，清单发布日期 `2026-10-16T21:08:06Z`。GPT-OSS 120B Mantle Standard 输入为 $0.00015/1K、输出 $0.0006/1K，即每百万输入 $0.15、输出 $0.60；不能将 Priority、Flex、Batch 费率混用。

按此次真实 Usage 和 Standard 公开价估算：普通讨论 $0.00062745；工具场景 $0.00047430；合计约 $0.00110175。它是模型 Token 费用估算，不是已出账的 AWS 账单。

现有 standard-points-v1 输入/输出权重为 1:4，与这个 Standard 费率比例一致。上述两次 Usage 分别应为 5、4 点；已将真实计数（不含文本）送入隔离 Go Billing Ledger 回归，验证预留后实际结算共 9 点、预留归零。没有扣减真实作者的生产点数。积分售卖价格、其他模型或服务等级的利润/全站补贴仍须由运营者另行核对，不能据此认为所有 Provider 都有相同美元成本。

## 工程验证

- 最新 Agent：13/13，含模型独立并发、工具属性排序去重、撤权后的来源卡片。
- 最新 Web：214/214；Worker：23/23；ThinkingController：11/11，包含跨会话 Outbox、精确回执和模型下架。
- `pnpm test:thinking`：真实 Go/Pi 进程集成通过。
- `pnpm test:creative`：通过，合成 chat/organize/plan 调用计数为 3/3/1，未调用付费模型。
- `go test -C apps/api-go -race ./internal/thinking ./internal/billing`：通过，含本次真实 Usage 的隔离结算回归。
- 桌面 Chromium / iPhone WebKit：6/6 通过。包含首次发送、A→B→A 的实际模型路由，以及丢失 A 的 202 响应→B 发送→刷新→A 通过权威回执确认、无再次 POST、消息数与 Usage 不增加。
- Typecheck、Lint（0 错误、0 警告）、OpenAPI 检查、build：本轮重跑通过；不修改 CI 触发条件，也不宣称有未运行的 GitHub CI。

未解决项：真实 DeepSeek Smoke、两 Provider 在真实作者授权资料上的人工质量验收、生产部署与最终账单核对。架构准确范围为「多模型 Registry + OpenAI-compatible Chat Completions 路由」，尚非通用多原生协议 Gateway。

机器可读的合成真实模型验证摘要见 [Bedrock Smoke 记录](inspiration-bedrock-smoke-2026-10-28.json)，不包含输入正文、模型回复或凭据。

## 本轮提交

- `e82d160`：每轮来源边界、独立并发与工具参数规范化。
- `b9a206c`：会话级模型、持久 Outbox、精确回执与桌面/手机跨会话测试。
- 随后的验证提交包含实际 Bedrock 用量记录、费用依据、隔离 Ledger 测试、示例配置与文档。
