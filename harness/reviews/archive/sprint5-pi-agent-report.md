# Sprint 5：独立 Pi Thinking Agent 交付报告

基线：`origin/main` 的 `0c12c5c`（已移除旧 Node API）。分支：`codex/sprint5-pi-agent-runtime`。本 Sprint 不合并、不部署生产、不执行付费模型 Eval。`.workbuddy-ai/` 保持原样且不提交。

## 交付与验证

新增独立 `apps/agent`；真实 API 模式的思考界面已接入 Go → Pi Session → 只读 Story Tools → 模型循环。既有 Go Worker 继续独占 Review/Knowledge。Go 的作品/Revision/知识/发布权威边界不变。

本地验证：

- 根 `pnpm test` 通过：完整 Go Race Test、351 项 Review HTTP 检查、原 Go Worker 跨进程恢复、33 项 Publication HTTP 检查、原 Knowledge 合成 Eval、Web 单元及真实 workerd 单元、Pi SDK 与双进程测试。
- 新增前端并发回归后，Web 18 文件 / 132 项测试通过；另有 16 项 workerd 测试通过。验证 A 的迟到取消不能覆盖 B 或清掉 B 的 busy，传输重试保留原 Idempotency-Key。
- `pnpm test:e2e` 全套通过：9 视觉、2 API、3 Review、1认证、1公开阅读、11作品管理、1 Knowledge，以及新增真实 Worker/D1 Thinking 浏览器闭环。
- 新 Pi 测试使用安装的 SDK 与真实 HTTP 协议，不替换 `createAgentSession`：受控 Skill 渐进加载、工具循环、多轮恢复、未注册/Bash 工具拒绝、未知 AGENTS 不加载、输入/会话预算、并发、截止时间、取消、删除墓碑。
- 双进程测试：三个实际保存 Revision 的引用、同键不重复调用、游标/SSE、重启、多轮、旧引用失效标记、SIGKILL 中断恢复、Agent 离线删除会话/作品后最终清除 Node 私有上下文。
- 自动审查收尾回归：Thinking 注册表损坏/锁超时不会阻断公开快照清理；离线能力查询失败仍显示 Go 历史并允许删除；10,000 条删除墓碑不占活跃会话配额，旧幂等键仍不能复活会话。对应 Go Race、前端与真实 Worker/D1 浏览器测试通过。
- TypeScript、Lint、OpenAPI 重现与验证、`go vet` 通过。Lint 保留 main 既有 App.tsx 的一个 hooks warning，没有新增 lint error。
- 独立发布包已生成并校验全部应用文件 SHA256；实际启动发布包验证协议、健康响应的 Git revision、RPC认证和优雅退出通过，没有向模型发请求。
- Mock Eval：Citation Validity=1、三章 Relevant Chapter Recall=1、4次工具调用、完成率=1。人工 Evidence Precision / Unsupported Claim Rate 保持 null，货币费用不伪造；`qualityValidated=false`。

以上是工程证据，不是文学语义质量证明。真实模型调用为 **0**。当前生产部署为 **0**。

## 必答问题

### 1. Pi SDK 使用哪个版本？

固定 `@earendil-works/pi-coding-agent@1.3.0` 与 `@earendil-works/pi-ai@1.3.0`，Node >=22.19.0，锁文件随 PR 提交。以官方 SDK 文档和已安装类型定义核对接口；实际运行 `createAgentSession`、`ModelRuntime`、`SessionManager` 与 Custom Tools。

### 2. 如何禁用默认编码工具？

传入自定义 ResourceLoader：extensions/skills/prompts/themes/AGENTS 均为空；只通过受控工具读取本应用的两个 Skill 文件，不使用默认发现器。`tools` 是精确白名单，显式排除 bash/read/write/edit/grep/find/ls/powershell/mcp__*；启动时断言活动工具集合完全一致。无 MCP、编码扩展、任意 HTTP/文件路径工具。测试中的恶意 Bash 调用无法执行，只能触发工具错误和预算终止。

### 3. Go 与 Pi 如何安全通信？

两个独立 loopback listener：Node 8790 接收 Go RPC，Go 8791 接收能力授权与工具。公网 8787 不安装内部路由，Worker 仅列出 author API。Go→Pi 使用独立服务 Token；Pi→Go 使用 Go HMAC 签发、10分钟过期且 nonce 可撤销的能力，签名 Key 不交给 Node。不复用公网 Bearer，不重定向到其他地址。配置错误关闭 Thinking，不影响正文 API。

### 4. Story Tools 如何验证作者/作品归属？

Go Session Registry 固定 owner/book/model/scopes，工具参数不接受 bookId/authorId/path/URL。每次调用重新 Resolve 所有权，校验签名/期限/nonce，事务内扣工具预算；完成 I/O 后再次授权。章节 ID 只能在已授权作品的可信目录解析。笔记需要独立 notes scope。相关作者、跨作品、路径/额外字段与撤销测试均覆盖。

### 5. Session 如何持久化？

Go 保存元数据、授权、幂等意图与清理队列；Node 独立0700目录保存0600原子 JSON、fsync、rename、事件游标、消息回执和预算。SDK 使用内存 SessionManager，提交 header/entries 到该私有 JSON，恢复时由 SDK重建 context，不生成另一套失控自动 session/训练轨迹目录。单进程锁阻止并发 sidecar；SIGKILL 后 running 明确变 interrupted，不自动重跑。

