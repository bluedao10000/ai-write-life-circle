# Worker historical metrics windows

## 1. Authority and scope

The existing Go AgentTask registry remains authoritative for Worker claims, starts, terminal outcomes, and fixed Creative model-step receipts. The existing private task metrics endpoint and Runtime metrics exporter derive recent windows from those records when read. No second metrics store or persisted field is introduced.

This contract covers the registered Worker task kinds and the five registered read-only Creative plan roles. It does not define metrics for Thinking runs, arbitrary tools, external providers, storage engines, or dynamically created child tasks.

## 2. Windowed projection

Each projection returns two fixed windows in this order: `24h`, then `7d`. The projection captures one UTC `sampledAt` value. An event belongs to a window when its valid RFC3339Nano timestamp is within `[sampledAt - duration, sampledAt]`.

For each fixed task kind, the JSON projection and Prometheus export report:

- `claimed` events bucketed by the persisted `claimed` audit timestamp.
- `started` events bucketed by the persisted `started` audit timestamp.
- `completed`, `failed`, `interrupted`, and `unknown` terminal receipts bucketed by the persisted `terminal` audit timestamp.
- Claim-to-started percentile samples bucketed by the `started` event timestamp.
- Started-to-terminal percentile samples bucketed by the `terminal` event timestamp.

Each latency transition reports its sample count and nearest-rank P50/P95. If no samples exist, the percentile fields are omitted and the sample count is zero. Task outcome classification reuses the existing receipt projection; it does not infer success for an admission without a terminal receipt.

For the five fixed read-only Creative roles, the projection reports:

- Admissions bucketed by each `ModelStepReceipt.At` timestamp.
- Results, result status, usage, and duration percentiles bucketed by the parent task's terminal timestamp. The current receipt stores no independent step-result timestamp; the result is persisted with the terminal report.
- Admission limits as reserved tokens, separate from known input, output, and cached-input usage.
- `unknownUsage` for a terminal role admission whose result has missing usage or no result, with its role token limit in `unknownReservedTokens` as a conservative exposure bound.

Admission and result counts use their own event timestamps and may differ in a window when a task spans the window boundary. Role output is limited to registered role labels.

## 3. Invalid or absent timestamps

An event with a missing, malformed, or future timestamp is excluded from windowed event counts and percentile samples. No timestamp is synthesized from task creation, current state, or another event. Existing lifetime metrics retain their current semantics and are not filtered by these window rules.

## 4. Export and privacy

The private task metrics JSON includes the two window projections. The private Runtime Prometheus exporter emits finite `window`, task-kind, role, state, and transition labels. It never emits task IDs, book IDs, author IDs, session IDs, run IDs, trace IDs, source text, provider payloads, or credentials.

Zero counts may be emitted for fixed states. Missing percentiles are omitted. Unknown usage remains represented by unknown counters and conservative reservation limits; it is never included in known token totals.

## 5. Persistence and limits

Windowed metrics are recalculated from the existing registry on each request. Reopening the same registry and projecting at the same `sampledAt` produces the same values. The current registry retention and book-deletion cleanup determine which receipts remain available; this specification adds no retention policy or all-history guarantee.

The existing lifetime metrics remain available and unchanged. No Worker task protocol, Go business-points accounting, provider request behavior, stored state schema, database, scheduler, or retry policy changes.
