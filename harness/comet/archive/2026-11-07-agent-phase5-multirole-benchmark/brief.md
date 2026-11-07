# Outcome

Deliver a fair, reproducible evaluation for the existing default-off Creative read-only five-role plan-check pilot. Single-role and multi-role runs use the same saved chapter revision, provider/model, deadline, and parent token reservation. Deterministic correctness and execution cost are reported separately from semantic quality. Quality remains `null` until valid paired model outputs receive eligible independent judgments.

# Scope

This change closes the Phase 5 comparison gap. It retains the existing Planner, Researcher, Analyst, Critic, and Coordinator roles and the Go AgentTask/Pi Worker execution path.

The parent reservation for a multi-role plan check will match the existing single-role reservation. The five role limits will sum exactly to that parent amount. This preserves the single-role allowance and prevents the pilot from multiplying a task's maximum reservation by five.

Add versioned, content-disjoint development and held-out Creative plan-check cases, a paired benchmark runner, and a report for deterministic outcomes, semantic quality, failures, model calls, known usage, reserved exposure, tool calls, and task/role latency. Reuse the existing evaluation and Judge governance. The plan-check rubric will assess evidence support, assessment accuracy, uncertainty handling, and usefulness to the author. Pairwise order is randomized; deterministic failures remain ineligible regardless of Judge score. Human labels record reviewer agreement. The report separates Agent execution cost from Judge cost and keeps unknown usage and unsupported monetary cost as `null`.

All development checks use localhost synthetic providers. A real-provider path, if enabled by the implementation, must accept only synthetic cases and require explicit fixture and token-budget confirmation. Do not run a real-provider request in this change. Do not claim quality improvement from synthetic output or unlabeled real output. Multi-role execution remains explicitly opt-in and is never enabled automatically from benchmark results.

## Source coverage

Coverage boundary: the controlled multi-agent pilot and its same-budget evaluation, including only the evaluation, runtime governance, security, performance, and delivery requirements needed to implement and assess that pilot. Other Agent roles, Memory work, and Phase 6 autonomy are outside this change.

| Source item and location | Read status | Content to preserve | Spec location | Acceptance ID | Coverage status | Reason or replacement |
| --- | --- | --- | --- | --- | --- | --- |
| Attached request, §3.1–3.4 | complete | Versioned dev/held-out tasks, deterministic grading, separate Judge rubric, explicit live-evaluation budget, and independent human calibration | `specs/orchestration-benchmark/spec.md`, Dataset and scoring | A2, A3 | covered | Reuse the established evaluation runtime and governance |
| Attached request, §5.1 | complete | Roles are logical capabilities; reuse Pi Worker and existing registry | Scope and execution identity | A1, A4 | covered | Existing five-role implementation remains the pilot |
| Attached request, §5.2 | complete | Child execution remains bounded by parent budget, deadline, scope, cancellation, failure isolation, and result contract | Equal parent budget and deterministic eligibility | A1, A4 | covered | Existing Go and Pi authorities remain in force |
| Attached request, §5.3 | complete | Compare single/multi quality, cost, latency, and failures under the same total budget; keep single-role when improvement is unproven | Paired runs, metrics, and activation | A1, A2, A3 | covered | The current fivefold reservation is removed for this pilot |
| Follow-up request, §9.2–9.9 | complete | Shared model/budget governance, read-only role policies, versioned traces, authorization and audit propagation | Governance constraints | A1, A3, A4 | covered | Reuse current gateways, Go receipts, and execution contexts |
| Follow-up request, §10.1–10.3 | complete | Go owns identity, authorization, billing, task authority, and commits; Thinking and Worker remain isolated; no new database/framework | Constraints and execution identity | A1, A4 | covered | No new authority or process is introduced |
| Follow-up request, §11 Phase 5 | complete | Start with Creative research and plan-check; first pilot is read-only and uses existing approval and commit paths | Scope and pilot behavior | A2, A4 | covered | Existing plan-check pilot is the selected task |
| Follow-up request, §12.1 and §12.4 | complete | Comparable single/multi evaluation, bounded child budgets/scopes, cancellation, failure isolation, and no duplicate submissions | Pair validation and safety | A1, A2, A4 | covered | No multi-role result can commit business state |
| Follow-up request, §12.6–12.7 | complete | Exercise process/provider failures and report calls, tokens, P50/P95, and cost without fabricating unknowns | Reliability and metrics | A3, A4 | covered | Local synthetic results remain engineering evidence only |
| Follow-up request, §13 items 1, 3–7, 9–13 | complete | No unnecessary roles, budget or permission expansion, automatic Canon writes, unauthorized side effects, mock quality claims, or Go bypass | Constraints and activation | A1, A3, A4 | covered | Existing approval and business commit boundaries remain authoritative |
| Follow-up request, §14 evaluation and multi-agent deliverables | complete | Provide code, tests, benchmark evidence, performance data, and remaining risks for this phase | Directory structure and report | A2–A5 | covered | Other phase ADRs and platform-wide deliverables remain outside this change |
| Follow-up request, §15 | complete | Autonomy must follow reliability, measurable results, and permission limits | Activation and non-goals | A3–A5 | covered | Phase 6 is explicitly outside this pilot change |

Coverage status: complete for the boundary above. No implementation requirement in this boundary lacks a Spec location or acceptance ID.

## Directory structure

### Created

