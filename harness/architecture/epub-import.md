# EPUB 导入

Sprint 4.6A/4.6B 将文本型 EPUB 2/3 转成完整作品目录、章节和初始 Revision。导入器只还原原文和结构，不调用模型；知识构建要等作者在「书」中明确授权。

## 数据流与提交点

1. 作者上传 EPUB；Cloudflare Worker 只代理已认证的 multipart 导入路由。
2. Go 以流式读取限制请求大小，解析 ZIP、OPF、spine、EPUB3 Navigation Document 或 EPUB2 NCX。
3. 预览暂存在 `<STATE_DIR>/works/imports/<owner-key>/<import-id>/`，正文按章节保存并校验 Hash。此时作品不会出现在书架。
4. 作者可改书名、卷名和章名。确认请求固定预览 fingerprint 和全部结构 ID。
5. Go 逐章写入私有 `chapter-drafts`，每章包含不可变初始 Revision 和 `knowledgeExtractionIntent`；知识队列仍默认关闭。
6. 全部 Revision 完成并再次校验后，才在短锁内原子更新 `works/catalog-v1.json`。目录写入是作品可见性的唯一提交点。
7. 崩溃发生在目录写入前时，重试复用已完成的 Draft；目录写入后，重试从 Catalog 恢复成功结果。相同上传/提交 Idempotency-Key 不生成重复作品。已提交请求先在 Catalog 锁内读取原回执，即使作者已继续编辑正文，也不会重新准备初始 Revision。
8. 上传、预览恢复、取消和提交共用暂存目录之外的导入级文件锁；提交期间取消需等待，作品可见后拒绝删除导入元数据。

## 解析规则

- spine 决定阅读顺序；目录补齐卷、章节及目录锚点。一个 XHTML 可含多章，一章也可跨多个 spine 文件。
- 明确的卷标题，或“无正文的父目录项 + 指向其他 spine 文件的子章”可作为卷结构；后一种会显示 `TOC_NESTED_STRUCTURE_FLATTENED` 警告。依赖同文件锚点的章节内小节保留在父章正文中。
- 重复目录位置会被去掉；章节以文件与片段位置区分，不按标题去重。
- 按文本节点检查目录范围；第一个锚点之前或结构标题之间未覆盖的实质正文保留为补充章节，按 spine 位置排序并警告。不按章名去重正文。`linear="no"` 的补充内容会产生可见警告。第一版不把非线性脚注内容并入正文，因此不能宣称逐字无遗漏。
- 没有可用目录时按 spine 文件切分并给出警告。
- 支持 UTF-8 与声明为 GBK 的正文；保留段落、标题、强调、引用、列表和插图占位。
- DRM/加密、固定版式、危险路径、重复路径、超限解压量或异常文件类型会失败关闭。

## 限制

| 项目 | 上限 |
| --- | --- |
| EPUB 文件 | 64 MiB |
| 解压总量 | 256 MiB |
| ZIP 条目 | 10,000 |
| 单条目 | 32 MiB |
| 章节数 | 2,000 |
| 单章 Markdown | 2 MiB |

非线性脚注、复杂 CSS 分页、扫描图片 OCR、EPUB 4 和 DRM 不在 Sprint 4.6A/4.6B 范围内。遇到目录部分覆盖或跳过非线性内容，作者必须核对预览；无法确认时不要发布导入结果。

## 验证

- `go test ./internal/epub ./internal/application ./internal/transport`
- `go test -race ./...`
- `pnpm --filter @writer-agent/web test`
- `pnpm openapi:check && pnpm openapi:lint`

Go 测试包含 EPUB 2/3、跨文件与单文件多章、同名章节、嵌套小节、卷、缺目录、GBK、插图、固定版式、非线性警告、300 章初始 Revision 提交与失败重试。前端测试验证预览、修改书名/卷名/章名、幂等键，以及未提交暂存的清理。

## 上传代理边界回归

`bash scripts/test-epub-proxy.sh` 下载并校验官方 Caddy 2.11.7 二进制（与本轮只读核验的生产版本一致），使用仓库 Caddyfile 启动本地代理和隔离 Go API。测试有效 EPUB 恰好为 64 MiB 时返回预览，超过 1 字节时由 Go 返回 `EPUB_SIZE_INVALID` / 413。Caddy 使用 `70MiB`，为 multipart 留出空间；Go 仍限制文件为 64 MiB、整个 multipart 为 65 MiB。CI 显式运行此测试，普通 Go 测试在没有 `CADDY_BIN` 时跳过代理专项测试。
