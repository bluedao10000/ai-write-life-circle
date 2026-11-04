# ADR：Thinking 分层存储

日期：2026-11-04。状态：开发实现，未生产部署。Pi Durable / Pi AI / Chord 固定为 1.5.0，Node >=22.19.0。

## 数据与事务

每个会话保留 `<id>.sqlite`，其中 `writer.thinking` 文档保存授权、费用、执行租约、epoch、请求回执、当前及既往 attempt、消息与讨论摘要。历史事件移到 `<id>.events.sqlite` 的 `thinking_events` 表，以 sessionId/cursor 唯一索引保存 type/payload；分段表记录事件边界与字节数。段最多 2,000 条、32 MiB；单条事件最多 32 MiB。消息读取投影使用独立 messageId/ordinal 索引。

Durable 1.5 的 `Harness.commit` 接受逻辑 Tx；SqliteStorage 在内部提交 SQL 事务，没有向应用开放可以加入该事务的 SQL 连接。使用同一文件的另一个连接也无法获得跨提交原子性。因此使用事务 outbox，两个 SQLite 文件共同组成会话的持久状态。

一次更新在 Durable 事务中检查 epoch/lease、接收连续事件 cursor，并保存业务状态与待发布事件。提交后，事件库在一个 SQL 事务中幂等追加事件并更新消息投影。相同 cursor 的相同内容可重投，不同内容拒绝。随后 Durable 提交确认 cursor 并清空 outbox，最后发布内存快照。每个会话的完整提交流程串行化；投影失败使该会话停止读写，重启先重放待发布事件，再开放服务。费用预留的 write Promise 只有上述流程完成才返回，失败不能继续发送模型请求。

| 中断位置 | 持久事实 | 重启行为 |
| --- | --- | --- |
| 业务事务提交前 | 前一个状态与 cursor | 保持前一个状态 |
| 业务提交后、投影前 | 新状态和 outbox | 使用原 cursor 追加，禁止对外发布未投影状态 |
| 事件追加后、确认前 | 新状态、outbox、已追加事件 | 校验相同 cursor 的内容，幂等重投并确认 |
| 确认后 | 新状态、已确认 cursor、事件库 | 重建消息投影并核对 cursor，再开放读取 |

cursor 在业务事务内与前次持久值比较，只接受从前值加一开始的连续事件；重投不分配新 cursor。事件库确认后的历史是权威数据，不能删除后从空 outbox 重建。消息投影可以由业务状态重建。GET 与 SSE 等待当前提交发布完成，SQL 读取上界受已发布 cursor 限制；内存 watch 不参与持久化判定。Durable 调度开始执行新任务前同样等待发布，避免执行读取尚未公开的租约。

最近消息、分页和事件查询均读取有界 SQL 范围。默认快照 40 条消息，历史页 80 条，full=1 最多 1,000 条；公开事件页 200 条。完整内部事件读取最多 100,000 条，超过时调用方继续按 cursor 翻页。Session State 不保存已发布事件。消息仍是业务权威的一部分，执行准入维持原有 200 条消息上限；本次扩大事件容量，不改变对话消息配额。

状态和单次 outbox 各限 32 MiB。分段元数据保存在事件库，状态文档只保存当前及确认 cursor，避免索引随段数增长。分段是追加表中的逻辑边界；保留全部事件，不自动压缩、过期或删除历史。高频状态更新只复制业务状态和本次新增事件，消息投影仅写入内容发生变化的行。

## 迁移与恢复

旧 JSON 与 manifest 归档先逐段投影，旧 Durable 单文档事件先投影。事件 cursor 与旧状态一致后，再提交 layout=2 的无历史事件状态。迁移前源数据保持有效，重启可以重复投影；投影冲突拒绝启动。新文档提交成功后才清理旧 JSON/归档。旧 accountingVersion 只结算已知费用，未知预留不释放。启动在事件投影恢复之后中断旧执行，不自动调用模型。

兼容 `aa7dfbf` 的单文档 SQLite，以及此前每个文件不超过 32 MiB、合计可超过该值的 JSON 和多段归档。切换 layout 时立即生成 Durable checkpoint，移除 session 文档旧 revisions 中的大型事件基线；普通提交每 64 个 delta checkpoint 一次，已确认 outbox 不会永久重复保留全部历史。迁移不改写框架内部表，checkpoint 通过文档公开配置触发。

删除先持久墓碑，等待执行退出，关闭两个数据库，清理两个文件及 WAL/SHM 与旧归档。重启看到墓碑直接清理，无事件孤儿或会话复活。

## 升级与回滚

