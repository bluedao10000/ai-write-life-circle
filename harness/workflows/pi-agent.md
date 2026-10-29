# Pi Thinking：开发、手动发布与回滚

本流程只准备独立 Thinking 服务，不迁移 Go Review/Knowledge。自动 EC2 发布保持关闭。当前 PR 不运行本流程中的服务器命令。

## 本地开发

Node >=22.19.0，pnpm 10.15.1。`pnpm install && pnpm build:agent`。

先在工作区之外建立两个不同的随机凭证文件（例如 `openssl rand -hex 32`），权限 0600：服务 Token 供 Go→Pi RPC，能力签名 Key 仅供 Go。不要复用公网 API Token。设置 `scripts/deploy/pi-go.env.example` 中的变量；本地能力 Key 文件和 RPC Token 路径替换为开发路径。Pi 另设 Token 文件、独立 StateDirectory 与 `WRITER_AGENT_PI_LLM_API_KEY`。仅 Pi 需要模型 Key；默认 DeepSeek endpoint/model 为 `https://api.deepseek.com` / `deepseek-flash`。也可显式使用原有 LLM 环境变量；切勿把生产环境文件加载进自动测试。

可分开运行 `pnpm dev:api:go`、`pnpm dev:agent`、`pnpm dev`，或上述配置就绪后运行 `pnpm dev:local -- --agent`。不加 `--agent` 的旧启动方式不变。Agent 崩溃只影响思考；API 和编辑器继续服务。

`pnpm test:agent` 使用实际 SDK 和隔离 HTTP 模型，`pnpm test:thinking` 启动两个真实进程。`pnpm --filter @writer-agent/web test:thinking` 运行真实 Worker/D1 的浏览器闭环。均不发送真实作品、不读取模型 Secret。

### 回复风格 RAS-001

修改 Thinking 回复风格时只编辑 `harness/architecture/agent-reply-style.md` 的 YAML frontmatter 与人类可读说明，再运行 `pnpm style:sync`。不要直接修改 `reply-style.generated.ts`，也不要在 Prompt 或 Eval 中复制另一套长度和套话规则。`pnpm style:check` 只检查漂移、不写文件；`pnpm test:style` 运行字符/句数/禁用短语单测及 60 条普通、15 条深入分析例外的离线 Eval，CI 会执行这两项门禁。

`pnpm eval:style` 生成 `.local/evals/agent-reply-style/offline-report.json`。离线样本由人工编写，只证明规范、生成代码和评测器协同工作，不证明真实模型风格已经改善；`manualPracticalityPassRate=null` 时必须人工标注，不能将自动门槛通过视为文学质量通过。

真实模型检查需显式运行 `pnpm eval:style:live`。它默认只运行 10 条固定代表样本（四类普通讨论各两条、两类深入分析各一条），完整 75 条语料必须在直接调用脚本时加 `--full`。它固定使用已提交的合成样本与隔离的三章合成作品，不允许用 `--input` 替换，不读取或上传真实用户作品；每条样本使用独立会话，输出上限默认为 4096 Token 以容纳明确要求的长分析。

真实 Eval 默认最多接受 10 次样本请求、计入 60,000 Token（完整语料分别为 75 和 450,000）。可用 `--max-calls`、`--max-total-tokens` 和 `--max-output-tokens` 收紧预算；普通回答与深入分析分别报告平均长度，后者不受 150 字门槛限制。已报告 Token 用于计费，统计不完整时使用预留上限而非按零成本处理。每条结果原子写入 `live-report.checkpoint.json`；失败后加 `--resume` 跳过已成功样本，失败请求也占预算，用量未知时拒绝继续扣费。只有该模式会将 `realLLMCalled` 标为 `true`，且报告仍要求人工复核证据、创作价值、长回答完整性，以及结论先行和套话近似指标。不要用固定 HTTP Mock 回复替代此检查。

## 首次手动安装（授权部署时执行）

