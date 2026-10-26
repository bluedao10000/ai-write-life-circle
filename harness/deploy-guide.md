# Go API 与 Agent Worker 生产部署指南

当前支持单机 EC2。身份由两部分组成：服务间 Bearer，加上 Worker 为每个请求签发的 Ed25519 用户声明。每个 Google 账号是独立作者。

API 和 Agent Worker 由 systemd 分进程管理。API 只监听 127.0.0.1:8787，不持有 LLM 密钥；Worker 持有模型配置并执行 Review 与 Knowledge 任务。Caddy 提供 HTTPS 和证书自动续期。保留现有 Web/Nginx，按 API 域名单独路由，不重置旧服务器仓库。

Pi 迁移目标为 API + Pi Thinking + Pi Worker 三个服务，手动安装、归属切换、兼容 Go 回滚见 [Pi 后台执行器流程](workflows/pi-worker.md)。以下双 Go 进程安装器只适用于两类 owner 均为 Go 的兼容发布；Pi/disabled/draining 时拒绝执行，不能用它绕过切换。生产尚未自动迁移。Node 只安装独立运行时与已构建发布包，服务器不运行前端构建或 pnpm install。

## 发布前验证

```sh
go test -C apps/api-go -race ./...
go vet -C apps/api-go ./...
pnpm build:api:go
node scripts/smoke-production-api.mjs
node scripts/smoke-built-api.mjs
pnpm test:api:go
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -C apps/api-go -trimpath -ldflags="-s -w" -o dist/writer-agent-api-linux-amd64 ./cmd/server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -C apps/api-go -trimpath -ldflags="-s -w" -o dist/writer-agent-worker-linux-amd64 ./cmd/agent-worker
```

CI 包含身份和持久化检查，以及现有浏览器 E2E。部署使用已提交并通过检查的源码版本。二进制 release ID 对应其 Git commit。ARM 实例应调整 GOARCH。不要在服务器安装 Node 或 Go 工具链。

## 安装 API

通过 SSH 上传两个 Linux 二进制、`scripts/deploy/install-api-systemd.sh`、`scripts/deploy/systemd/writer-agent-api.service` 和 `scripts/deploy/systemd/writer-agent-worker.service`。在目标服务器执行：

```sh
sudo bash install-api-systemd.sh ./writer-agent-api COMMIT_SHA bruce ./writer-agent-api.service ./writer-agent-worker ./writer-agent-worker.service /path/to/protected-worker.env
```

首次安装前，`/etc/writer-agent/api.env` 必须包含 `WRITER_AGENT_IDENTITY_PUBLIC_KEY`，并应包含 `WRITER_AGENT_LEGACY_OWNER_EMAIL`（见下一节）。缺少公钥时，安装器在停止任何服务之前就会退出。

首次安装必须提前提供权限 0600 的 Worker env，至少设置 `WRITER_AGENT_LLM_API_KEY`（DeepSeek 默认配置）或明确的兼容模型配置。安装器在 service user 下执行 Worker `--check-config`，失败不停止服务；API 所需的公开模型配置由同一份配置生成，不复制密钥。

安装器先停止 Worker、再停止 API，备份完整状态、配置与旧 unit，然后更新 release 软链接，显式重启 API、验证 healthz，再重启 Worker 并等待新心跳。重复部署保留已有令牌、作者配置和数据。已有 release 目录禁止换入不同二进制。失败时尝试恢复旧二进制或 unit。

| 路径 | 内容 |
| --- | --- |
| /opt/writer-agent/releases/COMMIT_SHA | 版本化 API 与 Worker 二进制 |
| /opt/writer-agent/current | 当前版本软链接 |
| /etc/writer-agent/api.env | root-only 生产配置 |
| /etc/writer-agent/worker.env | root-only Worker 配置；真实 LLM 密钥只放在这里 |
| /etc/writer-agent/auth-token | 随机 Bearer 令牌；root:writer-agent 0640 |
| /var/lib/writer-agent | 应用 JSON 与审计状态；writer-agent 0700 |
| /srv/writer-agent/harness | 只读资料根目录；首次部署为空 |
| /var/backups/writer-agent | root-only 一致性备份与回滚记录 |

