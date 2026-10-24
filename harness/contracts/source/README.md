# V0.4 契约来源

`api-spec-v0.4.0-figma-copy.yaml` 是 Figma Make `docs/contracts/api-spec.yaml` 的完整 OpenAPI 3.1.0 候选。完整副本来自作者回复，未做修改。

`pnpm openapi:generate` 从该来源生成 `../api-spec-v0.4.0-proposed.yaml`。生成的候选为每个操作加 `x-implementation-status`，把章节修订从有损 `paragraphs[]` 改为无损 `markdown`，并记录审计关联字段。`implemented` 表示路由已在 Go 后端（`apps/api-go`）实现。其他操作仍为 `proposed`。
