# Outcome

Add an explicit, default-off bounded autonomy mode to Thinking. An author can turn one message into a bounded goal with written completion criteria, a fixed maximum number of steps, the existing model/token/tool/deadline limits, and approval to use only read-only Story Tools. The Agent must persist a valid plan before reading evidence, may execute only planned read-only work, and must explicitly report completion or the information still needed.

# Scope

This change closes the Phase 6 gap with a controlled read-only pilot inside the existing Thinking session and Pi Durable runtime. It does not create another task queue, Agent process, planning service, database, budget ledger, or authorization authority.

The public Thinking message contract gains an optional `autonomy` request containing completion criteria, an explicit `approveReadOnlyTools: true` confirmation, a step limit, and an optional shorter deadline. Ordinary messages remain byte-for-byte semantically compatible and incur no extra model call. A message with `autonomy` is accepted only when the session has at least one read-only scope and the requested limits can be satisfied by the selected model.

During the run, the Agent must call `adopt_autonomy_plan` before any evidence tool. The plan echoes the author's goal and completion criteria, contains at most the admitted step limit, and names only currently authorized read-only tools. The runtime rejects plans that add tools, scopes, steps, time, budget, or external effects. Plan state is stored in the existing Durable checkpoint and projected on the original author message; it is not a second planning database.

After planning, the Agent may use only the read-only tools named by the plan, within the existing model-call, tool-call, token, session, deadline, authorization, and cancellation ceilings. Write tools, organizing requests, task creation, and external effects are absent from this mode. Existing author approval and Go business authorization remain the only paths for later writes.

The Agent must call `complete_autonomy` before its final answer. `complete` requires every planned step to be accounted for; `needs_input` records exactly which steps could not be completed and why. A run that stops without an explicit completion record fails as incomplete rather than presenting success.

Cancellation, deadline expiry, provider/tool failure, process restart, and explicit resume retain the existing Thinking behavior. Recovery uses the persisted plan and step limits and never creates a larger plan or silently sends a new paid attempt.

The inspiration composer exposes the mode as an optional control with completion criteria. It does not expose token budgets. The API and rendered plan expose the goal, completion criteria, status, step count, and per-step state without copying tool payloads or credentials.

## Directory structure

### Created

- `apps/agent/src/runtime/governance/task-coordinator.ts` — strict plan/completion contract and bounded execution-state transitions.
- `apps/agent/test/autonomy.test.ts` — plan limits, read-only enforcement, completion, cancellation, deadline, recovery, and backward-compatibility tests.
- `harness/comet/changes/agent-phase6-bounded-autonomy/specs/bounded-autonomy/spec.md` — complete runtime and product behavior.

### Modified

- `packages/contracts/src/thinking.ts` — optional autonomy request/state schemas and public Thinking message projection.
- `apps/api-go/internal/thinking/model.go` and `http.go` — accept and validate opt-in autonomy messages within existing Go budget and authorization paths.
- `apps/agent/src/tools/registry.ts` — expose only read-only Story Tools in autonomy mode and add internal plan/completion tools.
- `apps/agent/src/runtime/pi-host.ts` and `apps/agent/src/sessions/store.ts` — persist plan/completion state in the existing checkpoint and enforce it in the governed model/tool loop.
- `apps/agent/src/runtime/governance/runtime.ts` — register the bounded autonomy executor roles/tool policy.
- `apps/web/src/features/inspiration/Composer.tsx`, `InspirationWorkspace.tsx`, and related tests — opt-in controls, completion criteria, and projected plan status.
- `apps/agent/test/runtime.test.ts`, `story-context.test.ts`, and Go Thinking tests — verify unchanged ordinary behavior and new admission boundaries.
- `harness/architecture/agent-runtime-governance.md`, `agent-controlled-orchestration.md`, `agent-security-threat-model.md`, and `agent-maturity-report.md` — document the pilot, evidence, limitations, and rollback.

### Deleted

None.

### Not created

- A new queue, database, task authority, process, scheduler, budget system, or autonomous write path.
- Dynamic child Agents or model-created roles.
- Automatic model calls after restart, cancellation, or a failed run.
- User-authored token budgets or an ability to raise session/model limits.

# Non-goals

- Autonomous manuscript or Canon writes.
- Unattended high-risk external actions.
- Planner-generated task or child-Agent creation.
- Default activation. Users must explicitly enable the mode for each message.
- Claims of real-model quality or production readiness from local synthetic tests.

# Acceptance examples

- **A1 — Explicit opt-in and compatibility:** A message without `autonomy` keeps the existing Thinking protocol, one-message admission, budget, tools, and output behavior. A bounded run is accepted only with a nonblank goal, completion criteria, `approveReadOnlyTools: true`, at least one authorized read-only scope, and a step/deadline limit within the selected model/session ceilings; invalid or write-requesting configurations are rejected before any model request.
- **A2 — Bounded plan:** After the first model admission, the Agent must persist `adopt_autonomy_plan` before using evidence tools. The plan echoes the author goal and completion criteria, uses at most the admitted step count, and can name only currently authorized read-only Story Tools. Duplicate plans, unknown tools, scope expansion, write/organize tools, an increased deadline/budget, or a plan over the effective limit fail without executing the attempted step.
- **A3 — Governed execution:** Planned tools execute through the existing Tool Gateway and Go authorization with the original session, book, author, authorization version, scopes, cancellation signal, and model/session budget. The mode performs no write, story-recording, organizing, Canon, or external business effect, and it cannot create another task or Agent.
- **A4 — Explicit completion and failure:** The Agent must call `complete_autonomy` with `complete` or `needs_input`. `complete` requires every planned step ID; `needs_input` records the remaining step IDs and a bounded reason. A run that omits this record, exceeds a limit, stops after cancellation, or loses authorization fails or is cancelled without a success claim. Existing restart behavior never automatically replays a paid execution.
- **A5 — Product and evidence:** The API/UI expose the opt-in, completion criteria, projected plan, status, and per-step state without exposing token forms, credentials, or tool payloads. Tests use localhost synthetic providers and cover valid completion, malformed/expanded plans, write-tool denial, tool/provider failure, cancellation, deadline, restart/recovery, and unchanged ordinary messages. Documentation labels the result engineering evidence and keeps bounded autonomy default-off.