### 6. Session 如何与 Knowledge 隔离？

会话与压缩摘要仅在 Node 私有目录，既不是 Go Knowledge 断言，也不是作者设定。没有 canon、笔记、正文、发布的写入工具。Thinking consent 不复用 Knowledge 开关；作品删除撤销 grant 并最终清除 Node transcript/entries/events。

### 7. 如何完成多轮 ReAct？

Pi SDK 执行实际模型流，解析 tool calls，调用已注册只读工具，将结果返回同一循环继续推理。后续问题从持久 SDK entries 恢复上下文，保持同一 sessionId。受控角色方法按需加载；模型可以先找相关章、读保存版本，再引用来源分析，作者决定后续方向。

### 8. 如何控制 Token、工具调用和模型成本？

八个显式上限覆盖每请求 provider轮数、工具次数、输入/输出、会话Token、并发、时长、单次工具结果字节。每次 provider调用前，以序列化上下文UTF-8字节+余量估算输入上界，预留输入+最大输出后再发请求；取消、缺失Usage或崩溃不退回未知花费。实际Usage另记，预留不冒充货币费用。无自动重试/切换模型/后台压缩；显式压缩也经过相同预算入口。Provider响应流另有字节上限。

### 9. 如何处理 SSE断线、取消和恢复？

内部支持带id的SSE，浏览器明确使用游标短轮询替代，避开Worker普通代理30秒超时。先持久接受消息返回202，再异步执行；刷新读取snapshot/cursor继续。重复接受键返回原回执。取消先在Go轮换nonce，再Abort Pi与网络；中断/超时保留记录。私有服务离线时提示不可用，编辑和保存仍可独立完成。

### 10. 如何防止 Prompt Injection？

原文、知识、笔记与工具结果都作为数据处理；提示明确区分事实/说法/推断，但关键保护是精确工具白名单、空扩展发现器、Go作者/作品授权、独立系统用户与无Go状态挂载。即使模型请求Bash或其他作品，也无执行权限。会话内容不被发送至训练扩展。

### 11. 如何验证证据？

Go 从保存 Revision 生成 sourceId、chapterId/title、revisionId、Hash、精确UTF-16 quote范围；知识保持 epistemic 标记。Node 只关联工具实际返回的sourceId，浏览器读取时Go再次独立核验。不存在的引文不显示为已验证卡片；旧revision标记旧版本。原文位置核验不证明推断成立。选区须先安全保存且在对应Revision唯一定位。

### 12. 哪些功能通过真实模型测试？

本 Sprint 没有调用真实付费模型；没有宣称DeepSeek文学质量验收。提供仅合成材料、单问题、四provider调用/64,000保守Token上限的手动Live Eval入口，等待另行授权执行与人工标注。

### 13. 哪些只是Mock测试？

当前所有模型输出由隔离OpenAI-compatible HTTP fixture提供。SDK、Go/Node进程、Revision持久化、Worker/D1和浏览器是真实执行；回答文字与模型工具选择是可预测Fixture。Mock指标仅说明工程和引用处理可运行，不代表推理准确性。

### 14. 原Go Worker是否兼容？

保持现有执行器、任务租约、保存Hook、预算、来源校验和恢复路径；没有迁移Review/Knowledge。原Race/HTTP/Worker恢复/Knowledge Eval与浏览器回归均通过。Go默认不依赖Node，未配置Pi仍可单独构建运行。

### 15. Review/Knowledge未来如何迁移？

保留agents/review与agents/knowledge边界说明，本轮不实现第二执行器。未来按领域选择唯一执行器，Go继续持有任务权威、Lease/Fencing、证据验证和结果提交；Pi仅领取授权任务并返回候选。逐域迁移及回滚，避免新旧同时领取。

### 16. 如何独立部署和回滚？

提供手动发布包脚本、release.json（revision/协议/文件SHA256）、验证脚本、独立writer-agent-pi.service及配置示例。独立无登录用户、私有StateDirectory、CPU/内存/Tasks/并发限制、loopback与健康检查。完整步骤在workflows/pi-agent.md；不启用EC2自动部署。回滚仅切换兼容发布，不覆盖删除墓碑或Go数据；Node失败保持Go写作可用。

### 17. 当前风险/限制？

- 尚无真实模型语义质量验证；三章样本不能证明全书理解。
- 相关章节候选上限64、返回8条；长篇远距线索可能遗漏。正文按窗口读取，明确truncated，不静默声称完整。
- 保守Token字节预留可能比实际Usage高；达到上限后需要作者新建确认会话。不是精确提供商账单。
- 私有HTTP设计限同机loopback；跨机器需额外认证TLS方案，不能直接改为公网地址。
- 大笔记/知识结果超过上限会明确失败，需要后续分页体验；Session历史/事件也有硬上限。
- 单sidecar文件锁采取保守恢复；PID复用/权限不明不自动抢占。Go异常残留锁沿用既有人工核验流程。
- SSE只在内部，外部采用短轮询；对话摘要不自动写入正式设定。公网认证与既有作者允许列表不变。

### 18. PR地址？

[PR #21 — Independent Pi Thinking Agent](https://github.com/story2u/ai-write-life-circle/pull/21)。保持 Open，不合并、不部署。
