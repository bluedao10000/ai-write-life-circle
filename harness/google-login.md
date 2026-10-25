# Google 登录与真实 Web API

前端使用 Better Auth 1.7.10 的 Google OAuth。Cloudflare Worker 处理 `/api/auth/*` 和 `/api/session`。D1 `story2u-auth` 保存用户、会话、OAuth account 和 state。作品仍保存在 Go API，D1 不保存小说。

生产构建设置：`VITE_WRITER_AGENT_AUTH=google`、`VITE_WRITER_AGENT_MODE=api`、`VITE_WRITER_AGENT_PROJECT_ID=local`。本地 Demo 与隔离 API 测试不强制登录。

## Google Cloud 配置

创建 OAuth Client，类型为 Web application：

- Authorized JavaScript origin：`https://www.story2u.xyz`
- Authorized redirect URI：`https://www.story2u.xyz/api/auth/google/callback`
- 注册对任何已验证邮箱的 Google 账号开放。应用若仍处于 Testing，Google 只放行 Test users；对外开放前需把 OAuth consent screen 发布为 In production。
- 只请求 Better Auth Google 默认身份 scopes。

## GitHub Actions 配置

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | GOOGLE_CLIENT_ID | Google Web OAuth Client ID |
| Secret | GOOGLE_CLIENT_SECRET | 仅 Worker |
| Secret | BETTER_AUTH_SECRET | 至少 32 字符随机密钥 |
| Secret | WRITER_AGENT_API_TOKEN | 现有 Go API Bearer，仅 Worker |
| Secret | WRITER_AGENT_IDENTITY_PRIVATE_KEY | Ed25519 私钥（base64 PKCS#8），Worker 用它为每个请求签发用户声明 |
| Secret | CLOUDFLARE_API_TOKEN | 现有部署 token，需 D1 权限 |
| Variable | CLOUDFLARE_ACCOUNT_ID | 现有 account |

不要在 Git 或 `VITE_*` 中配置任何 Secret。LLM API key 只在 Go 服务端。

## Cloudflare 回源 TLS

Zone 的 SSL/TLS 模式必须为 Full (strict)。Go API 源站须有有效的 `api.story2u.xyz` HTTPS 证书。不能使用 Flexible，否则可能回源重定向导致「作品服务连接失败」。

## 权限与会话

任何已验证邮箱的 Google 账号都可以登录，每个账号是独立的作者，只能看到和修改自己的作品（SEC-001）。不再有邮箱白名单。

身份链路：

1. Worker 每次 API 请求都重新读取服务端会话，不使用 cookie cache。会话有效期七天；Cookie 为 Secure、HttpOnly、SameSite=Lax。
2. Worker 清除浏览器带来的 Authorization、Cookie、actor 头和 `x-writer-agent-identity`，再注入两样东西：
   - 服务间 Bearer `WRITER_AGENT_API_TOKEN`，证明请求来自 Worker；
   - `x-writer-agent-identity`：用 Ed25519 私钥签名的短期声明（60 秒），内容是 Better Auth 的不可变 `user.id`、邮箱、邮箱是否验证，并绑定本次请求的方法和路径。
3. Go 用 `WRITER_AGENT_IDENTITY_PUBLIC_KEY` 验签，并要求 Bearer 与签名声明同时有效，否则返回 401。每个 `user.id` 映射为独立作者 `u-<sha256 前 32 位十六进制>`。
4. Go 在每个响应上返回 `x-writer-agent-identity-mode: per-user-v1`。Worker 收到不带此头的响应会返回 502，不透传内容，防止误连到仍把所有账号当成同一作者的旧 API。部署 Web 前，workflow 也会检查这个头。

### 旧数据归属

per-user 之前的全部数据（Harness `local` 项目、在线作品、创作资产、会话、知识、审查、发布）属于 `WRITER_AGENT_AUTHOR_ID`。它只由一个账号继承：

- Go 配置 `WRITER_AGENT_LEGACY_OWNER_EMAIL=bluedao10000@gmail.com`。
- 该邮箱（且 Google 标记为已验证）第一次登录时，Go 把它的 `user.id` 原子写入 `state/identity/legacy-owner-v1.json`。之后只按 `user.id` 匹配，不再看邮箱：
  - 换邮箱不会丢失数据；
  - 另一个账号即使拿到同一邮箱，也无法接管。
- 其他新账号一律从空白开始，看不到旧数据。
- 迁移不改写任何作品文件。若要改绑，先停服务，再删除或替换该绑定文件，然后重启。

浏览器端的恢复草稿和选中作品按账号分区（SEC-002）。`/api/session` 返回一个由 `user.id` 派生的不透明 `scope`，只用于本地存储键，不是凭据。退出登录会删除当前账号在此浏览器的本地草稿和会话状态；退出前会提示还有几章未保存。

## 验证与回滚

`pnpm --filter @writer-agent/web test` 包含前端测试和 SQLite 会话代理测试。`test:auth:runtime` 在 workerd + D1 中验证 OAuth 发起、签名会话、退出和 API 代理。

发布后须完成以下验证：

1. bluedao10000@gmail.com 登录后能看到原有作品。
2. 换另一个 Google 账号登录，确认它从空白开始，并且看不到上一账号的作品和本地草稿。
3. 两个账号各自完成一次刷新、退出、重新登录。

保留发布前 Worker version ID，回滚可恢复该版本流量。D1 表不删除，作品后端和状态不回滚。D1 含登录身份和 OAuth token，应独立保护。

## 根域名入口

`story2u.xyz/*` 与 `www.story2u.xyz/*` 都绑定同一 Worker。根域名由 Worker 的 canonical guard 308 跳转到 www。只绑定 www 会使根域名继续回源并可能 522。
