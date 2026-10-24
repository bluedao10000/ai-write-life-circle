# Writer Agent Go API

默认后端。Go 1.27.3、标准库 HTTP/JSON/文件存储，唯一模块依赖为 Go 官方 `golang.org/x/text`（兼容 Node 的 Unicode 排序与解码）。没有数据库或写入正式 Harness 的通路；可选 LLM 仅用于作者主动授权的连续性审查。

```sh
cd apps/api-go
go test ./...
go test -race ./...
go vet ./...
go build -o dist/writer-agent-api ./cmd/server
./dist/writer-agent-api
```

二进制运行无需 Node.js。开发服务器默认 127.0.0.1:8787。支持 WRITER_AGENT_HARNESS_ROOT、WRITER_AGENT_STATE_DIR、WRITER_AGENT_PROJECT_ID、WRITER_AGENT_API_PORT；STATE_DIR 默认为 ~/.local/share/ai-write-life-circle。WRITER_AGENT_ENV=development/test 默认使用本地身份。production 必须显式设置 WRITER_AGENT_AUTH_MODE=bearer、WRITER_AGENT_AUTH_TOKEN_FILE 和 WRITER_AGENT_AUTHOR_ID；缺少任何一项均拒绝启动。所有模式仍只允许 loopback 绑定，公网访问经过 HTTPS 代理。不要改为公开 local-author 来完成部署。

实现十条业务操作和两个系统入口：Workspace GET/PATCH，Chapters GET，Chapter GET，Revisions GET/POST，Notes 列表/详情 GET、POST/PATCH；GET /healthz；development-only /internal/projects/:projectId/harness-projection。完整请求/响应规范见 [契约](../../harness/contracts/README.md)。身份解析通过 transport.Resolver 注入，运行入口支持本地开发 author 和生产单作者 Bearer 令牌，不信任请求中的角色声明。测试角色服务只在 parity build tag 下编译，不进入正式镜像。

HTTP 对正文实施 32MiB 上限，覆盖 2Mi Unicode 字符的合法 JSON 转义体。Workspace/Revision 的未知字段按旧 Zod 行为移除，Notes 保持严格字段检查。响应、请求 ID、ETag、错误和事务语义与旧实现自动对照；JavaScript Unicode、字符串指纹和原始 Markdown 字节通过 Golden Tests 验证。

旧 Workspace、Draft、Note、Audit、幂等记录使用原路径和格式直接读取，不运行数据重写迁移。跨进程 O_EXCL .lock 协议沿用 Node；临时文件 Sync + Rename，章节审计追加前后保持旧错误语义，Notes 三类记录一次提交。未知遗留锁不自动删除。支持本机 macOS/Linux；多机共享网络文件系统不在本次验收范围。

停止旧 API 写入→备份完整状态目录→启动 Go。不要让两种后端同时写真实目录。回滚时停止 Go，使用 `pnpm dev:api:node` 指向同一目录；已由对照测试验证 Node 可读取并重放 Go 生成的状态。需要调查时，将备份恢复到另一路径，勿覆盖更新的数据。

[迁移基线](../../harness/architecture/go-backend-migration.md)

## 生产身份

生产令牌为密码学随机生成的 32 字节（64 个十六进制字符），放在受保护的普通文件中（0600/0640；禁止软链接、组写和其他用户读取）。以 `Authorization: Bearer <token>` 请求；健康检查无需令牌，业务接口缺少或使用错误令牌返回 401，生产 internal projection 返回 404。不能使用 URL 参数、Cookie 或 X-Actor-* 冒充身份。作者 ID 由服务器配置，所有 Notes 创建者和审计归属于该 ID。

这是单作者部署身份，不是多用户登录系统，也不提供 Agent 凭证。轮换令牌文件并重启服务后，旧令牌失效。不得把令牌放入 Git、前端构建变量、公开页面或访问日志。完整安装、HTTPS、备份和回滚见 [生产部署指南](../../harness/deploy-guide.md)。

## 连续性审查

新增 `internal/llm`（可注入 Client、配置、OpenAI-compatible HTTP）、`internal/review`（只读上下文、精确引文/版本核验、异步运行、独立原子状态）、`transport/review.go`。没有 Agent 框架、工具执行、自动改稿或知识写入。

默认使用 DeepSeek，服务端只需配置 `WRITER_AGENT_LLM_API_KEY`，其余变量可以省略或留空。密钥通过本地环境/服务端 secret 注入，不进入前端、Git 或命令行参数。未设置任何模型连接信息时，审查 capability 仍关闭。

GitHub 仓库 Settings → Secrets and variables → Actions：在 Repository secrets 中设置 `WRITER_AGENT_LLM_API_KEY`；Repository variables 均为可选覆盖项。工作流必须将 secret/vars 显式传给 Go 进程，GitHub 保存配置本身不会改变 EC2 环境。当前历史 API 部署工作流没有下发这些配置，保持暂停；生产 systemd 服务需由部署流程安全更新 `/etc/writer-agent/api.env` 后重启。不要把模型密钥放入 `VITE_*`。

