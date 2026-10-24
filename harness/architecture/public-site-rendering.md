# ADR：公开站点渲染

状态：已实现。依赖尚未合并的认证 PR #11。不执行生产部署。

## 方案

保留 React/Vite Studio，在同一 Cloudflare Worker 增加独立 React SSR 入口。构建生成浏览器 assets 与可独立验证的 dist-server/public.js。没有新增 Node API、框架迁移或微服务。

入口先做 canonical origin 检查，再对白名单公开页面或 API 执行匿名只读处理。其他 API 进入同一 Better Auth/D1 会话链。出版管理路由必须通过会话、同源检查、项目白名单，再由 Go 检查 author 与 ownership。

## SSR 与安全

SSR 只请求 Go Public API 的白名单 DTO，不携带 Cookie、客户端 Authorization 或后端 Bearer。公开正文使用安全 Markdown，禁止 raw HTML，拒绝危险 URL。HTML、JSON-LD、hydration JSON 分别转义。

逐请求渲染，不缓存公开 HTML、API、sitemap、OG，全部 no-store。下架或撤回后的新源站请求立即按当前指针返回 404。

作品、章节、作者具有独立真实 URL 与 title、description、canonical、OG。动态 sitemap 只枚举当前 listed 快照。Discover 搜索与筛选 noindex。Studio 与预览 X-Robots-Tag:noindex。

## 部署顺序

新版 Go API → 验证匿名 `/v1/public/home` 契约 → Web。旧 API 不兼容时在 D1/Worker 变更前停止。现有生产 Go Bearer 保护保留。

## 验证

真实 Go HTTP 契约、禁用 JS 的浏览器、直接 HTML HTTP、SSR 单元测试、真实 workerd+D1 的匿名 SSR 与授权出版路由。自动化使用隔离合成章节与本地会话。

路由由独立的 `site/routes.ts` 共享。Worker 在 ASSETS 之前拒绝未知导航。
