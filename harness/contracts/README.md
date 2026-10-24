# API 契约与来源

当前业务 API 实现十条操作：getWorkspace、updateWorkspaceState、listChapters、getChapter、listChapterRevisions、saveChapterRevision、listAuthorNotes、getAuthorNote、createAuthorNote、updateAuthorNote。

Go 额外实现六条作者证据审查操作（preview、create、list、get、cancel、feedback），标记 `x-runtime: go`。其他操作仍为 proposed。

## 来源与生成

- `source/api-spec-v0.4.0-figma-copy.yaml` 保留完整的早期 Figma Make OpenAPI 3.1 来源，未修改。
- `api-spec-v0.4.0-proposed.yaml` 由旧来源加 Markdown 对齐、Notes 与 Evidence Review 扩展生成。
- `notes-engineering-extension.json` 由共享 Zod Note schema 生成。
- `review-engineering-extension.json` 由 `packages/contracts/src/reviews.ts` 生成。
- `publication-api-v1.json` 是独立 OpenAPI 3.1 工程契约，由 `packages/contracts/src/publication.ts` 生成。

运行 `pnpm openapi:generate`、`pnpm openapi:check`、`pnpm openapi:lint` 做可复现与校验。来源副本绝不重新生成覆盖。

## Markdown 与笔记边界

Chapter DTO 使用精确 Markdown，不用 proposed 来源的 paragraphs[]。保留 2 MiB 上限、不可变修订、baseRevisionId、幂等和关联审计。

NoteCreate 含 content、可选 chapterId、purpose。NoteUpdate 含可编辑字段加 baseVersion、status。POST 和 PATCH 要求 Idempotency-Key，PATCH 还应用乐观锁。过期更新返回 NOTE_VERSION_CONFLICT。

## 生产认证

Go 生产使用 256-bit opaque Bearer token，映射到一个服务端配置的作者 ID 和项目，通过 HTTPS。本地无认证身份仅限 development/test。

## 公开 API

`publication-api-v1.json` 不覆盖 Sprint 3 或 Figma 来源契约。Publication API 使用同一 Go Author Actor/Bearer 边界。公开读取为匿名且只读快照。