使用其他 OpenAI-compatible 服务时，显式设置地址与模型：

```sh
export WRITER_AGENT_LLM_PROVIDER=openai-compatible
export WRITER_AGENT_LLM_BASE_URL=https://your-provider.example/v1
export WRITER_AGENT_LLM_MODEL=your-supported-model
# 密钥通过本地环境/服务端 secret 配置 WRITER_AGENT_LLM_API_KEY，不进入前端或 Git。
pnpm dev:local
```

Base URL 为 API 前缀，客户端追加 `/chat/completions`。远程服务只允许 HTTPS 且要求密钥；HTTP 仅允许 localhost/loopback，表示 **API 服务器本机**，不是浏览器本机。不跟随重定向，不自动重试。非法显式配置会关闭 capability，不会回退默认值；其他 API 保持可用。正式部署仍需已有 Bearer 认证与 HTTPS。

| 可选变量 | DeepSeek 默认 | 其他显式端点默认 / 范围 |
| --- | --- | --- |
| WRITER_AGENT_LLM_PROVIDER | openai-compatible | openai-compatible |
| WRITER_AGENT_LLM_BASE_URL | https://api.deepseek.com | 必须显式配置 |
| WRITER_AGENT_LLM_MODEL | deepseek-flash | 必须显式配置 |
| WRITER_AGENT_LLM_TIMEOUT_SECONDS | 180 | 60 / 1–180 秒 |
| WRITER_AGENT_LLM_MAX_CONTEXT_BYTES | 65536 | 65536 / 2048–262144；整请求 UTF-8 字节预算，不截断正文 |
| WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS | 未设置 | 兼容旧部署；变量名虽含 TOKENS，实际仍按字节解释 |
| WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS | 131072 | 2048 / 128–131072（DeepSeek 默认 131072） |
| WRITER_AGENT_LLM_RESPONSE_FORMAT | json_object | none；可选 none、json_object、json_schema |
| WRITER_AGENT_LLM_TOKEN_PARAMETER | max_tokens | max_completion_tokens；可选 max_tokens |

DeepSeek 默认规则适用于上述官方地址及其 `/v1` 前缀（允许末尾 `/`）；其他地址不会继承 DeepSeek 模型或请求格式。[DeepSeek 官方接口](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)支持 `max_tokens` 和 `json_object`。知识回填会发送完整章节，候选 JSON 上限为 512 KiB；DeepSeek 单次输出上限设为 131072 Token，HTTP 响应体上限为 1 MiB，另有 180 秒请求上限。该容量已按线上长章修复，但仍需继续观察语义质量和极端章节。