systemd 以专用无登录用户运行，ProtectSystem=strict、ProtectHome、NoNewPrivileges。只有独立状态目录可写。业务 actor 只来自 Bearer 加有效签名声明。每个 Google `user.id` 是独立作者，旧数据仍归 api.env 中的 `WRITER_AGENT_AUTHOR_ID`。不接受请求自带的角色或 actor 头。

升级或回滚必须同时替换 API 与 Worker 二进制，避免内置旧 Agent 与新 Worker 并发执行同一队列。Worker 不提供公网监听；用 `writer-agent-worker --healthcheck`（加载 worker.env 后）或作者鉴权 `GET /v1/agent-runtime` 核验心跳和配置兼容性；仅 is-active 不足以验收。每个 release 保存 `SHA256SUMS` 和 `manifest`。

## 启用 per-user 身份（一次性）

开放注册前，必须先完成本节，顺序不能颠倒。原因是旧 API 会把所有登录账号当成同一个作者。新 Worker 发现 API 不带 `x-writer-agent-identity-mode: per-user-v1` 时会拒绝转发，Web workflow 也会在预检阶段失败，所以顺序错了只会导致服务暂时不可用，不会让账号看到彼此的数据。

1. 在可信机器上生成密钥对：`node scripts/deploy/generate-identity-keys.mjs ./identity-keys`。
2. 把私钥文件内容保存为 GitHub Actions Secret `WRITER_AGENT_IDENTITY_PRIVATE_KEY`，然后删除本地私钥文件。
3. 在服务器的 `/etc/writer-agent/api.env` 中加入：
   - `WRITER_AGENT_IDENTITY_PUBLIC_KEY=<identity-public.b64 的内容>`
   - `WRITER_AGENT_LEGACY_OWNER_EMAIL=bluedao10000@gmail.com`
4. 用安装器部署新的 API 与 Worker 二进制，然后确认 `curl -sI https://api.story2u.xyz/v1/public/home` 返回 `x-writer-agent-identity-mode: per-user-v1`。
5. 再部署 Web（推送 `apps/web` 或手动运行 Deploy Web）。workflow 不再需要 `WRITER_AGENT_AUTHOR_EMAILS`，可以在 GitHub 和 Cloudflare 中删除这个变量。
6. 用 bluedao10000@gmail.com 登录，确认原有作品都在，并确认 `/var/lib/writer-agent/identity/legacy-owner-v1.json` 已生成。再用另一个 Google 账号登录，确认它从空白开始。
7. 如果 Google OAuth consent screen 仍处于 Testing，只有 Test users 能登录。要全网开放，需在 Google Cloud 把它发布为 In production。

回滚：

- 只回滚 Web 时，旧 Worker 依赖已删除的白名单，所以需要同时恢复 `WRITER_AGENT_AUTHOR_EMAILS`。
- 回滚 Go 到旧版本后，新 Worker 会对所有作品请求返回 502，这是预期的拒绝行为。
- 不要删除绑定文件，除非要改绑旧数据的所有者；改绑时须先停服务。

## AI 点数与紧急开关

所有模型调用按作者计 AI 点数，见 [付费方案](design/pricing-plans.md)。状态保存在 `/var/lib/writer-agent/billing`，随整个状态目录一起备份。需要暂停 Free 档或全部 AI 功能时，以服务用户运行：

```sh
sudo -u writer-agent /opt/writer-agent/current/writer-agent-control --state /var/lib/writer-agent --ai-pause free
```

同一工具可以用 `--free-daily-points` 调整全站 Free 每日池，用 `--billing` 查看当前设置。写作和保存永远不受影响。注意不要以 root 运行：root 写出的文件 API 读不到，会导致 AI 功能全部拒绝。

