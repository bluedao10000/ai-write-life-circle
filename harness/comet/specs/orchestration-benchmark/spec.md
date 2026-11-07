# Creative plan-check orchestration benchmark

## Purpose

This capability evaluates the existing single-role and default-off five-role Creative plan-check modes under one equal parent reservation. It reports deterministic task correctness, execution reliability, semantic judgments, token exposure, calls, and latency as separate evidence.

It does not change the Go/Pi ownership boundary. Go remains authoritative for authorization, budgets, task state, and the final Creative result. The existing Pi Worker executes the registered logical roles.

## Execution and budget contract

- Both modes reserve the same per-job token amount: the current single-role reservation for the configured Creative model.
- The five-role mode divides that parent amount into five non-overlapping limits. Each limit is at least the minimum accepted model request. Integer remainder belongs to the final Coordinator step. The sum must equal the parent reservation exactly.
- Go validates daily token and job budgets against the actual parent reservation. The settings view reports the per-job plan-check reservation used for admission.
- Provider sends remain behind the existing Go started/admission and Pi Model Gateway checks. Unknown usage retains the full reservation; a partial usage report cannot stand in for a complete parent usage report.
- Both modes use the same saved chapter revision, accepted plans, provider/model, task deadline, tool allowance, and benchmark case. The five-role mode remains tools-free and read-only.
- A failure, cancellation, timeout, or unknown usage does not cause an automatic new paid attempt. Existing Go task and cancellation policy remains authoritative.

## Datasets and paired execution

- Development and held-out datasets have distinct versions, split labels, case IDs, and request content. Cases contain synthetic chapter text and plans only.
- Each pair consists of one completed single-role plan-check and one completed five-role plan-check for the same case and captured input. Pair validation compares the persisted Go job/task identity, saved revision ID and content hash, input hash, provider/model, parent reservation, and deadline policy.
- Missing, duplicated, mixed-version, failed-deterministic, or mismatched pairs are ineligible for semantic quality scoring. Their execution outcomes remain visible in reliability and cost metrics.
- Held-out data and annotations are never used to tune role prompts, budgets, or comparison rules. A changed held-out case receives a new version and is no longer described as independent from any split that used it.
- The runner obtains completion, usage, reservations, and role results from Go's durable task records and persisted evaluation observations. Worker logs and model self-reports do not establish business completion.

## Deterministic grading

The paired report records, per mode and per case:

- Go job completion or failure and the persisted business result.
- Input/revision identity and parent reservation equality.
- Required model-call and role counts, role admissions, and role completion results.
- Citation and evidence validity already enforced by Go's plan-check contract.
- Tool and business-write counts, which must be zero for the pilot.
- Actual known input/output/charged token usage, unknown-usage exposure, and reserved tokens.
- Task and role duration, including sample count and P50/P95.

Deterministic failures are never reclassified as passes by Judge or human scores. Monetary cost is included only when an authoritative provider price exists; otherwise the amount is `null` and token counts/reservations remain available.

## Semantic judgment

- A fixed `creative-plan-check-pairwise-v1` rubric compares the two candidates for evidence support, assessment accuracy, uncertainty handling, and usefulness to the author.
- Candidate order is randomized for each judgment and the mapping back to single-role/five-role is recorded in the private local run artifact.
- Candidate text, plans, and chapter text are untrusted data. The Judge has no tools and cannot alter the rubric, deterministic eligibility, budget, or business outcome.
- Judge calls use the existing governed Pi Model Gateway, authorization, timeout, cancellation, reservation, usage settlement, and no-blind-retry behavior. The Judge reservation and cost are reported separately from Agent execution.
- Human annotations bind to the benchmark dataset version, rubric version, case, and reviewer. Duplicate reviewer/case labels and labels for ineligible pairs are rejected. Reports include eligible pair count, single/multi/tie totals, reviewer count, double-reviewed case count, and inter-reviewer agreement. They omit reviewer IDs, rationales, source text, and candidate text.
- Without valid eligible Judge results or human annotations, semantic quality metrics remain `null`. Engineering equivalence from a synthetic provider is not quality evidence.

## Live evaluation boundary

- Development and automated verification use localhost synthetic providers only.
- A remote Judge run may submit only datasets marked synthetic and requires explicit live mode, fixture confirmation, and a hard reserved-token budget. It stops after the first execution failure, does not retry, and never loads production credentials automatically.
- Running the remote evaluation requires a separate explicit user action. This change does not invoke a remote model.

## Reporting and activation

- One report is produced per split under `.local/evals/agent/`. It records commit and dirty state, Agent/Pi/runtime version, provider/model, prompt and output-schema versions, dataset and rubric versions, mode, configured budgets, per-case outcomes, failure codes, known/unknown usage, role counts, tool counts, latency samples, and separate Judge usage.
- Reports do not copy chapter text, plan content, candidate text, secrets, or reviewer identity into committed files.
- The report may summarize the measured paired difference and sample counts. It does not declare statistical significance or production readiness from an uncalibrated or insufficient sample.
- Benchmark results never toggle the author's multi-role setting. The five-role plan check remains opt-in. Default activation requires a later reviewed decision based on eligible same-budget model runs, calibrated human labels, no safety/reliability regression, and accepted cost/latency.

## Compatibility and migration

- Single-role prompts, outputs, retry behavior, and task execution remain unchanged.
- Existing stored tasks remain readable. New tasks use the equal per-job reservation policy at creation; no existing task is rewritten.
- No new database, queue, task authority, billing ledger, or persistent report store is introduced. Benchmark reports remain local artifacts.