仅支持 Chat Completions 兼容接口，不假设所有服务商支持 JSON Schema 或相同 token 参数。结构化输出参考 [OpenAI 官方说明](https://developers.openai.com/api/docs/guides/structured-outputs)。无论服务商格式模式如何，服务端均执行严格结构和引用核验。

接口均位于 `/v1/projects/:projectId`，仅 author 身份可读写：

- POST `/chapters/:chapterId/review-preview`：固定版本与实际发送范围，无模型调用。
- GET/POST `/chapters/:chapterId/reviews`：历史 / 明确授权后启动（202）。
- GET `/reviews/:runId`：状态、快照、来源新鲜度、发现与反馈。
- POST `/reviews/:runId/cancel`：取消；迟到结果不能覆盖取消状态。
- POST `/reviews/:runId/findings/:findingId/feedback`：四种作者反馈，baseVersion CAS。

启动/取消/反馈要求 Idempotency-Key。预览/启动要求 revisionId、contentHash、reviewTypes；启动额外要求 consent.confirmed=true 和预览的 planHash。来源或模型改变返回 409，需要重新授权。相同幂等键重放返回同一运行；同计划仍在运行时复用任务，已完成后作者可重新授权并用新键创建独立 Run，旧结果与反馈保留。网络响应丢失时，前端同一次授权沿用原键重试；重新预览或显式重新审查才创建新授权键。失败/取消任务也可使用新键重试。

状态在 STATE_DIR/review-runs 下，每项目一个 JSON，权限 0600，原子保存运行/反馈/幂等，不混入 Draft、Notes、Audit 或正式 Harness。备份时包含整个状态目录；Review 快照也含原文，需按作品敏感资料保护。每项目最多 200 个运行、10000 条请求/反馈，达到上限需人工备份归档，不自动删记录。每项目同时一个运行；工作进程重启后原 running 在 deadline 到期读取时转为 interrupted，不自动重新发送作品。跨进程共享状态可协调，但远端进程取消不保证立即终止另一个进程的模型 HTTP 请求，结果仍不会覆盖取消；当前部署以单进程为准。

`pnpm test:review` / `pnpm eval:review` 为真实 HTTP 路径的确定性测试。`pnpm eval:review:live` 显式授权发送合成夹具给配置的真实模型；作者真实作品不用于 CI。用户暂缓真实模型联调，当前不宣称真实 LLM E2E。

审查历史范围与章节目录共用卷分组、卷内排序，按全局位置选择目标之前的章节；卷顺序保持目录的既有规则（Harness 确定性投影中各卷首次出现的顺序），不把卷内 order 当作全书序号。历史相关性使用保存的 Revision 正文；最多读取64个候选（最近32章及更早范围32个均匀样本），最多纳入4章，候选限制可能遗漏远距离证据。Plan/Run 保存 strategyVersion，当前为 continuity-review-v4，参与 planHash 和模型输入；今后改变 Prompt、上下文选择或证据策略时应升级常量。旧状态缺少此字段时读取为 continuity-review-v1，保留原 planHash、记录与作者反馈。

### Publication and public catalog

The default Go server registers its configured project as a Studio book owned by
the configured author. `internal/publication.Service.Books` supports distinct
server-trusted book owners and Harness/App instances; the default executable
currently mounts one project. Production does not fall back to a local author.

- Author GET `/v1/studio/books/:bookId/publication` and `/versions`.
- Author POST `/publication/preview`, `/versions`, `/unlist`, `/relist`.
- Anonymous GET `/v1/public/home`, `/books`, `/books/:slug`,
  `/books/:slug/chapters/:chapterSlug`, `/authors/:slug`, `/categories`.

Publishing requires a persisted preview and exact current saved revisions;
mutations require Idempotency-Key and baseVersionId. A new version contains the
complete selected public chapter set, so omission withdraws a chapter. It never
changes an old version or a draft. Catalog filters: q/category/status/sort,
cursor numeric offset, limit1–100 (default24). All responses are no-store.

State: `WRITER_AGENT_STATE_DIR/publications/state-v1.json`. Back up this directory
with the existing author state. No file is written to Harness. See
[harness/architecture/publication-domain.md](../../harness/architecture/publication-domain.md)
and the separate [OpenAPI](../../harness/contracts/publication-api-v1.json).
Run `pnpm test:publication` for real HTTP/Zod/OpenAPI verification.

## Managed author workspace

Production and development launchers now register the configured legacy project and author-owned online books without restarting the API. External Harness structure remains read-only; online structures are atomic JSON in `<STATE_DIR>/works/catalog-v1.json`. Existing project-scoped Revision, Notes, Review and Publication implementations are reused. No new environment variables, database or systemd write permissions are needed.

- `GET /v1/studio/books`: current author's books; an empty external Harness is omitted.
- `POST /v1/studio/books`: `{ "operation":"create", "baseVersion":0 }`, required Idempotency-Key; atomically creates an unnamed book and first empty source Revision.
- `GET /v1/studio/books/:bookId`: trusted ownership check and full ordered metadata, including archived items and empty volumes.
- `PUT /v1/studio/books/:bookId/structure`: required Idempotency-Key and baseVersion. `rename` changes book title; `chapter` appends a chapter to an optional volume; `volume` creates an empty volume; `structure` submits complete ordered chapter/volume arrays with mutable titles, volume assignment and archive flags. Every existing ID must remain exactly once. Nonempty volumes cannot be archived, and archived volumes cannot receive chapters. No permanent deletion.

All writes are author-only; ownerId, paths and roots are rejected request fields. Structure CAS returns `409 STRUCTURE_CONFLICT` with current metadata. Replays return the original result before CAS. Prose hashes and source Revision IDs remain unchanged across metadata edits. Managed structure fingerprints separately invalidate old review evidence. Existing private archives never change immutable public snapshots.

OpenAPI: `harness/contracts/management-api-v1.json`. See the workspace-management ADR before production upgrade. Back up the entire state tree; reverting code must preserve all new registry/draft writes. The production smoke test exercises anonymous rejection, fixed author identity, managed creation/save/replay, restart and disposable backup restore.

## EPUB import

`POST /v1/studio/imports` accepts an author-only `multipart/form-data` upload. The parser stages a private preview first; the book stays absent from the shelf until the author confirms the title, volume and chapter labels and every initial Revision has been written. The catalog write is the final, short visibility commit. Upload and commit both use Idempotency-Key and safely replay after an ambiguous response or restart.

Limits are 64 MiB compressed, 256 MiB expanded, 10,000 ZIP entries, 2,000 chapters and 2 MiB per imported chapter. Text-first EPUB 2/3 is supported; DRM, fixed-layout and unsafe ZIP content fail closed. A partial TOC or non-linear spine content produces a visible warning instead of silently claiming a lossless import. No model is called. The `knowledgeExtractionIntent` marks imported heads as ready, while knowledge jobs still require explicit author consent.

See [EPUB import architecture and limits](../../harness/architecture/epub-import.md).

## 私有 AI 作品记忆

沿用 WRITER_AGENT_LLM_* 配置，无新增外部服务。每作品默认关闭，作者一次授权后保存自动整理；暂停、预算和回填在「书」中管理。详见 [AI 作品记忆](../../harness/architecture/ai-knowledge-memory.md) 和 [合成 Eval](../../harness/evals/knowledge/README.md)。