1. 按 [Pi 发布流程](../workflows/pi-agent.md) 构建独立发布，保持 Node >=22.19.0 和锁文件中的依赖版本；在隔离环境完成下列验证。
2. 停止 `writer-agent-pi` 并确认进程退出，保留 Go 的取消、删除清理队列。按原权限备份完整 StateDirectory，包括两个 SQLite 文件、各自 WAL/SHM、墓碑及尚未迁移的 JSON/归档；不要在运行时逐文件复制。
3. 在隔离备份副本上启动新版，使用独立状态路径和端口。检查旧 JSON/SQLite 会话、费用预留、取消状态、最近消息、历史页和事件 cursor。此步骤只导入和查询，不提交新模型请求。
4. 切换正式发布，运行 `--check-config`，启动 Thinking，再运行 `--healthcheck`。启动完成意味着 outbox 已排空、投影 cursor 与业务 cursor 一致；检查上述会话数据后开放流量。
5. 若迁移或投影失败，保持 Thinking 停用，保留完整目录，修复后重启。既有业务状态和 outbox 用于恢复，不能靠删除事件库跳过失败。

旧版本不认识 layout=2，不能直接切回旧二进制。回滚使用支持本布局的兼容版本。尚未开放新写入时可以恢复升级前的完整停机备份；已经产生新业务数据时不得以旧备份覆盖费用、回执、取消和删除记录，应修复前滚或使用保留这些记录的离线转换。

## 实现与验证

| 文件 | 职责 |
| --- | --- |
| `apps/agent/src/sessions/store.ts` | 串行事务、outbox、迁移、缓存发布、删除 |
| `apps/agent/src/sessions/event-store.ts`（新增） | SQLite 事件、逻辑分段、消息投影及索引分页 |
| `apps/agent/src/sessions/projection.ts`（新增） | 快照与历史页读取上限 |
| `apps/agent/src/sessions/event-archive.ts` | 逐段读取旧归档 |
| `apps/agent/src/runtime/durable.ts`、`pi-host.ts` | 文档布局、迁移 checkpoint、无历史事件的执行状态读取 |
| `apps/agent/src/server/http.ts` | GET、history、events 和 SSE 的有界读取与发布等待 |
| `apps/agent/test/history.test.ts` | 原有历史与容量迁移回归 |
| `apps/agent/test/event-store.test.ts`、`layered-storage-crash.test.ts`、`migration-checkpoint.test.ts`（新增） | 10 万事件、幂等/冲突、容量、迁移与真实 SIGKILL |
| `apps/agent/test/fixtures/layered-storage-child.ts`（新增） | 在持久提交边界等待 SIGKILL 的真实子进程 |
| `apps/agent/test/projection.test.ts`、`projection-http.test.ts`、`projection-publication.test.ts`（新增） | 消息窗口、协议、分页与失败后拒绝发布 |
| `apps/agent/scripts/benchmark-thinking-storage.ts`（新增） | 1,000 / 10,000 / 100,000 事件基准 |
| 本 ADR（新增）、`agent-reliability.md`、`../workflows/pi-agent.md` | 架构、恢复与运维说明 |

验证命令：`pnpm test:agent`、`pnpm typecheck:agent`、`pnpm --filter @writer-agent/agent lint`、`pnpm build:agent`。Go 跨进程验证先构建 `build:api:go` 和 `build:agent:control`，再运行 `scripts/test-thinking-agent.mjs`、`scripts/test-story-continuity.mjs`、`scripts/test-pi-review-worker.mjs`。fixture 使用本地合成模型。

基准命令：`pnpm --filter @writer-agent/agent exec tsx scripts/benchmark-thinking-storage.ts`。结果写入工作区 `.local/benchmarks/thinking-storage.json` 和 `.md`。每种规模使用独立进程、固定 200 条消息，采样 20 次单条追加和 50 次查询，报告 p50/p95、数据库与 WAL/SHM 增长、重启时间及 RSS/heap。追加计时包含 state 读取、Durable 提交、投影和确认；查询为热读取，重启不清 OS 缓存，内存为 GC 后值而非峰值。该单机合成负载不用于推算生产 SLA。

## 限制

两个数据库须一同备份、迁移和恢复。投影失败采取停止该会话读写并在重启修复的方式，不允许带着不确定状态继续付费；不可恢复的 cursor 或内容冲突会阻止启动。消息历史仍受既有业务上限约束；旧单文档迁移首次需要加载旧文档，此后启动不加载完整事件历史。SQL 操作使用 Node 同步 SQLite，超大单条事件可能阻塞事件循环；当前验证为单会话 10 万事件，不等同于多会话压力验证。Durable 的 Conversation、Task 和其他历史保留策略仍由其存储实现负责。