### 开通方案、加油包与兑换码

在线付款对接之前，用同一工具开通。账户按作者最近一次登录的邮箱查找，所以作者需要先登录并打开过一次作品台。下面以 `C` 代指 `sudo -u writer-agent /opt/writer-agent/current/writer-agent-control --state /var/lib/writer-agent`：

```sh
$C billing usage --email writer@example.com                                  # 查看方案、点数和加油包
$C billing grant --email writer@example.com --plan plus --interval month     # 开通 1 个月 Plus；同一方案再次开通会顺延
$C billing grant --email writer@example.com --plan pro --interval year       # 换成 Pro 年付，从现在开始计算
$C billing grant --email writer@example.com --plan free                      # 撤销开通的方案
$C billing topup --email writer@example.com --points 3000                    # 加油包，12 个月有效
$C billing codes create --kind plan --plan plus --interval month --count 20 --batch beta --expires 2026-12-31
$C billing codes create --kind topup --points 3000 --count 5
$C billing codes list                                                        # 只列摘要和核销状态，不含兑换码本身
```

- 兑换码只在生成时显示一次，状态目录里只存摘要。请通过私下渠道发给作者，作者在页头「AI」→「账户与方案」里兑换。
- 每个账户每天最多输错 10 次兑换码。
- 同一邮箱对应多个账户时，工具会列出 actor ID，改用 `--actor u-…`。
- 旧数据所有者（`WRITER_AGENT_AUTHOR_ID`）在没有开通记录时默认是 Pro。若希望 `usage` 显示这一点，运行前设置同名环境变量。
- 计费文件的锁超过 15 秒视为崩溃遗留，会被自动清理，所以进程异常退出不会长期锁住账户。API 退出时会先等待正在处理的请求和后台扫描完成。

## HTTPS 与既有 Nginx

DNS A 记录指向 EC2 公网地址。公网必须可访问 TCP 80/443。Cloudflare 初次配置建议「仅 DNS」。如使用代理，SSL/TLS 模式必须为 Full (strict)，不能使用 Flexible。API 后端 8787 不向公网开放。

拉取官方 Caddy 并记录测试后的 digest。上传 `install-api-https.sh`、`docker-compose.api-edge.yml`、`Caddyfile.api`、`nginx-api-http.conf.template`，执行：

```sh
sudo bash install-api-https.sh api.example.com /home/ubuntu/nginx/nginx.conf ./docker-compose.api-edge.yml ./Caddyfile.api ./nginx-api-http.conf.template caddy@sha256:TESTED_DIGEST
```

此安装器适配当前 `greenfield-nginx` + `greenfield-net`：保留原 Web server block，新增 API 域名 HTTP→HTTPS 重定向，ACME HTTP-01 请求转发至 Caddy 8080。修改前备份。Caddy 使用 host network 监听 443，连接本机 API。证书与自动续期配置持久化在 /var/lib/writer-agent-caddy。API 不加入原 Web 网络，也不信任代理传入的 actor。

## 验收与访问

- 公网 `GET https://API_DOMAIN/healthz` 返回 200。
- 未带令牌、错误令牌、或只带令牌没有签名用户声明的业务请求，都返回 401。
- 任何响应都带 `x-writer-agent-identity-mode: per-user-v1`。
- HTTP 只重定向 HTTPS，不转发业务写入。生产 internal projection 返回 404。
- 从公网验证证书链、主机名和有效期。重启 API 后验证可用性。测试数据使用隔离状态目录。

作品接口只能经 Worker 访问，因为它需要签名用户声明；直接 curl 只适用于 `/healthz` 和公开接口。不要在任何地方泄露 Bearer 令牌或身份私钥。Web 的 Google 登录与同源 Worker 代理见 [google-login.md](google-login.md)。

## 运维、轮换与回滚

```sh
sudo systemctl status writer-agent-api
sudo journalctl -u writer-agent-api
sudo systemctl status writer-agent-worker
sudo journalctl -u writer-agent-worker
sudo docker logs writer-agent-api-edge   # 不记录 Authorization
```

