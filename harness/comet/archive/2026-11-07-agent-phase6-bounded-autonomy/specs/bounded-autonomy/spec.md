# Bounded read-only autonomy

## Purpose

Thinking supports an explicit, default-off bounded autonomy mode for one author message. The mode adds a persisted plan, planned read-only tool execution, and an explicit completion record to the existing authorised Thinking session. It does not create a second task or budget authority.

Go remains authoritative for identity, scope, billing, session authorization, and business commits. Pi remains responsible for durable model execution, plan state, tool sequencing, and the candidate reply. Thinking and the background Worker remain separate processes.

## Opt-in request

- An ordinary Thinking message has no autonomy data and retains the existing contract and execution path.
- A bounded request includes the author message as the goal, completion criteria, explicit `approveReadOnlyTools: true`, a step limit, and an optional shorter deadline.
- The step limit is at most eight and is further clamped by the selected model's remaining turn/tool ceilings. The optional deadline may only shorten the model session's maximum duration.
- The session must have at least one authorized read-only scope and the selected model must support the required tool-calling loop. A model without tool calling is rejected before the run is admitted.
- Memory-extraction sessions and recovery inputs cannot introduce autonomy. Recovery reuses the persisted request and cannot raise a plan, scope, deadline, or budget.
- Go validates the request before reserving points or handing the message to Pi. Invalid input produces a validation or scope problem and causes no model request.

Acceptance: A1

## Plan contract

- `adopt_autonomy_plan` is the only tool that may run before a plan exists.
- The plan echoes the original goal and completion criteria exactly, assigns stable step IDs, contains between one and the admitted step count, and records only currently authorized read-only Story Tools.
- Allowed planned tools are limited to: memory retrieval, knowledge search, chapter/context reads, related-chapter search, entity/notes/timeline/plot-thread reads, creative asset/proposal/question reads, writing-context comparison, and discussion-source reads.
- Write tools, `request_turn_organize`, model-created tasks, child Agents, file paths, credentials, changed scopes, larger budgets, longer deadlines, and unknown tools are invalid.
- A plan can be adopted once per message attempt. A recovered attempt reads the persisted plan and cannot replace it with a broader one.
- The projected plan contains the goal, completion criteria, status, bounded step list, and per-step state. It does not expose raw tool arguments, results, provider payloads, capabilities, or secrets.

Acceptance: A2

## Execution contract

- After plan adoption, every evidence tool must correspond to a planned read-only step and execute through the existing Tool Gateway, Go tool endpoint, and current Thinking authorization.
- The execution keeps the original author, book, session, run, authorization version, model identity, trace, deadline, cancellation signal, and session/token/tool ceilings.
- A tool may be used once for its planned step. Repeated calls, unplanned calls, calls after the tool budget, calls after cancellation, and calls after authorization revocation are rejected.
- The mode has no write, story-recording, organizing, Canon, publication, billing, task-creation, or external-side-effect capability. A later write requires a separate ordinary Thinking action under the existing author-approval and Go business contracts.
- Budget reservation and settlement reuse the existing Thinking point reservation and Pi model request accounting. Unknown usage stays unknown and retains its reservation; no retry is issued automatically.

Acceptance: A3

## Completion and failures

- `complete_autonomy` ends only the autonomy bookkeeping, not the Thinking session itself. It accepts `complete` or `needs_input` and a bounded summary.
- `complete` requires exactly the plan's step IDs and marks the plan completed. `needs_input` may list a strict subset and must identify at least one remaining step with a bounded reason.
- The final assistant response is emitted only after the completion record is persisted. If the model stops without a valid completion record, the message fails with `AUTONOMY_INCOMPLETE`; it must not claim success.
- Plan/tool/step overflow uses `AUTONOMY_LIMIT_EXCEEDED`; unauthorized or changed plan data uses `AUTONOMY_PLAN_REJECTED`; a changed tool/scope/authorization keeps the existing fixed Thinking denial code.
- Cancellation stops the active model/tool work and projects the run as cancelled. Deadline expiry uses the existing duration failure. Provider/tool failures use their existing fixed categories.
- A restart interrupts the old live run and never automatically starts another paid request. Explicit resume uses the persisted plan and completion state; an invalid or incompatible plan is not executed.

Acceptance: A4

## Product projection

- The inspiration composer offers a per-message autonomy control, requires completion criteria when enabled, states that only read-only project data may be used, and never asks the author to enter token budgets.
- Sending with autonomy enabled includes the explicit read-only approval flag. Turning the control off restores the ordinary message path.
- The author message renders the projected goal, completion criteria, plan status, bounded steps and completion result. Provider/tool payloads and credentials are not rendered.
- Existing history, scope management, model selection, cancellation, resume, usage, and errors remain available. Failed or incomplete plans remain visible and do not get converted into successful answers.

Acceptance: A5

## Compatibility and rollback

- Stored sessions without autonomy data remain readable. New optional fields are ignored by older clients and do not migrate existing messages.
- Ordinary runs retain the same system prompt, tools, model-call admission, point reservation, and output contract.
- The autonomy state lives in the existing Durable checkpoint and projected Thinking message. No new persistent authority is introduced.
- Rollback requires disabling admission of new autonomy requests, letting active read-only runs finish or cancel, and deploying the prior Go/Pi/Web builds. Existing completed plan projections may remain inert metadata.
- Tests use localhost synthetic providers. Passing tests prove protocol and boundary behavior, not real-model planning quality, safety rate, latency, or production readiness.
