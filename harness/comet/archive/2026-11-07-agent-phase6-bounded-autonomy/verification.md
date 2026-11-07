---
generated_from_state_version: 11
---

# Verification

## Current result

- Result: **Archived**
- Verification status: **Checks completed; result confirmed**
- Goal cycle: 1
- Iteration: 2
- Verifier attempt: 1
- Completed: 2026-11-07T11:26:34.415Z
- Summary: Independent inspection confirms candidate repair of the prior A3-A5 failures: /resume and idempotent resume replay avoid Creative intake, successful evidence is reused after recovery without a second tool call, completed and needs_input plans are sealed, post-completion recovery can emit final prose without calling complete_autonomy again, and public autonomy failures retain fixed recovery categories. All A1-A5 acceptance items are covered by the candidate behavior and bound Runtime evidence.

## Acceptance

| ID | Result | Source | Criterion | Reason |
| --- | --- | --- | --- | --- |
| A1 | passed | brief.md | **A1 — Explicit opt-in and compatibility:** A message without `autonomy` keeps the existing Thinking protocol, one-message admission, budget, tools, and output behavior. A bounded run is accepted only with a nonblank goal, completion criteria, `approveReadOnlyTools: true`, at least one authorized read-only scope, and a step/deadline limit within the selected model/session ceilings; invalid or write-requesting configurations are rejected before any model request. | Autonomy is per-message opt-in. Go validates the nonblank goal and criteria, explicit read-only-tool approval, at least one authorized read-only scope, and step/deadline bounds before reservation or Pi delivery; ordinary messages retain the existing one-message path. |
| A2 | passed | brief.md | **A2 — Bounded plan:** After the first model admission, the Agent must persist `adopt_autonomy_plan` before using evidence tools. The plan echoes the author goal and completion criteria, uses at most the admitted step count, and can name only currently authorized read-only Story Tools. Duplicate plans, unknown tools, scope expansion, write/organize tools, an increased deadline/budget, or a plan over the effective limit fail without executing the attempted step. | adopt_autonomy_plan must be persisted before evidence tools run and is bound to the exact author goal and criteria, unique planned IDs, the admitted step ceiling, and currently authorized read-only Story Tools. Duplicate, expanded, write, organize, unknown-tool, or over-limit plans fail before the attempted step executes. |
| A3 | passed | brief.md | **A3 — Governed execution:** Planned tools execute through the existing Tool Gateway and Go authorization with the original session, book, author, authorization version, scopes, cancellation signal, and model/session budget. The mode performs no write, story-recording, organizing, Canon, or external business effect, and it cannot create another task or Agent. | Planned evidence calls pass through the existing Tool Gateway and Go tool authorization using the original session, book, author, authorization version, scopes, cancellation/deadline, and model/session budget. The autonomy path exposes no write, story-recording, organize, Canon, external-effect, child-task, or child-Agent capability; resume does not enter Creative intake. |
| A4 | passed | brief.md | **A4 — Explicit completion and failure:** The Agent must call `complete_autonomy` with `complete` or `needs_input`. `complete` requires every planned step ID; `needs_input` records the remaining step IDs and a bounded reason. A run that omits this record, exceeds a limit, stops after cancellation, or loses authorization fails or is cancelled without a success claim. Existing restart behavior never automatically replays a paid execution. | complete_autonomy is required for success or needs_input, with all planned IDs or the remaining IDs and a bounded reason. Successful evidence is checkpointed and reused after explicit recovery without repeating the business tool; completed and needs_input states seal further reads; post-completion recovery drops tools and may produce final prose without another completion call. Limits, cancellation, authorization loss, and restart fail safely without a success claim or automatic paid replay. |
| A5 | passed | brief.md | **A5 — Product and evidence:** The API/UI expose the opt-in, completion criteria, projected plan, status, and per-step state without exposing token forms, credentials, or tool payloads. Tests use localhost synthetic providers and cover valid completion, malformed/expanded plans, write-tool denial, tool/provider failure, cancellation, deadline, restart/recovery, and unchanged ordinary messages. Documentation labels the result engineering evidence and keeps bounded autonomy default-off. | The API and UI expose opt-in, completion criteria, admitted limits, projected plan, status, per-step state, and completion summary without token forms, credentials, or tool payloads. Localhost synthetic-provider tests cover the required valid and failure paths, and documentation labels the result as engineering evidence, keeps bounded autonomy default-off, and does not claim real-model or independent validation. |