更新受保护令牌文件后重启即完成轮换。保留稳定作者 ID。

回滚代码时先停 Worker，再停止 API，备份当前完整状态，再将 current 指回上一 release 并启动 API；仅当上一 release 也是独立 Worker 模式时再启动旧 Worker。不要用旧状态覆盖新写入。首次上线没有旧 API 数据，不等于日后无需备份。证书私钥、身份文件和备份都不得进入 Git。

旧 Web/PostgreSQL 的 BUILD_AND_DEPLOY、deploy-simple 等脚本已废弃。GitHub Actions 的 EC2 自动部署仍禁用。本次提供可审计的手动发布路径。

## 当前生产拓扑与版本核对

Google 登录、公开站点、在线作品管理和 SEO 基础均已合并并部署。

- `https://www.story2u.xyz`：Cloudflare Worker SSR、Better Auth/D1 与同源 API 代理；根域名和 HTTP 规范跳转到此入口。
- `https://api.story2u.xyz`：Caddy HTTPS → loopback Go/systemd。后端 Bearer 不进入浏览器。
- 独立 Agent Worker：同一 release 目录的 systemd 进程，持有 Worker env 中的模型凭证，不对外监听。
- 每个 Google 账号是独立作者。per-user 之前的数据由绑定的旧所有者账号继承，见 [google-login.md](google-login.md)。

Web 工作流成功不能证明 Go 已升级。通过 SSH 只读核对 `systemctl is-active writer-agent-api`、`readlink /opt/writer-agent/current`、`sha256sum /opt/writer-agent/current/writer-agent-api`，再分别检查公网 API 健康、匿名私有请求401和可信服务端认证读取；不打印认证配置或令牌。具体核对时间及版本属于单次发布记录，不固定写成永远最新的版本号。

部署顺序按跨版本契约决定：新增后端路由/权限时，先完整备份并验证隔离恢复，再更新 Go，确认接口可用后部署 Worker。新增可选响应字段且旧 Worker 严格拒绝未知字段时，应先部署能兼容读取新旧响应的 Worker/Web，再更新 Go，避免切换窗口503；前端所需接口必须已由现有后端提供。Web 工作流会预检 Public API、per-user 身份头，并确认只带 Bearer 的作品列表请求返回 401。Google 回调 `https://www.story2u.xyz/api/auth/google/callback` 保持不变。

EPUB 导入发布时，Caddy 的 API 入口必须允许至少 66 MB 的 multipart 请求，并给后端代理 120 秒读写窗口；Go 只为导入上传和提交请求延长请求期限，其他 API 仍使用 30 秒基线，并继续强制 64 MiB EPUB、2000 章和逐章 2 MiB 上限。部署 API 后先用合成文本型 EPUB 验证上传预览、确认提交和刷新恢复，再升级 Worker。不要把真实作者作品作为部署 smoke 数据，也不要通过放宽认证或公开 8787 端口排查上传失败。

公开 HTML、API、OG、sitemap 均 no-store。静态 Docker serve 镜像只验证浏览器资源构建。正式公开站使用组合后的 Cloudflare Worker。详见 [公开站点渲染 ADR](architecture/public-site-rendering.md)。

## 在线作品数据

`/var/lib/writer-agent/works/catalog-v1.json` 保存所有权、结构、审计与幂等记录。现有 chapter-drafts、Notes、Review、Publication 目录保存按项目隔离的数据。

备份整个 `/var/lib/writer-agent`，不是只备份 works。外部 Harness 保持只读。后端路由和响应契约的部署顺序遵循上一节的跨版本兼容条件。不自动运行旧数据迁移。回滚二进制时保留升级后的全部结构和草稿；旧代码无法列出这些作品。绝不用较早备份覆盖较新的作者正文。完整分阶段与回滚步骤见 [作品管理 ADR](architecture/author-workspace-management.md)。
