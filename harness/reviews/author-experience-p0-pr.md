作者重新打开已有作品时恢复章节、读写模式和安全的位置元数据；空作品默认灵感并提供“开始写作”。历史版本现在能读取完整正文、对比差异、复制/追加选段，以及确认后恢复为新 Revision，继续复用原有 CAS、幂等与本地草稿保护。

右侧合并为“本章设定”和“审查与注记”，保留证据、反馈、审查历史及独立作者笔记。Free 每账号每 UTC 月可开始 2 次审查：次数与点数共用账本事务；模型前取消可释放，同 Run 重试不重复计次。Free 上下文最多 64 KiB、输出最多 32,768，单次保守预留最多 217 点，仍须完整放入账户日/月及全站 Free 预算；Go/Pi 网关执行同一限制。新增默认关闭且不接受正文或身份字段的聚合指标入口。

依赖：本 PR 以尚未合并的 codex/pricing-phase1-review-fixes（cba465a）为 base，避免混入上一轮计费改动。请先合并基座，再将本 PR 改为 main 并重新运行 CI；不要同时合并 stacked PR。

验证：
- typecheck、lint（0 错误/警告）、build、完整 pnpm test 均通过。
- 最终 Web 206/206、Worker 23/23；变更相关 Go Race 与 Pi 网关 9/9 通过。
- Playwright：管理 13/13、审查 3/3、新桌面/移动完整作者路径 2/2。
- OpenAPI 可重现与 lint 通过；保留文档类告警。全部模型调用为隔离合成 Fixture，没有付费调用或生产数据操作。
- 主应用仍有 >500 kB 构建提示；大章节 Diff 超限保留完整原文，片段恢复采用安全追加章末。真实模型长章节截断率与质量尚未验证。

设计：harness/architecture/author-experience-p0.md
交付、完整修改文件清单和回滚条件：harness/reviews/author-experience-p0-delivery.md

未执行合并或部署。
