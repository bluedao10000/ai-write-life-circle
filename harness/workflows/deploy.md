# deploy：API + Pi Thinking + Pi Worker 部署到 EC2

## 最小上下文

- [生产部署指南](../deploy-guide.md)
- [Go API](../../apps/api-go/README.md)
- [部署工具](../../scripts/deploy/README.md)
- [安全红线](../security.md)

## 流程

1. 核对工作树、目标 commit、CI 和服务器进程、监听端口、数据目录。保留旧 Web、其他业务和未提交文件。
2. 验证生产 Bearer 身份、匿名与错误凭证拒绝、固定 actor、重启与数据重放。
3. 交叉编译 Go API、打包 Pi 发布；用 API-only 安装器停用遗留 Go Worker、备份完整状态、更新 API，再原子切换 Pi release 并启动两个 Pi unit。
4. 核对域名 DNS，配置专用 HTTPS 域名与自动续期。不直接开放 8787。
5. 公网验收健康、401/200、证书和 HTTPS 重定向。记录版本、状态路径、备份与回滚步骤，不输出令牌。

旧 EC2 Web/PostgreSQL 工作流仅作历史记录，不执行 deploy-simple 等旧脚本。

## Pi 升级门

先确保 Go API 与 Pi 发布使用同一公共模型指纹和 `agent-tasks-v1`。API 安装器只发布 Go 业务二进制，并移除旧 `writer-agent-worker.service`；Thinking 与 Worker 使用同一已验签 Pi release 的独立 unit。Web CI 认证读取 `GET /v1/studio/books` 并在变更 Cloudflare Worker/D1 前校验其契约。

## 删除作品升级

先同时更新 API 与 Pi Worker，再部署 Web。部署前排空相关任务 lease 并备份完整状态；新版必须共同使用稳定资源锁与删除写入拦截，不能启动旧 Go Worker。用隔离作品验证创建、保存、删除、404、刷新和最后一本的空状态；已有公开作品须先下架。API 启动会恢复持久化的待清理删除，检查日志中的恢复失败提示。回滚须保留删除墓碑与所有新状态，禁止用旧备份恢复已删除作品。

## 发布记录

2026-11-08 发布资料助手（分支 `codex/publication-metadata-assistant`，已合并到 main `e2e506e`）：

- Go API `e969093`，安装器备份 `/var/backups/writer-agent/deploy-sjtEUMw2`；Pi release `0c3ab3d`；Web Worker 版本 `d78768e5-fd05-448c-b7e0-c0cadf6ee201`。
- 首次 Web 部署漏了 `deploy-web.yml` 的生产构建变量，线上直接进入演示模式；按 `VITE_STORY2U_PUBLIC_SITE=true`、`VITE_WRITER_AGENT_AUTH=google`、`VITE_WRITER_AGENT_MODE=api`、`VITE_WRITER_AGENT_PROJECT_ID=local` 重建后重新部署，登录已跳转 Google。手动部署 Web 必须使用同一组变量。
- 验收：三个 unit active；公网 `/healthz` 200；未认证的 `publication-suggest` 返回 401（路由存在）；Pi `POST /internal/v1/generate` 用真实模型返回 200 与 usage；线上 Publish 资源包含新按钮与接口调用。
- 首次 Pi 发布发现生成路径使用了 models 文件之外的 fallback key，生产为空导致 500；`0c3ab3d` 改为选择首个启用条目，与对话执行一致。
- 回滚：API 用安装器备份恢复，Pi 切回上一 release symlink，Web 重新部署上一版本。管理 GET 新增必填 `bookTitle`，新旧 Web 的严格 DTO 各有不接受窗口，本次窗口约 3 分钟；今后同类字段先发布可兼容的 Web。
- 同日章节选择改版：Web Worker 版本 `d9269f96-bae1-4ffa-a42c-4878feaa1970`（分支 `codex/publish-chapter-selection`，已合并到 main `9163fe9`）；生产构建保留 Google AuthGate，线上 Publish 资源包含全选、搜索与分卷选择；API 与 Pi 未变更。
