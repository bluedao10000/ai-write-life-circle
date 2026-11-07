# Creative per-book budget

## 1. Authority

The Creative state for a book is the authority for its daily token and job-attempt limits. Normal Creative job claims and background `memory.consolidate` starts share `BudgetDay`, `BudgetTokens`, and `BudgetAttempts` in the existing `state-v1.json`. The existing Go meter remains the authority for business points. No second budget ledger is introduced.

## 2. Admission

Every admission reloads the latest Creative state while holding the existing per-book state lock. On a day change, the transaction resets that day's counters. It checks the configured daily token and job-attempt limits, then records the reservation and attempt count in the same state transaction. A refused admission does not consume tokens or an attempt. A day rollover may still commit its counter reset when the admission is refused.

Normal Creative jobs reserve their registered per-attempt amount. A memory consolidation start first reserves Go business points, then reserves its prepared token amount against the same per-book Creative counters. The Worker must receive the successful Go `started` response before sending a model request. If the Creative reservation fails, the Go points reservation is released and no model request starts.

Concurrent admissions through separate API or domain Service instances that share the same state directory are serialized by the same file-backed lock. Their combined reservations and attempts cannot exceed the configured limits. An idempotent retry for the same memory task and reservation returns its original budget day without incrementing counters again; changing the reservation identity is rejected.

## 3. Exhaustion

An admission that cannot fit within either daily limit is refused. No model request is sent for that task. Existing accepted tasks retain their reservations until their normal terminal settlement; cancellation, crash, or an unknown usage report does not create additional capacity for a second request.

## 4. Settlement

The first terminal settlement for a memory task is authoritative and idempotent. A request that was not sent releases its token reservation and attempt slot. A sent request with known usage replaces its reservation with actual input and output tokens. A sent request with unknown usage retains the full reservation. Repeated terminal reports do not rewrite the first settlement. Settlement from a prior budget day does not change the current day's counters.

Normal Creative job settlement continues to use its existing completion receipt and Go meter behavior. This specification does not change retries, task receipts or business-point settlement.

## 5. Persistence and compatibility

The existing Creative state schema and transaction lock remain unchanged. No migration is required. Reopening the state through another Service instance returns the same committed daily counters. Candidate generation, author review, source lineage and Canon behavior remain owned by their existing services.
