# Go 后端迁移基线

日期：2026-10-15。分支：codex/writer-agent-go-backend。基线为 PR #6 的 abe53d6。在独立 Worktree 实施，不合并 #6，不改 main。

## 业务操作

十条业务操作：Workspace GET/PATCH；Chapters GET；Chapter GET；Revisions GET/POST；Notes 列表与详情 GET、创建 POST、修改 PATCH。另有 GET /healthz，以及仅 development 暴露的只读 Harness projection。

- Workspace：按 project 与 actor 的 base64url 路径存 JSON。Zod 移除未知字段。
- Chapter：Harness 顶部键值元数据，不是 YAML。完整原文件 SHA-256、Git blob SHA-1、正文 Markdown 分别保留。
- Draft：chapter-drafts/<project>/<chapter>.json，含 sourceHash、sourceRevision、不可变 revisions 与幂等记录。CAS 在锁内检查。
- Note：notes/<project>.json 的 items、requests、audit 一次提交。归档可逆，active next_writing 唯一。
- 响应：no-store、Problem Details、ETag。

## 技术与组织

Go 1.27.3。优先标准库。应用逻辑与 HTTP 解耦。storage 负责文件锁与原子持久化，harness 独立只读。不引入数据库。

apps/api-go 保留独立 cmd/server、cmd/harness。apps/api（Node 实现）已于迁移验收完成后删除。

## 一致性边界与安全

沿用旧 O_EXCL .lock 文件路径。锁等待有界并响应 Context。临时文件同目录、Sync、原子 Rename。

开发入口默认 127.0.0.1。生产环境拒绝 local-author。生产身份仍未选，部署流程保持关闭。

## 验证、切换与回滚（历史记录）

迁移验收采用差分对照测试：规范化随机 UUID、时间、request-id，保留全部业务字段、状态、头和错误。旧 Node 创建数据后停写，Go 直接读取并重放；再以 Node 读取 Go 数据验证回滚。

验收通过后切换到 Go 为唯一后端。Node 实现（`apps/api`）已随迁移验收完成一并删除。最终测试数量、差异和性能数据见验收报告。
