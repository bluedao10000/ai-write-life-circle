# 部署配置与历史工具

当前入口：

- Web：仓库的 [deploy-web.yml](../../.github/workflows/deploy-web.yml) 构建前端并通过 Wrangler 部署到 Cloudflare Workers，需要相应的 Secrets/Variables。
- Go API：优先按 [生产部署指南](../../harness/deploy-guide.md) 使用 `install-api-systemd.sh` 安装原生二进制，`install-api-https.sh` 配置 HTTPS。身份为 Bearer 加 Worker 签名的每请求用户声明（每个 Google 账号独立，见 `generate-identity-keys.mjs`），所有接口由 loopback API 和 TLS 边缘代理分层处理。
- [deploy-api.yml](../../.github/workflows/deploy-api.yml) 继续构建镜像；旧 EC2 deploy job 保持暂停，避免覆盖手工配置的服务和身份。
- 镜像构建：从仓库根目录使用 `docker build -f scripts/deploy/Dockerfile.api .` 或 `docker build -f scripts/deploy/Dockerfile.web .`。构建成功不代表生产服务可以启动。

## 已废弃的 EC2 Web/PostgreSQL 工具

`BUILD_AND_DEPLOY.sh`、`deploy-simple.sh`、`deploy-ec2.sh`、`upload-to-ec2.sh` 和 `docker-compose.yml` 属于旧 Web/PostgreSQL 方案，不再支持，也不是 Go API 部署入口。旧文档中的相关命令仅作历史记录，不应执行。

`BUILD_AND_DEPLOY.sh` 原来依赖错误的 Dockerfile 相对路径、过时的远端 Compose 路径及镜像名称；现已移除旧执行流程，调用时提示废弃并以状态码 1 退出，不执行构建、上传或远程连接。旧实现可从 Git 历史查阅。其余历史脚本保留原样，未修复或验证；不提供生产部署保证。

## Go API 镜像与当前部署边界

`Dockerfile.api` 使用 Go 1.27.3 多阶段构建和 scratch 运行镜像，只有静态 Go 二进制，没有 Node.js。健康检查为 `/writer-agent-api --healthcheck`，实际请求 `/healthz`。

`docker-compose.prod.yml` 保留 api_state Volume；只读挂载 Markdown 项目根目录（应包含 book/manuscript），可用 WRITER_AGENT_HARNESS_SOURCE 指定外部作品目录。端口仅映射宿主机 loopback；镜像保持旧容器 UID，避免现有 root-owned Volume 需要改权迁移。

`WRITER_AGENT_ENV=production` 必须配置 Bearer 身份、令牌文件和作者 ID，缺少配置时拒绝启动。旧 `docker-compose.prod.yml` 没有挂载身份文件，仍不可直接用于生产启动；其端口映射也不能转发到容器内部 loopback。当前使用宿主机 systemd 运行原生 API，Caddy 在 host network 连接宿主机 loopback。不得改为开发身份或清空 Volume 来恢复部署。

完整本地切换与回滚步骤见 [Go API](../../apps/api-go/README.md)。实际作者状态目录切换前，先停止旧写入服务并备份完整状态目录。

## Webhook 自动部署的密钥要求

`webhook-server.js` 在密钥不可用时拒绝服务，而不是跳过校验：`WEBHOOK_SECRET` 缺失、少于 32 字符、或仍是 `webhook.service` 里的占位值时，所有 `/webhook` 请求返回 503 且不触发部署。`setup-webhook.sh` 用 `openssl rand -hex 32` 生成的 64 位密钥满足要求；手工配置过短密钥的旧部署需要先更换密钥，否则自动部署会停止——这是有意的失败关闭行为。请求体上限默认为 1 MiB，可用 `WEBHOOK_MAX_BODY_BYTES` 调整。回归测试为 `pnpm test:webhook`。
