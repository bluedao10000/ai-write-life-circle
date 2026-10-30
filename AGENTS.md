# Greenfield Adventures - AI Agent 入口

本项目是一个基于 React + TypeScript 的**创意写作协作工具**，提供写作工作台、AI 辅助、实时协作等功能。

## Git 与远程自动化（2026-10-30，取代此前默认推送偏好）

- 本项目仓库为 `git@github-bluedao:bluedao10000/ai-write-life-circle.git`。
- 默认在本地开发分支持续提交，关联修改合并为一个交付批次；完成本地验证后汇报，等待用户明确授权远程发布。
- 推送、合并到 main、创建 PR、触发或重跑远程 Actions 必须获得用户明确授权；授权某一操作不代表授权其他操作。授权批次内无需反复确认。
- 不要每完成一个小任务就推送或创建 PR；需要 PR 时复用同一分支和已授权的现有 PR，禁止自动关闭后重新创建相同 PR，禁止用空提交反复触发检查。
- 不自动提交生成报告、不逐步评论或发送通知；本地汇总结果，用户要求时再发布。
- 账号停用或访问被拒绝时停止远程操作，仅使用本地仓库；不得切换身份、账号、Token、代理等规避 GitHub 限制。
- 避免 GitHub API 轮询和并发请求。确需查询时串行、按需读取并复用结果；必要轮询至少间隔 60 秒且限定总时长。批量写请求至少间隔 1 秒。
- 限流时遵循 `Retry-After` 或 `x-ratelimit-reset`；二级限流无响应头时至少等待 60 秒，指数退避且最多重试 3 次。权限错误、账号停用和非幂等写入结果不明时不自动重试，先汇报。
- 用户当次明确指定其他交付方式时，以当次指令为准。
- 工作流审查与触发矩阵见 [GitHub 自动化审查](harness/reviews/github-automation-audit.md)。

## 🚀 快速理解项目

### 项目定位
- **产品**：Writer Agent 写作工作台
- **技术栈**：React 19 + TypeScript + Vite + TailwindCSS
- **架构**：Monorepo (pnpm) + Docker 部署
- **目标用户**：内容创作者、小说作者

### 项目结构
```
/
├── apps/              # 应用代码
│   ├── web/          # 前端应用（主要）
│   ├── api-go/       # Go 默认后端
├── packages/         # 共享包
│   └── contracts/    # 类型定义
├── harness/          # 文档中心（架构、设计、工作流）
├── scripts/          # 开发、校验与部署工具（deploy/）
├── package.json      # Workspace 根配置
├── pnpm-workspace.yaml  # Workspace 定义
└── tsconfig.base.json   # TypeScript 基础配置
```

### 核心功能
1. 📝 章节编辑器（基于 TipTap）
2. 🤖 AI 对话辅助
3. 📊 提案管理
4. 🔍 内容审查
5. 💾 知识库管理

## 📚 文档索引

### 系统架构
👉 **阅读顺序**：

```
1. 架构概览
   → harness/architecture/architecture.md

2. 前端架构
   → harness/architecture/frontend-architecture.md

3. 适配器模式
   → harness/architecture/adapters.md

4. Harness 映射
   → harness/architecture/harness-mapping.md
```

### 功能设计
👉 **阅读顺序**：

```
1. 设计规范
   → harness/design/figma.md

2. 同步流程
   → harness/design/sync-workflow.md
```

### 运维部署
👉 **阅读顺序**：

```
1. 部署概览
   → harness/deploy-guide.md

2. 详细工作流
   → harness/workflows/deploy.md

3. 安全指南
   → harness/security.md
```

### 工作流
👉 **按需查看**：

参考 `harness/index.md` 查看完整任务路由表。

常用工作流：
- 部署：`harness/workflows/deploy.md`
- 初始化：`harness/workflows/bootstrap.md`
- 审查：`harness/workflows/review.md`

### 开发指南

```
1. 本地开发
   → README.md

2. 项目结构
   → apps/web/README.md (如存在)

3. API 设计
   → harness/data-contract.md
```

## 🎯 AI Agent 工作原则

### 1. 最小上下文加载
- ❌ 不要一次读取所有文档
- ✅ 根据任务需要读取特定文档
- ✅ 通过 `harness/index.md` 路由

### 2. 任务驱动
- 用户说"部署" → 读 `harness/workflows/deploy.md`
- 用户说"架构" → 读 `harness/architecture/`
- 用户说"设计" → 读 `harness/design/`

### 3. 按需扩展
- 基础信息：本文档
- 详细架构：`harness/architecture/`
- 具体工作流：`harness/workflows/`

## 📁 项目结构

```
greenfield-adventures/
├── apps/
│   ├── web/                    # React 前端应用
│   ├── api-go/                 # Go 默认后端
│
├── harness/                    # 📖 文档中心
│   ├── README.md              # 文档导航
│   ├── index.md               # 任务路由
│   ├── architecture/          # 架构文档
│   ├── design/                # 设计文档
│   ├── workflows/             # 工作流
│   └── data-contract.md       # 数据契约
│
├── scripts/                    # 开发、校验与部署工具
│   └── deploy/                # 部署脚本、容器编排与镜像定义
│
├── .github/workflows/          # CI/CD
├── AGENTS.md                   # 📍 你在这里
├── CLAUDE.md                   # Claude Code 入口
├── README.md                   # 项目说明（待更新）
```

## 🔧 技术栈

### 前端
- **框架**：React 19 + TypeScript
- **构建**：Vite 8
- **样式**：TailwindCSS 4
- **编辑器**：TipTap (ProseMirror)
- **状态**：React Hooks

### 后端
- **运行时**：Go 1.27.3 / net/http
- **存储**：Markdown Harness 只读；应用状态为带文件锁的原子 JSON
- **契约**：OpenAPI + 前端 Zod

### 部署
- **容器**：Docker + Docker Compose
- **CI/CD**：GitHub Actions
- **镜像**：AWS ECR
- **服务器**：AWS EC2 (eu-north-1)

## 🎓 学习路径

### 新开发者
1. 阅读 `README.md` 了解项目
2. 阅读 `harness/architecture/architecture.md` 了解架构
3. 阅读 `harness/architecture/frontend-architecture.md` 了解前端
4. 运行 `pnpm install && pnpm dev`

### 部署人员
1. 阅读 `harness/deploy-guide.md`
2. 阅读 `harness/workflows/deploy.md`
3. 阅读 `harness/security.md`
4. 执行部署

### AI Agent
1. 阅读本文档了解项目概览
2. 根据用户任务查 `harness/index.md`
3. 按需读取具体文档
4. 遵循最小上下文原则

## 🔗 外部链接

- **GitHub 仓库**：（开源项目）
- **AWS 区域**：eu-north-1
- **EC2 实例**：16.170.155.138

## 💡 设计理念

### Harness 架构
- **任务路由**：通过 index.md 明确路由
- **最小上下文**：只加载必需文档
- **按需扩展**：根据需要深入细节

### 产品理念
- **作者主导**：AI 辅助，不替代创作
- **证据驱动**：所有建议基于证据
- **可追溯**：记录决策历史

## 📞 获取帮助

### 架构问题
→ `harness/architecture/`

### 功能设计问题
→ `harness/design/`

### 部署问题
→ `harness/deploy-guide.md` 或 `harness/workflows/deploy.md`

### 安全问题
→ `harness/security.md`

---

**版本**：0.2.0  
**最后更新**：2026-10-14  
**架构原则**：Harness 最小上下文加载
