# GitHub 自动化审查（2026-10-30）

## 范围与结论

仅依据本地仓库检查 5 个 Actions 工作流、scripts/、apps/web/scripts/、AGENTS.md、CLAUDE.md、受版本控制的 .workbuddy 配置与 Git hooks。没有查询仓库 API、运行记录、分支保护、账号状态或线上 Webhook；未推送、创建 PR、部署或触发远程 Actions。公开官方文档与 actionlint 工具下载不涉及项目账号。

本地证据不能确定账号停用原因，也不能证明存在违反政策的行为。全局 Agent 设置、其他工作树的独立配置、GitHub Apps、组织规则和外部自动化不属于本地可证实范围。

## 发现与处理（按严重程度）

| 级别 | 原配置/证据 | 影响与处理 |
| --- | --- | --- |
| P1 | AGENTS.md 原第 8 行要求完成任务默认合并 main 并推送 | 小任务会产生远程 CI 和部署。已替换为本地分支批量提交，推送/合并/PR/dispatch 分别需要明确授权；Claude 入口同步引用。 |
| P1，既有风险 | deploy-web.yml 的 deploy Job 与 CI 独立、没有 needs/同提交成功门禁 | CI 失败时仍可能部署。保留现有生产链路；后续可单独设计同提交质量门禁，需要覆盖直接 main 推送、路径过滤与手动发布，不应简单增加递归 workflow_run。 |
| P2 | ci.yml 原第 5 行的开发分支 push 与第 6–7 行 PR 触发重叠，且原 concurrency 对分支 ref 与 PR number 使用不同组 | 同一次已开 PR 的开发分支更新可产生两套 CI。push 收敛到 main，保留原 PR 目标分支 main、codex/**，保留完整检查。 |
| P2 | deploy-api.yml 原第 8 行 packages/** 未被 Dockerfile.api COPY 使用，镜像发布无 concurrency | 契约变更也会发布相同 API 镜像，多次发布可能争用 latest。移除 packages 路径，增加不可取消的发布串行组、30 分钟构建超时与独立缓存 scope。 |
| P2 | deploy-web.yml 原路径覆盖全部 apps/web/**，遗漏根锁文件、workspace、基础 TS 配置 | 单纯测试/文档变更也部署；仅锁文件变更却漏部署。排除明确测试和 Markdown 路径，补齐根构建输入。工作流自身变更仍触发。 |
| P2 | full-regression.yml 没有 concurrency/显式超时 | 同一 ref 重复手动发起会并行跑完整回归。按 ref 取消旧回归，两个 Job 分别限定 60/30 分钟。不同 ref 可独立验证。 |
| P2 | scripts/deploy/webhook-server.js 对匹配 main 的 push 同步执行旧 Docker 部署，缺少 delivery 去重，分支只取最后一段 | 若仍在线，可与新部署链路重复；refs/heads/foo/main 也会匹配，并可能响应超时导致人工重送。该脚本属于已废弃 EC2 Web/PostgreSQL 方案，不是现行生产链路，本次未重写或启用。账号恢复后人工检查并移除旧 Webhook、停止旧 service；线上是否启用未知。 |
| P3 | Web 声明 deployments: write，但 Wrangler 不创建 GitHub deployment；API 顶层 packages: write | 已删除 Web 多余权限，将包写权限仅授予 build-and-push。其余默认 contents: read。 |
| P3 | eval-knowledge.yml 固定 Go 1.27.2，与 go.mod 1.27.3 不同 | 改为读取 go.mod，避免工具链漂移和潜在二次下载。 |

没有发现 schedule、workflow_run、repository_dispatch、自动 PR 创建/关闭/重建、自动提交或评论工作流，也没有发现脚本直接调用 GitHub REST/GraphQL 或 gh 轮询。不能据此推断外部 Agent 从未做过这些操作。

.workbuddy/settings.json 仅配置本地 Write/Edit 的 Comet phase guard；Git hooks 仅有示例文件，未见生效的推送或 PR 钩子。未修改用户全局配置。

## 触发场景对比

| 场景 | 修改前 | 修改后 |
| --- | --- | --- |
| 原白名单开发分支 push，且有指向 main/codex/** 的 PR | push CI + PR CI | 仅 PR CI |
| 原白名单开发分支 push，无 PR | push CI | 本地验证；授权开 PR 后自动 CI，或明确授权手动 CI |
| 其他开发分支 push，无 PR | 无自动 CI | 相同 |
| 指向 main 或 codex/** 的 PR 新建/更新 | 完整 CI | 相同，名称及测试命令不变 |
| main 普通推送/仅文档推送 | CI | 相同，核心检查不加 paths 过滤 |
| main 仅 packages 变更 | CI + API 镜像 + Web 部署 | CI + Web 部署 |
| main 仅 Web Markdown/e2e/src/test/Playwright/Vitest 配置 | CI + Web 部署 | CI |
| main 仅根 package.json/锁文件/workspace/tsconfig 变更 | CI，但未部署 Web | CI + Web 部署（补齐发布正确性） |
| main Web 运行代码、Worker、migration 变更 | CI + Web 部署 | 相同 |
| main API Go 或 API Dockerfile/原 Compose/工作流变更 | CI + API 镜像 | 相同，镜像发布串行；旧 EC2 Job 仍 if: false |
| 部署工作流自身变更 | 对应部署/镜像工作流 | 相同，可验证部署配置 |
| 手动完整回归，同一 ref 连续发起 | 多套并行 | 保留最新回归，取消旧回归 |
| 手动合成模型 Eval | 有预算的串行执行 | 相同，保持不可取消与现有模型预算 |
| 正在运行的生产 Web 部署期间又推送 | 不取消正在运行的部署 | 相同 |

main 与 PR 的检查分别验证集成结果与 PR 合并结果，不能按 SHA 简单互相替代。保留原 PR base 范围以免破坏既有检查；若未来允许 main 自身作为 PR head 指向 codex/**，仍可能出现 main push 与 PR 两次检查，这属于保留既有集成验证的边界情况。

## 缓存、API 与 Agent

- 保留 pnpm store、Go 模块/构建缓存以及 Docker GHA 缓存，不缓存 node_modules 或绕过 frozen lockfile。没有改写多层测试内重复 build：这些构建与隔离夹具正确性有关，不能仅为次数而跳过。
- scripts 中高频轮询主要针对本地测试 API/模型 mock，不应误当作 GitHub API 调用统一限速；付费模型 Eval 保持手动与原预算。
- prepare-auth-deploy.mjs 对 Cloudflare D1 做串行分页，最多 100 页，遇错即失败，没有无限重试；生产路由验证最多 6 次、间隔 5 秒，属于部署后有界检查。未新增通用自动重试，避免对 D1 创建等非幂等写入重放。
- Agent 入口加入串行按需 API、避免轮询、必要轮询间隔和时长上限、写操作间隔、尊重限流响应头、最多 3 次指数退避规则；账号停用或权限错误时停止，不切换身份/Token。现有仓库没有 GitHub API 客户端，因此无需添加无人使用的限流封装。
- PR 必须明确授权；关联变更复用一批交付和同一 PR，不自动关闭再创建，不制造空提交触发 CI，不逐步发布评论或通知。规则是 Agent 工作约定，不等价于 GitHub 服务器端权限强制。

## 预期收益与风险

每次落在原白名单且已有 PR 的开发分支更新，CI 从 2 次降到 1 次（该场景减少 50%）。每次仅契约修改少 1 次 API 镜像发布；每次命中上述 Web 测试/文档排除条件少 1 次生产部署。同 ref 的重复手动回归减少过时任务的剩余执行时间，不能追回已消耗的分钟数。批量本地提交可以减少远程批次，实际数量需要账号恢复后的真实运行历史评估，不能估算账号级减少百分比。

Web 生产 concurrency 保持 cancel-in-progress: false；API 镜像也采用 false，避免发布途中取消。GitHub 默认并发组只保留一个 pending，新 pending 会替换旧 pending，且不保证顺序；这些发布均以最新状态为目标，不应把它当作逐次迁移队列。D1 原有 additive migration 与生产校验不变。

尚未读取远程分支保护。CI workflow/Job 名称、Job ID、PR base 范围及所有 run 命令保留；没有路径跳过核心检查，但取消开发分支 push 后，无 PR 分支不再自动远程验证。若有外部规则专门依赖这些分支的 push 事件，恢复访问后需核对。没有宣称检查配置或真实部署已在线验证。

## 本地验证

- actionlint v1.7.7：全部 5 个工作流通过（源码安装于 /tmp/story2u-actionlint，未写入仓库；使用 -shellcheck=''，本机无 ShellCheck，因此不包含 ShellCheck 检查）。
- YAML 解析及基于 HEAD 的结构对比通过：5 个工作流的 Job 名称和全部 run 命令保持一致。
- 15 个修改前后触发场景通过 picomatch 本地模拟：包含 PR、开发分支、main 文档、契约、Web 测试、锁文件、Worker、migration、混合变更与工作流自身变更；模拟不能代替 GitHub 事件引擎的线上验证。
- git diff --check 通过。
- 本次仅修改工作流和 Agent/审查文档，未执行应用全套测试、生产探测、Docker 发布、付费模型调用或远程 Actions。应用测试步骤全部保留。

## 官方依据

- [Workflow syntax：路径过滤、权限与 concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)：路径跳过可能使必需检查 Pending，因此本次不对核心 CI 添加路径过滤。
- [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)：避免轮询/并发请求，批量写请求留间隔，按响应头与有上限的退避处理限流。
- [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)：持续在限流期间请求可能导致集成被禁止；账号申诉结果应以 GitHub 通知为准。
