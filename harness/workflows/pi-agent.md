# Pi Thinking：开发、手动发布与回滚

本流程只准备独立 Thinking 服务，不迁移 Go Review/Knowledge。自动 EC2 发布保持关闭。当前 PR 不运行本流程中的服务器命令。

## 本地开发

Node >=22.19.0，pnpm 10.15.1。`pnpm install && pnpm build:agent`。

先在工作区之外建立两个不同的随机凭证文件（例如 `openssl rand -hex 32`），权限 0600：服务 Token 供 Go→Pi RPC，能力签名 Key 仅供 Go。不要复用公网 API Token。设置 `scripts/deploy/pi-go.env.example` 中的变量；本地能力 Key 文件和 RPC Token 路径替换为开发路径。Pi 另设 Token 文件、独立 StateDirectory 与 `WRITER_AGENT_PI_LLM_API_KEY`。仅 Pi 需要模型 Key；默认 DeepSeek endpoint/model 为 `https://api.deepseek.com` / `deepseek-flash`。也可显式使用原有 LLM 环境变量；切勿把生产环境文件加载进自动测试。

可分开运行 `pnpm dev:api:go`、`pnpm dev:agent`、`pnpm dev`，或上述配置就绪后运行 `pnpm dev:local -- --agent`。不加 `--agent` 的旧启动方式不变。Agent 崩溃只影响思考；API 和编辑器继续服务。

`pnpm test:agent` 使用实际 SDK 和隔离 HTTP 模型，`pnpm test:thinking` 启动两个真实进程。`pnpm --filter @writer-agent/web test:thinking` 运行真实 Worker/D1 的浏览器闭环。均不发送真实作品、不读取模型 Secret。

## 首次手动安装（授权部署时执行）

1. 使用与 Go 相同协议的发布提交，在构建机运行 `pnpm package:agent -- /path/to/new-release`，生成含依赖、dist、两个受控 skills、release.json 的独立目录。发布清单记录 Git revision、主入口 SHA256、协议；若本地未提交修改，先提交，再打包。不要把 Go StateDirectory、作者 Harness 或 `.env` 打进包。
2. 在服务器安装 Node >=22.19.0。创建无登录用户 `writer-agent-pi` 及共享 RPC 组 `writer-agent-pi-rpc`；仅 `writer-agent` 与 `writer-agent-pi` 加入 RPC 组。`/etc/writer-agent-pi-rpc` root:该组 0750，service.token 0640。签名 Key 放 `/etc/writer-agent/pi-capability.key`，root:writer-agent 0640；Pi 用户不能读取。`/etc/writer-agent-pi` root:writer-agent-pi 0750，agent.env 0640，填入真实模型凭证。
3. 将完整发布目录放 `/opt/writer-agent-pi/releases/<revision>`，root 所有、服务用户只读；使用临时 symlink + rename 将 `current` 指向它。先运行 `node scripts/deploy/verify-pi-release.mjs /opt/writer-agent-pi/current`，再在服务身份和受保护环境中执行 `node .../dist/main.js --check-config`。验证缺少凭证时拒绝启动、配置披露与预期相同。不要打印环境文件。
4. 复制 `scripts/deploy/systemd/writer-agent-pi.service`。Go API 的 systemd drop-in 增加 `SupplementaryGroups=writer-agent-pi-rpc`；在现有 API env 添加 pi-go 示例的变量，保留原认证配置。先部署本 PR 对应 Go 二进制，重启 API，确认写作/保存正常、`127.0.0.1:8791` 工具监听仅本地。未启用时 Go 完全不监听该端口；配置错误时 Thinking 关闭，写作不受影响。
5. `systemctl daemon-reload` 后只启动 `writer-agent-pi`。Go Worker 不变。通过 `systemctl show` 核对 User/CPUQuota/MemoryMax、独立状态目录；`ss -ltnp` 核对 8790/8791 仅 loopback；公网 Caddy 仍仅转发 8787，**不要**代理 `/internal` 或新开安全组端口。实际目录有自定义路径时，相应扩展 unit 的 InaccessiblePaths，验证 Pi 用户无法读取所有 Go 状态/备份和 Harness。
6. 以服务身份执行 `node .../dist/main.js --healthcheck`。健康响应含 `thinking-v1`、发布 revision 与模型披露，不能含 Key。作者登录后先用隔离作品验证确认范围→思考→取消→刷新。再验证 Agent 停机时保存仍正常，以及离线删除会话恢复后清除。首次向外部模型发送真实材料仍须作者在 UI 明确确认。

模型配置变更需重启 Pi，旧会话只读保留；继续执行会返回 MODEL_REAUTHORIZATION_REQUIRED，作者新建会话确认新模型。不要修改既有 grant 让旧会话悄悄改用模型。

## 回滚与恢复

停止 Pi；私有状态目录做权限保持的完整备份。原子切回上一兼容 `thinking-v1` 发布 symlink，验证清单、配置、健康，再启动。不要回滚状态快照覆盖现有删除墓碑或恢复已经删除的讨论。当前 schema=1；未来不兼容升级必须先提供向前/向后兼容验证。Pi 无法启动时保留关闭状态，Go 继续写作。

正常退出会取消正在执行的请求，已接受消息/预算已落盘。SIGKILL 后 running 消息变为 interrupted，保留历史，不自动付费重跑。存活 PID 的锁不抢占；未知 PID/权限错误需要运维核验。Go 文件锁异常残留仍遵循现有保守人工恢复流程。

删除先撤销 Go grant，再持久排队；每五秒重试 Pi 清理。即使 Node 离线也不能再次调用工具。Node 删除持久墓碑，抹除 transcript、Pi entries 与 events，防止迟到结果或创建重放复活。Session 列表中的孤立初始化 grant 可再次用同键创建或删除，不会发送模型请求。

## 可选真实合成 Eval

`pnpm eval:thinking` 为 Mock；真实模型必须手动执行 `pnpm eval:thinking:live`，只用 `harness/evals/thinking-agent` 中的三章合成材料。默认仅一个问题、最多四次 provider 调用、最多 64,000 保守预留 Token；无自动重试。未提供模型 Key 会拒绝启动。保留 qualityValidated=false，人工复核引用所支持的推断后另存标注；成功返回不代表文学质量验证。
