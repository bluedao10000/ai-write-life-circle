# deploy：Go API 部署到 EC2

## 最小上下文

- [生产部署指南](../deploy-guide.md)
- [Go API](../../apps/api-go/README.md)
- [部署工具](../../scripts/deploy/README.md)
- [安全红线](../security.md)

## 流程

1. 核对工作树、目标 commit、CI 和服务器进程、监听端口、数据目录。保留旧 Web、其他业务和未提交文件。
2. 验证生产 Bearer 身份、匿名与错误凭证拒绝、固定 actor、重启与数据重放。
3. 交叉编译并上传 Linux 二进制，运行 systemd 安装器：停止旧 API、备份完整状态、更新版本、健康检查。
4. 核对域名 DNS，配置专用 HTTPS 域名与自动续期。不直接开放 8787。
5. 公网验收健康、401/200、证书和 HTTPS 重定向。记录版本、状态路径、备份与回滚步骤，不输出令牌。

旧 EC2 Web/PostgreSQL 工作流仅作历史记录，不执行 deploy-simple 等旧脚本。

## Sprint 3.5 升级门

先部署受管理作品的 Go 二进制，再部署 Worker。Web CI 认证读取 `GET /v1/studio/books` 并在变更 Worker/D1 前校验其契约。不需要新的 secret 或变量。StateDirectory 仅现有服务账号可写。完整备份、分阶段验证和回滚规则见 [作品管理 ADR](../architecture/author-workspace-management.md)。

## 删除作品升级

先同时更新 API 与 Agent Worker，再部署 Web。部署前停止两进程并备份完整状态；新版两进程必须共同使用稳定资源锁与删除写入拦截，不能与旧 Worker 混跑。用隔离作品验证创建、保存、删除、404、刷新和最后一本的空状态；已有公开作品须先下架。API 启动会恢复持久化的待清理删除，检查日志中的恢复失败提示。回滚须保留删除墓碑与所有新状态，禁止用旧备份恢复已删除作品。
