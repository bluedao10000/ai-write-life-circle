# Outcome

Add fixed recent-history windows to the private Go Worker metrics projection so operators can inspect retained task throughput, task transition latency, and the fixed read-only Creative role results over 24 hours and 7 days. Derive every value from existing task receipts and preserve the current lifetime aggregates.

# Scope

Add two fixed windows, `24h` and `7d`, to the existing `/internal/v1/agent/tasks/metrics` projection and `/internal/v1/runtime/metrics` export. For each fixed Worker task kind, report claimed, started, and terminal outcome counts, plus sample counts and P50/P95 for claim-to-started and started-to-terminal transitions. For the five registered read-only Creative roles, report admissions, terminal results, known and unknown usage, reserved and known tokens, and result duration percentiles.

Window membership uses persisted event timestamps. Claim and start counts use their corresponding audit event time; task outcomes and task completion durations use the terminal audit event time; model-step admissions use the persisted model-step admission time. A role result has no separate timestamp in the current receipt, so its duration and usage are attributed to the task's terminal event.

## Directory structure

### Created

- `specs/worker-history-metrics/spec.md` — behavior and source rules for recent Worker metrics.

### Modified

- `apps/api-go/internal/agenttasks/step_metrics.go` — derive fixed windows from persisted task and role receipts.
- `apps/api-go/internal/agenttasks/runtime_metrics.go` — pass window projections to the existing exporter.
- `apps/api-go/internal/agenttasks/step_metrics_test.go` — verify window boundaries, missing timestamps, restart stability, and unknown usage.
- `apps/api-go/internal/agentruntime/metrics.go` — export finite window labels and samples.
- `apps/api-go/internal/agentruntime/metrics_test.go` — verify window exposition and privacy.
- `harness/architecture/agent-maturity-report.md` — record implementation evidence and the remaining retention limit.

### Deleted

None

### Not created

- A metrics database, event collector, or separate audit ledger — windows are derived from the existing Go task registry.
- Per-task or per-book metric labels — the exporter uses fixed task kinds, roles, states, transitions, and window names.

# Non-goals

- Changing task receipt retention, task scheduling, authorization, billing, or model execution.
- Adding time windows to Thinking run metrics or measuring tool, storage, or external-provider latency.
- Claiming production SLOs, model quality, or complete history beyond the task receipts currently retained by Go.

# Acceptance examples

- A1: A metrics response always contains `24h` and `7d` windows. For every registered Worker task kind, it reports claimed, started, completed, failed, interrupted, and unknown event counts from persisted audit records, along with claim-to-started and started-to-terminal sample counts and P50/P95 values. Empty percentile samples are omitted.
- A2: Each window reports the five registered read-only Creative roles. Admissions use each persisted model-step admission time. Results, status, usage, and duration use the parent task's terminal event time. The projection distinguishes known usage from missing usage, sums known tokens and admitted token limits separately, and never treats unknown usage as zero consumption.
- A3: Windows use the interval `[sampledAt - duration, sampledAt]` from one `sampledAt` captured per projection. Missing, malformed, or future event timestamps do not enter a window. Existing lifetime metrics retain their current values. Reopening the same task registry and projecting at the same `sampledAt` returns the same windows; no task IDs, book IDs, session IDs, or source text appear.
- A4: Go race tests for `agenttasks` and `agentruntime`, plus `pnpm test:runtime`, pass. Runtime tests use local synthetic services and make no external model request. No persisted state schema or Go business-points authority changes.

# Constraints and invariants

- Go's `tasks-v1.json` remains the task and lifecycle authority. Window projections are computed at read time; no second metric ledger is persisted.
- Current lifetime counters and percentiles remain available with their existing semantics.
- Unknown usage remains distinguishable from known token totals. Reserved model-step limits are reported separately from actual usage.
- Export labels are fixed and finite. No task, book, author, session, run, or trace identifiers are exported.
- Window results cover records still present in the existing registry. This change does not add a retention guarantee or alter book-deletion cleanup.

# Decisions

- Use fixed 24-hour and 7-day windows, sampled once per projection. This gives operators comparable recent and weekly views without query parameters or unbounded label values.
- Bucket a role result at the parent terminal event because the current persisted step result has no independent completion timestamp.
- Keep absent, invalid, and future event times out of time-window aggregates instead of synthesizing timestamps.