1. 使用与 Go 相同协议的发布提交，在构建机运行 `pnpm package:agent -- /path/to/new-release`，生成含依赖、dist、两个受控 skills、release.json 的独立目录。发布清单记录 Git revision、主入口 SHA256、协议；若本地未提交修改，先提交，再打包。不要把 Go StateDirectory、作者 Harness 或 `.env` 打进包。
2. 在服务器安装 Node >=22.19.0。创建无登录用户 `writer-agent-pi` 及共享 RPC 组 `writer-agent-pi-rpc`；仅 `writer-agent` 与 `writer-agent-pi` 加入 RPC 组。`/etc/writer-agent-pi-rpc` root:该组 0750，service.token 0640。签名 Key 放 `/etc/writer-agent/pi-capability.key`，root:writer-agent 0640；Pi 用户不能读取。`/etc/writer-agent-pi` root:writer-agent-pi 0750，agent.env 0640，填入真实模型凭证。
3. 将完整发布目录放 `/opt/writer-agent-pi/releases/<revision>`，root 所有、服务用户只读；使用临时 symlink + rename 将 `current` 指向它。先运行 `node scripts/deploy/verify-pi-release.mjs /opt/writer-agent-pi/current`，再在服务身份和受保护环境中执行 `node .../dist/main.js --check-config`。验证缺少凭证时拒绝启动、配置披露与预期相同。不要打印环境文件。
4. 复制 `scripts/deploy/systemd/writer-agent-pi.service`。Go API 的 systemd drop-in 增加 `SupplementaryGroups=writer-agent-pi-rpc`；在现有 API env 添加 pi-go 示例的变量，保留原认证配置。先部署本 PR 对应 Go 二进制，重启 API，确认写作/保存正常、`127.0.0.1:8791` 工具监听仅本地。未启用时 Go 完全不监听该端口；配置错误时 Thinking 关闭，写作不受影响。
5. `systemctl daemon-reload` 后只启动 `writer-agent-pi`。Go Worker 不变。通过 `systemctl show` 核对 User/CPUQuota/MemoryMax、独立状态目录；`ss -ltnp` 核对 8790/8791 仅 loopback；公网 Caddy 仍仅转发 8787，**不要**代理 `/internal` 或新开安全组端口。实际目录有自定义路径时，相应扩展 unit 的 InaccessiblePaths，验证 Pi 用户无法读取所有 Go 状态/备份和 Harness。
6. 以服务身份执行 `node .../dist/main.js --healthcheck`。健康响应含 `thinking-v1`、发布 revision 与模型披露，不能含 Key。作者登录后先用隔离作品验证确认范围→思考→取消→刷新。再验证 Agent 停机时保存仍正常，以及离线删除会话恢复后清除。首次向外部模型发送真实材料仍须作者在 UI 明确确认。

模型配置变更需重启 Pi，旧会话只读保留；继续执行会返回 MODEL_REAUTHORIZATION_REQUIRED，作者新建会话确认新模型。不要修改既有 grant 让旧会话悄悄改用模型。

## 回滚与恢复

停止 Pi；私有状态目录做权限保持的完整备份。原子切回兼容发布 symlink，验证清单、配置、健康，再启动。不要回滚状态快照覆盖现有删除墓碑或恢复已经删除的讨论。当前 schema=1，可靠性增量包含 Run/lease/checkpoint/授权版本；旧 Pi 的严格 Session 校验不能直接读取新增字段。回滚先关闭 Thinking，保留最新状态，使用兼容版本；参见 [可靠性迁移与回滚](../reviews/agent-reliability-review.md)。Pi 无法启动时保留关闭状态，Go 继续写作。

正常退出会取消正在执行的请求，已接受消息/预算已落盘。SIGKILL 后 running 消息变为 interrupted，保留历史，不自动付费重跑。作者可在 UI 确认潜在额外费用后，从安全业务检查点 Resume；取消、删除、撤销授权及副作用未知的 Run 不可恢复。上下文超限使用作者确认的续谈要点，原讨论仍可读。存活 PID 的锁不抢占；未知 PID/权限错误或遗留 `.process-lock-admission` 需要运维核验，不按文件年龄删除。Go 文件锁异常残留仍遵循保守人工恢复流程。

删除先撤销 Go grant，再持久排队；每五秒重试 Pi 清理。即使 Node 离线也不能再次调用工具。Node 删除持久墓碑，抹除 transcript、Pi entries 与 events，防止迟到结果或创建重放复活。Session 列表中的孤立初始化 grant 可再次用同键创建或删除，不会发送模型请求。

## 可选真实合成 Eval

`pnpm eval:thinking` 为 Mock；真实模型必须手动执行 `pnpm eval:thinking:live`，只用 `harness/evals/thinking-agent` 中的三章合成材料。默认仅一个问题、最多四次 provider 调用、最多 64,000 保守预留 Token；无自动重试。未提供模型 Key 会拒绝启动。保留 qualityValidated=false，人工复核引用所支持的推断后另存标注；成功返回不代表文学质量验证。
