# Pi 后台执行器：安装、验收与维护

本流程用于另行授权的生产操作。开发环境不访问服务器，也不自动部署。

固定拓扑为三个 systemd unit：

- `writer-agent-api.service`：Go 业务 API，监听 loopback `8787`。
- `writer-agent-pi.service`：Pi Thinking，独立用户与状态目录；loopback `8790`，只读工具 RPC `8791`。
- `writer-agent-pi-worker.service`：Review、Knowledge、Creative 后台执行器；loopback `8792` 客户端，不监听公网。

不存在 `writer-agent-worker.service`。API 安装器会停用并移除遗留 unit；不得手工启动旧 Go Worker。

## 发布物

1. 交叉编译 Go API：

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -C apps/api-go -trimpath -ldflags="-s -w" \
  -o dist/writer-agent-api-linux-amd64 ./cmd/server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -C apps/api-go -trimpath -ldflags="-s -w" \
  -o dist/writer-agent-control-linux-amd64 ./cmd/agent-control
```

2. 在已提交的源码上打包 Pi 发布：

```sh
pnpm package:agent -- /secure/build/pi-releases/COMMIT_SHA
```

发布包同时包含 `dist/main.js`（Thinking）与 `dist/worker/main.js`（后台执行），`release.json` 记录 `thinking-v1`、`agent-tasks-v1` 和所有文件哈希。

## 凭证与用户

- `writer-agent`：Go API 与业务状态所有者。
- `writer-agent-pi`：Thinking 用户；加入 `writer-agent-pi-rpc`。
- `writer-agent-pi-worker`：Worker 用户；加入 `writer-agent-pi-task-rpc`。
- Task Token 位于 `/etc/writer-agent-pi-task-rpc/service.token`，root:任务组 0640。
- Thinking RPC Token 与能力签名 Key 不复用 Task Token。
- 模型 Key 只写入 `/etc/writer-agent-pi-worker/worker.env` 或 Thinking 自己的受保护环境；Go API 不持有模型 Key。

可用以下脚本创建 Pi Worker 用户、组、Task Token、环境文件、API 附加组 drop-in 和 unit：

```sh
sudo bash scripts/deploy/install-pi-worker.sh --confirm-install
```

脚本不启动服务、不改变 owner，也不安装发布包。Thinking 用户、RPC 组、`agent.env` 与 `writer-agent-pi.service` 按 [Pi Thinking 流程](pi-agent.md)准备。

## API 环境

首次安装 API 前，`/etc/writer-agent/api.env` 至少要有：

- `WRITER_AGENT_ENV=production`
- `WRITER_AGENT_AUTH_MODE=bearer`
- `WRITER_AGENT_AUTHOR_ID`
- `WRITER_AGENT_IDENTITY_PUBLIC_KEY`
- `WRITER_AGENT_TASK_SERVICE_TOKEN_FILE`
- 与 Pi Worker 完全一致的 `WRITER_AGENT_LLM_PROVIDER`、`WRITER_AGENT_LLM_BASE_URL`、`WRITER_AGENT_LLM_MODEL`、格式、Token 参数、超时与上下文/输出限制

不得加入 `WRITER_AGENT_LLM_API_KEY`。

安装 API：

```sh
sudo bash install-api-systemd.sh \
  ./writer-agent-api COMMIT_SHA author \
  ./writer-agent-api.service ./writer-agent-control
```

安装器只发布 API。它会先停用并删除遗留 `writer-agent-worker.service`，再停止 API、备份完整状态、切换 release、启动 API 并验证 `/healthz`。

## 安装 Pi 发布

1. 将发布目录放到 `/opt/writer-agent-pi/releases/<revision>`，root 所有，服务用户只读。
2. 使用临时 symlink + rename 原子更新 `/opt/writer-agent-pi/current`。
3. 运行发布校验：

```sh
node scripts/deploy/verify-pi-release.mjs /opt/writer-agent-pi/current --worker
```

4. 分别以服务用户和受保护环境执行：

```sh
node /opt/writer-agent-pi/current/dist/main.js --check-config
node /opt/writer-agent-pi/current/dist/worker/main.js --check-config
```

5. 安装或更新三个 unit，执行 `systemctl daemon-reload`，先启动 API，再启动 Thinking 与 Worker。

## 健康与隔离

```sh
systemctl status writer-agent-api writer-agent-pi writer-agent-pi-worker
journalctl -u writer-agent-api
journalctl -u writer-agent-pi
journalctl -u writer-agent-pi-worker
```

同时核验：

- API 的 `/v1/agent-runtime` 中 `review`、`knowledge`、`creative` 都有 owner、epoch、ready、心跳和 Go 侧任务计数。
- Worker `--healthcheck` 成功；仅 `systemctl is-active` 不算验收。
- `ss -ltnp` 只显示 `127.0.0.1:8787/8790/8791/8792`，公网代理只转发 `8787`。
- Pi 用户不能读取 `/var/lib/writer-agent`、Harness、备份或 Thinking 的状态目录。
- 使用隔离合成作品分别验证 Review、Knowledge 和 Creative organize/plan check。

## 维护开关

每个领域可独立 drain 后切换为 `disabled`：

```sh
node scripts/deploy/switch-agent-executor.mjs \
  --confirm-executor-switch --kind review --owner disabled \
  --state /var/lib/writer-agent \
  --control /opt/writer-agent/current/writer-agent-control
```

`knowledge`、`creative` 同理。恢复：

```sh
node scripts/deploy/switch-agent-executor.mjs \
  --confirm-executor-switch --kind review --owner pi \
  --state /var/lib/writer-agent \
  --control /opt/writer-agent/current/writer-agent-control
```

`pi` 目标必须先通过发布校验、服务在线和 Worker healthcheck。切换超时只保留 draining，不会强抢活 lease。旧 owner 即使在持久化文件中为 `go`，读取时也按已迁移的 `pi` 处理；写回后只保留 `pi/disabled`。

## 回滚

- 先通过管理 CLI drain 并停用目标领域，避免旧候选在回滚窗口内提交。
- API 只回滚到仍支持 `agent-tasks-v1` 的版本；安装器不会恢复 Go Worker。
- Pi 代码回滚使用上一套已验签发布目录；不要删除 Task 状态、业务回执或作者正文。
- Thinking 与后台 Worker 可独立回滚，但共享 Pi 发布时必须重新核验两个协议与配置指纹。
- 不得启动旧 Go Worker，也不得用旧备份覆盖部署后产生的正文或审核结果。

## 模型 Eval

确定性工程 Eval：

```sh
pnpm test:review
pnpm test:knowledge
pnpm test:creative
pnpm test:pi:worker
pnpm test:pi:knowledge
```

真实模型调用仅在明确授权、临时合成数据与费用上限下执行：

```sh
pnpm eval:pi:review:live -- --confirm-fixtures
pnpm eval:pi:knowledge:live -- --confirm-fixtures
```

这些命令不读取作者正文，不自动重试付费调用，也不会由普通 CI 自动执行。