- `apps/agent/src/evaluation/orchestration-benchmark.ts` — paired run validation, eligibility, metrics, and benchmark report projection.
- `apps/agent/src/evaluation/fixtures/datasets/orchestration-dev.json` — synthetic development cases.
- `apps/agent/src/evaluation/fixtures/datasets/orchestration-held-out.json` — independent synthetic held-out cases.
- `apps/agent/test/orchestration-benchmark.test.ts` — budget, pairing, rubric eligibility, metrics, and split-isolation tests.
- `apps/agent/scripts/evaluate-orchestration-benchmark.ts` — local benchmark command and report output.
- `harness/comet/changes/agent-phase5-multirole-benchmark/specs/orchestration-benchmark/spec.md` — complete benchmark behavior.

### Modified

- `apps/api-go/internal/creative/jobs.go` — reserve one equal parent amount for both plan-check modes.
- `apps/api-go/internal/creative/settings.go` and `query.go` — validate and report the equal plan-check reservation.
- `apps/api-go/internal/creative/*_test.go` — verify five role allocations fit the unchanged single-role cap.
- `scripts/lib/evaluation-business.mjs` — collect comparable Go/Pi evidence for both modes.
- `apps/agent/src/evaluation/` and `apps/agent/test/evaluation.test.ts` — integrate the paired benchmark with existing governance and scoring.
- `package.json` — register the benchmark command.
- `harness/architecture/agent-controlled-orchestration.md`, `agent-evaluation-platform.md`, and `agent-maturity-report.md` — record the budget policy, benchmark evidence, and remaining quality limitations.

### Deleted

None.

### Not created

- A task queue, database, billing ledger, authorization authority, or independent orchestration runtime — the existing Go AgentTask and Pi Worker contracts already provide these capabilities.
- An automatic activation rule — this phase reports evidence; the pilot remains explicitly opt-in.
- A Phase 6 planner or autonomous write path — it depends on accepted evidence from earlier phases.

# Non-goals

- Adding dynamic Agent roles, autonomous task creation, or write-capable subagents.
- Changing Go ownership of business authorization, billing, task state, or commits.
- Calling a paid/remote provider while building or verifying this change.
- Claiming real-model quality gains from synthetic fixtures or missing labels.
- Automatically enabling, disabling, or changing an author's orchestration setting from benchmark output.
- Starting Phase 6 autonomous planning or execution.

# Acceptance examples

- **A1 — Equal budget:** Given single-role and five-role plan checks for the same policy, Go reserves the existing single-role parent amount for either run; the five child limits sum exactly to it, and the five-role path does not increase the daily reservation. Unknown usage retains the full parent exposure.
- **A2 — Valid paired comparison:** Given development or held-out data, the runner accepts a pair only when both runs use the same case and saved revision, provider/model, deadline, and parent cap. It rejects mismatched or duplicate pairs and refuses development/held-out overlap.
- **A3 — Evidence-based quality report:** The report derives deterministic results and execution metrics from Go task receipts and persisted role results. It reports pairwise Judge and human agreement only for eligible labeled pairs, randomizes candidate order, records rubric/dataset/runtime versions, and leaves quality fields `null` when evidence is absent. A deterministic failure cannot be rescued by a Judge score.
- **A4 — Read-only authority and failure behavior:** Single- and multi-role runs keep the existing task authority, zero tool/write permissions, cancellation and no-retry policy, and no business or manuscript changes. Tests exercise provider failure and unknown usage using local synthetic providers.
- **A5 — No fabricated live evidence:** Automated development checks use localhost synthetic providers only. A remote Judge/evaluation path requires explicit synthetic-fixture and token-budget confirmation; this change does not execute it. Synthetic results are labeled as engineering evidence, and the five-role setting remains opt-in.

# Constraints and invariants

- Go remains the business, authorization, billing, task, and final-commit authority. Pi remains the model execution and logical-role runtime.
- The existing single-role per-task reservation is the ceiling for both modes. Multi-role child reservations are non-overlapping and sum exactly to that ceiling.
- All five roles remain read-only with no tools and no business write capability.
- The LLM Judge uses a fixed plan-check rubric and existing governed transport. Candidate text and source material are untrusted data; the Judge has no tools.
- Unknown model usage stays unknown and does not release reserved budget. Monetary cost stays `null` without authoritative price data.
- Development, held-out, and manual annotation records remain version-bound and separate. Held-out results are not used to tune prompts or policies.
- Evaluation output is written under `.local/evals/agent/` and is not committed by default.

# Decisions

- Preserve the existing single-role reservation and reduce the multi-role parent cap to the same amount. This satisfies the requested same-total-budget comparison without increasing the author's task or daily budget; each role receives one fifth, with any integer remainder assigned to the final Coordinator step.
- Use a plan-check-specific pairwise rubric plus optional independent human annotations; reuse the existing Judge datasets, Pi Model Gateway, budget controls, and audit events where compatible.
- Keep real-provider execution outside this implementation run. The benchmark may expose a guarded path for synthetic cases, but verification uses localhost fixtures only.
- Treat benchmark quality as unknown until valid paired model outputs and independent labels exist. A passing synthetic run establishes the evaluation path, not multi-agent quality.

# Verification expectations

- Run focused Go Creative unit/race tests and Agent benchmark/Judge tests.
- Run the benchmark against both versioned splits with localhost synthetic provider and confirm output versions, equal parent reservations, zero tools, and quality `null` without labels.
- Run Agent typecheck, lint, build, the Agent test suite, and Go `-race` checks relevant to Creative and task accounting.
- Do not invoke a remote or paid model during verification.
