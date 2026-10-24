# Figma 同步工作流

本工作流用于手动同步 Figma 设计。它不安装自动 watcher，不提供双向同步。

## 步骤

1. 检查 `git status`、当前分支和 AGENTS.md 规则。在独立 feature 分支或 worktree 中工作。UI 工作不触碰 `manuscript/`、`book/`、`proposals/`、`decisions/`。
2. 使用 Figma MCP 前加载对应 skill。
3. 读取最新 Figma Make 文件：`get_design_context`，key `kWBOdcae5utBZ6VtBHHXui`，node `0:1`，framework react，language typescript。
4. 调用前确认当前会话中实际可用的工具名。若报告 Unknown tool，检查 MCP 注册，不重试猜测的名称。
5. 读取返回的全部源码与资源。检查 `src/App.tsx`、组件、CSS tokens、types 与当前 app。不复制 `.figma/make` 等 Make 专用运行时文件。
6. 以 Figma 为视觉权威。复用精确的布局、字体、颜色、间距、圆角、assets、交互状态和主题。
7. 组件保持 presentational。工作流状态放 `features`/`hooks`，API 调用放 `services`，Demo 数据放 `mocks`，共享 payload 放 `packages/contracts`。
8. 在桌面视口比较运行页面与 Figma Make 预览，含 Light/Dark 主题。若截图端点不支持 Make，使用可见预览做定性比较，并记录未做像素 diff。
9. 运行 typecheck、lint、tests、build。更新 `figma.md`。
