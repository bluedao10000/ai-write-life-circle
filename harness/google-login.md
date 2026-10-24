# Google 登录与真实 Web API

前端使用 Better Auth 1.7.10 的 Google OAuth。Cloudflare Worker 处理 `/api/auth/*` 和 `/api/session`。D1 `story2u-auth` 保存用户、会话、OAuth account 和 state。作品仍保存在 Go API，D1 不保存小说。

生产构建设置：`VITE_WRITER_AGENT_AUTH=google`、`VITE_WRITER_AGENT_MODE=api`、`VITE_WRITER_AGENT_PROJECT_ID=local`。本地 Demo 与隔离 API 测试不强制登录。

## Google Cloud 配置

创建 OAuth Client，类型为 Web application：

- Authorized JavaScript origin：`https://www.story2u.xyz`
- Authorized redirect URI：`https://www.story2u.xyz/api/auth/google/callback`
- 应用处于 Testing 时，将允许的邮箱加入 Test users。
- 只请求 Better Auth Google 默认身份 scopes。

## GitHub Actions 配置

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | GOOGLE_CLIENT_ID | Google Web OAuth Client ID |
| Secret | GOOGLE_CLIENT_SECRET | 仅 Worker |
| Secret | BETTER_AUTH_SECRET | 至少 32 字符随机密钥 |
| Variable | WRITER_AGENT_AUTHOR_EMAILS | 逗号分隔的作者邮箱 |
| Secret | WRITER_AGENT_API_TOKEN | 现有 Go API Bearer，仅 Worker |
| Secret | CLOUDFLARE_API_TOKEN | 现有部署 token，需 D1 权限 |
| Variable | CLOUDFLARE_ACCOUNT_ID | 现有 account |

不要在 Git 或 `VITE_*` 中配置任何 Secret。LLM API key 只在 Go 服务端。

## Cloudflare 回源 TLS

Zone 的 SSL/TLS 模式必须为 Full (strict)。Go API 源站须有有效的 `api.story2u.xyz` HTTPS 证书。不能使用 Flexible，否则可能回源重定向导致「作品服务连接失败」。

## 权限与会话

两个授权邮箱共享现有 `local` 项目和固定 Go 作者身份。这是同一作者的账号白名单，不是多租户隔离。

每次 API 请求重新检查服务端会话和白名单，不使用 cookie cache 授权。会话有效期七天。Cookie 为 Secure、HttpOnly、SameSite=Lax。

Worker 只代理固定项目允许的路由，校验写请求 Origin 和 JSON，清除浏览器 Authorization、Cookie、actor 头，并注入后端 Bearer。匿名请求不能读取或写入作品。Go 自身的 Bearer 认证继续保留。

## 验证与回滚

`pnpm --filter @writer-agent/web test` 包含前端测试和 SQLite 会话代理测试。`test:auth:runtime` 在 workerd + D1 中验证 OAuth 发起、签名会话、退出和 API 代理。

发布后须由授权账号完成一次真实 Google 登录、刷新、退出、重新登录，并验证其他账号被拒绝。

保留发布前 Worker version ID，回滚可恢复该版本流量。D1 表不删除，作品后端和状态不回滚。D1 含登录身份和 OAuth token，应独立保护。

## 根域名入口

`story2u.xyz/*` 与 `www.story2u.xyz/*` 都绑定同一 Worker。根域名由 Worker 的 canonical guard 308 跳转到 www。只绑定 www 会使根域名继续回源并可能 522。
