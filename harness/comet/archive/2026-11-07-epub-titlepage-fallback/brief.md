# Outcome

修复文本型 EPUB 的错误章节合并：目录只指向无正文封面页时，预览应按 OPF spine 阅读顺序拆分正文，而不是把全书合并成一个超限章节。该样本的 EPUB 文件只有约 1.6 MiB，但正文拆成 16 个 spine 文件；超过单章 2 MiB 的错误来自导入器采用了不完整目录边界。

# Scope

- 保留单章转换后 Markdown 不超过 2 MiB 的限制。
- 仅当目录项没有指向包含可导入正文的 spine 文档时，按 spine 文件顺序回退切分，并显示目录不可用警告。
- 忽略 EPUB 明确标记的封面和完全空白的目录目标；目录不可用时，标题单独页的标题并入后续首个正文 spine 片段，不单独生成书名章。
- 不按 XHTML 文件名推断封面；保留有效目录指向的章节标题、正文顺序和跨 spine 边界。
- 保留有效 EPUB 目录的现有章节、卷、小节与跨 spine 边界行为。
- 使用合成 EPUB fixture 覆盖封面目录项、多个正文 spine 文件和单章容量边界；不将用户提供的 EPUB 纳入仓库。

## Directory structure

### Created

- `harness/specs/epub-import/spec.md` — 记录 EPUB 导入完整目标行为与本次验收场景。

### Modified

- `apps/api-go/internal/epub/epub.go` — 无正文目录目标不可用时回退至 spine 切分。
- `apps/api-go/internal/epub/epub_test.go` — 添加空封面目录项和容量边界回归。

### Deleted

None

### Not created

- 不创建单独的解析框架、配置开关或扩大单章上限；现有 spine、TOC 解析与容量约束已满足需求。

# Non-goals

- 不提高 2 MiB 单章限制或 64 MiB EPUB 文件限制。
- 不自动猜测目录缺失时的语义章节边界；按 spine 文件边界切分并提示作者核对预览。
- 不改变 EPUB 的正文转换、导入提交、授权或知识抽取流程。
- 不在代码库保存本次提供的小说 EPUB。

# Acceptance examples

- 当 NCX/NAV 只指向无可导入正文的封面页，而 spine 后续包含正文时，预览按 spine 顺序生成正文章节；明确标记或空白封面不生成章节，未标记的标题单独页保留在首个正文片段内，正文完整且不重复，并显示目录不可用提示。
- 当上述回退样本含两个各自转换后小于 2 MiB、合计超过 2 MiB 的正文 spine 文件时，导入成功且分别成为章节；任一单章实际超过 2 MiB 时仍返回 `EPUB_CHAPTER_TOO_LARGE`。
- 当有效目录从仅含章节标题的 spine 文件开始且后续文件承载正文时，标题与后续正文保持同一章节；其他有效目录继续遵循章节边界、卷结构和跨文件范围，原有 EPUB 解析回归通过。
