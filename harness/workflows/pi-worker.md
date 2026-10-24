# Pi 后台执行器：手动安装、切换与回滚

本流程仅供另行授权的生产操作；当前开发不运行服务器命令。Thinking 仍使用 [原流程](pi-agent.md)。三个服务分别是 Go API、Pi Thinking、Pi Worker。旧 Go Worker 保留兼容回滚能力，默认 owner 仍为 Go。

## 安装前提

同一发布的 API、Go Worker、agent-control 均须支持 `agent-tasks-v1`；不能让旧版本 Worker 接触已启用 ownership 的状态目录。先停止旧 Worker，备份完整状态并保留权限，再部署兼容二进制。备份用于灾难恢复，不能覆盖部署后的新正文。`--task-protocol` 可在不加载作者数据时核对 Go 二进制。

沿用 `pnpm package:agent` 打包 Node 发布（包括 dist/worker），为 Thinking 和后台服务使用独立用户。新增系统组 `writer-agent-pi-task-rpc`，仅 Go API 与 `writer-agent-pi-worker` 加入。随机服务 Token 放 `/etc/writer-agent-pi-task-rpc/service.token`，目录 0750、文件 root:该组 0640；不得复用公网 API Token、Thinking RPC Token 或能力签名 Key。

`/etc/writer-agent-pi-worker/worker.env` 为 root:writer-agent-pi-worker 0640，参考 `scripts/deploy/pi-worker.env.example`。Go 公共模型参数必须完全一致，Go API 不放模型 Key；Go 环境另加入 pi-tasks-go 示例。旧回滚 Worker 如需模型 Key，仍须在它的独立受保护环境中提供，最终退役后撤销。

复制 `writer-agent-pi-worker.service` 并 daemon-reload。后台用户不挂载、不能读取 Go StateDirectory、Harness、备份和 Thinking 状态；路径自定义时更新 InaccessiblePaths。先验证用户权限与服务 CPU/内存限制，再启动后台服务。8792 只允许 loopback，不配置公网反向代理或安全组端口。Thinking 的独立额度不由后台队列占用。

## 逐类型切换

先以后台服务身份运行 `dist/worker/main.js --check-config` 及 `--healthcheck`。仅进程在线不代表类型已切换。健康检查须显示正确配置；统一 `/v1/agent-runtime` 的 executors.review / executors.knowledge 显示各自 owner、ready 和队列，Thinking 使用自己的 capabilities/health。

人工确认后，以有权读取 Go 状态的运维身份执行：

```sh
node scripts/deploy/switch-agent-executor.mjs --confirm-executor-switch --kind review --owner pi --state /var/lib/writer-agent --control /opt/writer-agent/writer-agent-control
```

脚本先确认目标服务健康，再由 Go CLI 原子 drain、等待有效 Lease 结束、递增 epoch、切换 owner。超时不抢占活 Lease，维持 draining，核验后重试。完成 Review 隔离验收后，再独立切换 knowledge。切换后旧执行器即使存活也无法有效领取/提交。不手工编辑 ownership JSON。

在两类 Pi 执行、预算、故障恢复及回滚均验收后，才能 `systemctl disable --now writer-agent-worker.service`。本次不自动禁用。Go 源码及兼容测试另行保留至实际生产验收后清理。

## 回滚

```sh
node scripts/deploy/rollback-agent-executor.mjs --confirm-executor-switch --kind review --state /var/lib/writer-agent --control /opt/writer-agent/writer-agent-control
```

knowledge 同理。回滚先 drain/fence Pi 类型，再启动兼容 Go Worker；另一类型不受影响。不得直接启动旧 Go 二进制来绕过归属。不得恢复旧状态覆盖作者新写内容。所有权切回成功但目标服务失败时保留队列，修复服务后继续，不重写业务数据。

## 故障与费用

Node 在 started 持久确认前不发送模型请求。可能已发送而 Usage 未知时，保守保留预留费用。Node 不自动重试模型；重试任务由 Go 决定，可能产生新的模型费用。Complete HTTP 传输重试复用相同请求，领域回执确保不重复提交/结算。Lease 失效、取消、暂停、Revision 改变或删除后，迟到输出无法生效。文件锁异常残留仍由运维核验，不按超时自动抢占。

安装资源可用 `sudo bash scripts/deploy/install-pi-worker.sh --confirm-install` 准备。脚本保留既有凭证与环境，不自动启动、启用服务或改变归属；它新增专用用户、RPC 组、API 附加组 drop-in 和 unit。配置完成后的 API 重启仍按现有部署预检执行。切回 Go 时脚本先核对固定发布路径中的 Go Worker `--task-protocol`，拒绝不兼容旧二进制。

## 手动 Pi 真实模型 Eval

仅在明确准备调用付费模型时，配置本地 `WRITER_AGENT_LLM_API_KEY`，可选 BASE_URL/MODEL/RESPONSE_FORMAT/TOKEN_PARAMETER，然后执行：

```sh
pnpm eval:pi:review:live -- --confirm-fixtures
pnpm eval:pi:knowledge:live -- --confirm-fixtures
```

不带确认参数或缺 Key 时拒绝；仅使用临时合成章节及临时 Go 状态，不接触作者目录。单轮最多两次模型调用、100,000 保守预留 Token、每次输出上限 2,048 Token，无模型自动重试。Go 仍校验候选和证据。`WRITER_AGENT_PI_EVAL_OUTPUT` 可指定私有 JSON 输出路径（0600）；默认终端只显示任务元数据/Usage，不打印正文或模型 Key。输出始终 qualityValidated=false，人工标注另存。这些命令不会由 CI 自动运行，本次未运行付费 Eval。

已有 Go 双进程安装器在 ownership 存在后要求新 API/Worker 支持任务协议，并拒绝 Pi/disabled/draining 归属，防止普通部署绕过人工切换。此安装器更新 API 前须先按上述流程将两类安全切回 Go；也可另行使用经核验的三服务发布流程。失败回滚遇到无法识别 ownership 的旧二进制时，保留 API/Go Worker 停机，不自动启动旧内嵌执行器。作者数据不会恢复为旧备份。