# Source coverage

The boundary covers the supplied Agent Maturity attachment's §3.2 E completion-time percentile requirement, §7.2 execution and model metrics as applicable to retained Go Worker task receipts and the five registered read-only Creative model roles, and the §7.2 finite-label privacy constraint. The other §3.2 E measures and §7.2 metric families are explicitly outside this Worker history projection; they are classified below so this change does not imply that they are implemented.

| Source item and location | Read status | Content to preserve | Spec location | Acceptance ID | Coverage status | Reason or replacement |
| --- | --- | --- | --- | --- | --- | --- |
| S1: Agent Maturity attachment, §3.2 E, “每个成功任务平均 Token” | complete | Report average tokens for successful tasks. | — | — | non-goal | This projection reports role-level known usage and reservations; it does not derive per-task averages. |
| S2: Agent Maturity attachment, §3.2 E, “平均模型调用次数” | complete | Report average model calls. | — | — | non-goal | Role admissions are counted per fixed role; this change does not calculate task averages. |
| S3: Agent Maturity attachment, §3.2 E, “平均工具调用次数” | complete | Report average tool calls. | — | — | non-goal | Tool execution metrics are outside the retained task and model-step projection. |
| S4: Agent Maturity attachment, §3.2 E, “每任务费用” | complete | Report cost per task. | — | — | non-goal | Business points and final settlement remain in Go; this change does not introduce a cost projection. |
| S5: Agent Maturity attachment, §3.2 E, “P50/P95 完成时间” | complete | Report P50/P95 completion time without presenting limited retained samples as a production SLO. | §2, §5 | A1, A3 | covered | Worker claim-to-start and start-to-terminal percentiles are derived from persisted event times; the report states the retention boundary. |
| S6: Agent Maturity attachment, §3.2 E, “失败任务产生的费用” | complete | Report costs from failed tasks. | — | — | non-goal | This projection has no per-task business-cost source and does not estimate one. |
| S7: Agent Maturity attachment, §3.2 E, “上下文重复率” | complete | Report context duplication. | — | — | non-goal | Context-content analysis is outside this receipt-only metrics projection. |
| S8: Agent Maturity attachment, §7.2 Execution, `runs_started` | complete | Count executions that started from durable lifecycle evidence. | §2 | A1 | covered | Count Worker starts from the persisted `started` audit timestamp. |
| S9: Agent Maturity attachment, §7.2 Execution, `runs_completed` | complete | Count completed executions from durable lifecycle evidence. | §2 | A1 | covered | Count completed Worker outcomes from the persisted terminal audit timestamp. |
| S10: Agent Maturity attachment, §7.2 Execution, `runs_failed` | complete | Count failed executions from durable lifecycle evidence. | §2 | A1 | covered | Count failed Worker outcomes from the persisted terminal audit timestamp. |
| S11: Agent Maturity attachment, §7.2 Execution, `runs_cancelled` | complete | Count cancelled executions distinctly. | — | — | non-goal | Current Worker receipts have no distinct cancelled terminal outcome; this change preserves existing outcome semantics. |
| S12: Agent Maturity attachment, §7.2 Execution, `runs_interrupted` | complete | Count interrupted executions from durable lifecycle evidence. | §2 | A1 | covered | Count interrupted Worker outcomes from the persisted terminal audit timestamp. |
| S13: Agent Maturity attachment, §7.2 Execution, `recovery_count` | complete | Report execution recovery count. | — | — | non-goal | This change derives history windows from existing receipts and does not add a recovery event or recovery counter. |
| S14: Agent Maturity attachment, §7.2 Model, `model_calls` | complete | Count model calls. | §2 | A2 | covered | Count admissions for the five fixed read-only Creative roles from persisted admission timestamps. |
| S15: Agent Maturity attachment, §7.2 Model, `input_tokens` | complete | Report known input token usage. | §2 | A2 | covered | Sum known role input tokens and retain an explicit unknown-usage count. |
| S16: Agent Maturity attachment, §7.2 Model, `output_tokens` | complete | Report known output token usage. | §2 | A2 | covered | Sum known role output tokens and retain an explicit unknown-usage count. |
| S17: Agent Maturity attachment, §7.2 Model, `reservation_tokens` | complete | Report reserved token limits separately from actual usage. | §2 | A2 | covered | Sum admitted role limits separately from known usage. |
| S18: Agent Maturity attachment, §7.2 Model, `unknown_usage_count` | complete | Preserve missing usage as unknown. | §2 | A2 | covered | Count terminal role results with missing usage and never treat them as zero consumption. |
| S19: Agent Maturity attachment, §7.2 Model, `provider_latency` | complete | Report model request latency. | §2 | A2 | covered | Use each persisted model-step duration for role duration percentiles, attributed to the parent terminal event. |
| S20: Agent Maturity attachment, §7.2 Tools, `tool_calls` | complete | Count tool calls. | — | — | non-goal | Tool metrics are outside this fixed Worker role projection. |
| S21: Agent Maturity attachment, §7.2 Tools, `tool_failures` | complete | Count tool failures. | — | — | non-goal | Tool metrics are outside this fixed Worker role projection. |
| S22: Agent Maturity attachment, §7.2 Tools, `tool_timeouts` | complete | Count tool timeouts. | — | — | non-goal | Tool metrics are outside this fixed Worker role projection. |
| S23: Agent Maturity attachment, §7.2 Tools, `tool_replays` | complete | Count tool replays. | — | — | non-goal | Tool metrics are outside this fixed Worker role projection. |
| S24: Agent Maturity attachment, §7.2 Tools, `idempotency_conflicts` | complete | Count tool idempotency conflicts. | — | — | non-goal | Tool metrics are outside this fixed Worker role projection. |
| S25: Agent Maturity attachment, §7.2 Storage, `event_append_latency` | complete | Report event append latency. | — | — | non-goal | Storage-engine latency is outside this task-receipt projection. |
| S26: Agent Maturity attachment, §7.2 Storage, `event_projection_latency` | complete | Report event projection latency. | — | — | non-goal | Storage-engine latency is outside this task-receipt projection. |
| S27: Agent Maturity attachment, §7.2 Storage, `outbox_pending` | complete | Report pending outbox work. | — | — | non-goal | The Go Worker task registry is not an outbox projection. |
| S28: Agent Maturity attachment, §7.2 Storage, `projection_failures` | complete | Report projection failures. | — | — | non-goal | Projection health metrics are outside this task-receipt projection. |
| S29: Agent Maturity attachment, §7.2 Storage, `sqlite_size` | complete | Report SQLite size. | — | — | non-goal | This change does not add or inspect a SQLite store. |
| S30: Agent Maturity attachment, §7.2 Storage, `recovery_duration` | complete | Report storage recovery duration. | — | — | non-goal | Storage recovery instrumentation is outside this task-receipt projection. |
| S31: Agent Maturity attachment, §7.2 Multi-Agent, `child_tasks_created` | complete | Count created child tasks. | — | — | non-goal | The five Creative roles are model steps within one Worker task, not child AgentTasks. |
| S32: Agent Maturity attachment, §7.2 Multi-Agent, `child_tasks_completed` | complete | Count completed child tasks. | — | — | non-goal | The five Creative roles are model steps within one Worker task, not child AgentTasks. |
| S33: Agent Maturity attachment, §7.2 Multi-Agent, `child_tasks_failed` | complete | Count failed child tasks. | — | — | non-goal | The five Creative roles are model steps within one Worker task, not child AgentTasks. |
| S34: Agent Maturity attachment, §7.2 Multi-Agent, `orchestration_duration` | complete | Report multi-agent orchestration duration. | — | — | non-goal | This projection reports role-step durations and does not claim to measure child-task orchestration. |
| S35: Agent Maturity attachment, §7.2 Multi-Agent, `coordination_token_cost` | complete | Report token cost for coordination. | — | — | non-goal | This projection reports known role tokens and reservations without assigning multi-agent cost. |
| S36: Agent Maturity attachment, §7.2, finite metric-label constraint | complete | Use finite metric labels; do not expose `sessionId`, `runId`, or book IDs. | §4 | A3 | covered | Window, kind, role, state, and transition labels are fixed; task and author identifiers remain private. |

# Verification expectations

- `go test -race ./internal/agenttasks ./internal/agentruntime` from `apps/api-go`.
- `pnpm test:runtime` from the repository root; confirm the local process integration reports zero external model calls.
- `git diff --check`.
