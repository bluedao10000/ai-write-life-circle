# Pi Thinking Runtime

状态：Sprint 5 开发；以同一 PR 的代码、测试与报告为验收依据。基线 origin/main 0c12c5c。

## 权威与通信

新增 apps/agent（Node >=22.19、Pi SDK 1.3.0），只执行 Thinking。原 Go Worker 继续独占 Review/Knowledge 执行。Go 仍持有作品和 Session 归属权；Pi 会话正文、执行事件在独立私有目录，Node 不挂载 Go StateDirectory。

Browser → 同源 Worker → Go 作者 API → loopback Pi 服务。Pi → Go 的第二个专用内部 listener，调用白名单只读工具。公网业务 listener 不安装内部工具路由。两个内部方向有独立服务凭证；Go 为每次运行签发短期、固定 owner/book/session/scope/model 的能力凭证。每次工具执行重新验证注册表、Session 状态、授权与预算。

## 会话与任务

Go 登记作者、作品、模型披露、范围、生命周期和幂等键。Node 保存 Pi SessionManager 的会话内容和可重放事件。用户消息先持久接受再后台运行，网络断线不丢会话；事件通过有游标的短轮询交付浏览器，并同时提供 SSE 内部订阅。此降级避开 Cloudflare 普通代理 30 秒超时。安全失败和中断可以通过真实 Resume 接口、费用确认及业务检查点继续，同键不会重复模型调用；取消、删除、撤销授权和副作用未知的 Run 不可恢复，见 [可靠性 ADR](agent-reliability.md)。

删除 Session/作品时先在 Go 撤销访问，再持久记录 Node 清理意图。Node 离线不阻止正文删除；恢复后重试删除直到确认。旧能力立即因 Go 注册表/墓碑失效；Node 在模型结果和工具返回落盘前也重新检查撤销。

## Pi 配置

显式 ResourceLoader：无 extension、无项目/用户配置、无 AGENTS 自动发现、无模板、无 MCP。只注册并启用 Story Tools 和受控 skill 加载工具；不提供文件路径、Shell、写入、编辑或任意联网工具。仅使用私有受控 cwd 与应用配置的模型，关闭默认重试/压缩自动调用。旧手动 SDK 压缩入口已关闭；上下文超限由作者确认续谈要点后重建上下文，完整历史保留，不改知识。

## 数据与预算

每次工具返回标记来源、修订、Hash、UTF-16 引文位置及知识 epistemic 状态。正文仅来自保存 Revision；引用只允许使用已返回的证据 ID，服务端再次验证，不能把命中原文字句当作推断正确。

每请求限制轮次、工具调用、输入/输出、时长、结果字节数与会话 Token；全局并发有界。缺失 Usage 保守扣预算并标记不完整，不静默免费重试或切换模型。日志只记事件元数据、错误码与用量，不记正文、对话、能力凭证和密钥。

## 发布边界

独立 writer-agent-pi.service 使用独立 Unix 用户与私有 StateDirectory，限制内存/CPU/并发，仅 loopback；现有 Go API/Worker 仍能无 Pi 启动。内部协议 thinking-v1。部署前验证应用版本、协议、凭证、模型能力、备份与清理恢复；本 Sprint 仅提供手动部署与回滚支持，不操作生产、不合并 PR、不自动付费 Eval。

未来迁移 Review/Knowledge 时 Go 保留任务租约、证据校验和提交权；按任务类型切换唯一执行器，Pi 只领取受限租约并回传候选输出，迟到结果被 Go fencing 拒绝。