## Checks

| Check | Command | Working directory | Status | Exit | Duration |
| --- | --- | --- | --- | ---: | ---: |
| Agent full tests | test:agent | . | passed | 0 | 8686 ms |
| Real Go/Pi Thinking integration | test:thinking | . | passed | 0 | 22390 ms |
| Web and Worker authorization tests | --filter @writer-agent/web test | . | passed | 0 | 6305 ms |
| Go full race suite | test -race -count=1 ./... | apps/api-go | passed | 0 | 71985 ms |
| OpenAPI contract checks | openapi:check | . | passed | 0 | 1593 ms |
| Workspace type checks | typecheck | . | passed | 0 | 7209 ms |
| Workspace lint | lint | . | passed | 0 | 3144 ms |
| Production build | build | . | passed | 0 | 7467 ms |

### Builder-reported evidence

These are Builder reports, not Runtime check receipts or independent verification results.

- Agent full tests: passed — pnpm test:agent passed 188/188.
- Real Go/Pi Thinking integration: passed — pnpm test:thinking passed, including SIGKILL, restart, explicit resume, and autonomy intake isolation with localhost synthetic providers.
- Web and Worker authorization tests: passed — Web passed 294/294 and Worker authorization passed 25/25.
- Go full race suite: passed — go test -race -count=1 ./... passed in apps/api-go.
- OpenAPI contracts: passed — pnpm openapi:check verified 11 contracts.
- Type checks: passed — pnpm typecheck passed for contracts, web, worker, and agent.
- Lint: passed — pnpm lint passed for web, contracts, and agent.
- Production build: passed — pnpm build passed for Go API, Agent, web client, and SSR worker.
- Whitespace check: passed — git diff --check passed.
- Known limitation: All model responses in verification use localhost synthetic providers; no paid or remote model request was made.
- Known limitation: The pilot does not establish real-model plan quality, prompt-injection resistance rate, representative book performance, or production SLOs.
- Known limitation: Bounded autonomy remains default-off, read-only, and limited to one Thinking message; dynamic child Agents, autonomous writes, and unattended execution remain out of scope.

## Blockers

_None._

## Risks and skipped work

- Validation uses localhost synthetic providers only and does not establish real-model plan quality, injection resistance, representative book performance, or production SLOs.
- Bounded autonomy remains default-off and read-only; autonomous writes, dynamic child Agents, unattended execution, and broader production validation remain out of scope.

## Previous iterations

| Goal cycle | Iteration | Attempt | Outcome | Unresolved | Summary | Completed |
| ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | 1 | 1 | fail | A3, A4, A5 | A1 and A2 pass: default-off compatibility, Go pre-model admission, and plan-before-read enforcement are present. The candidate fails A3-A5 because explicit resume can create a creative task and lose completed evidence, completed-plan recovery cannot always finish, post-completion/needs_input state transitions are not sealed, and API failure projection plus engineering evidence claims are inaccurate. | 2026-11-07T11:03:49.584Z |
| 1 | 2 | 1 | pass | — | Independent inspection confirms candidate repair of the prior A3-A5 failures: /resume and idempotent resume replay avoid Creative intake, successful evidence is reused after recovery without a second tool call, completed and needs_input plans are sealed, post-completion recovery can emit final prose without calling complete_autonomy again, and public autonomy failures retain fixed recovery categories. All A1-A5 acceptance items are covered by the candidate behavior and bound Runtime evidence. | 2026-11-07T11:26:34.415Z |



## Conclusion

Independent inspection confirms candidate repair of the prior A3-A5 failures: /resume and idempotent resume replay avoid Creative intake, successful evidence is reused after recovery without a second tool call, completed and needs_input plans are sealed, post-completion recovery can emit final prose without calling complete_autonomy again, and public autonomy failures retain fixed recovery categories. All A1-A5 acceptance items are covered by the candidate behavior and bound Runtime evidence.
