# Outcome

Verify that Creative's existing per-book daily budget remains authoritative when a normal Creative job claim and a background memory consolidation attempt compete concurrently through independent Go service instances. Fix the existing transaction boundary only if the regression exposes over-admission.

# Scope

The boundary covers admission to the existing `BudgetTokens` and `BudgetAttempts` counters shared by Creative job claims and `memory.consolidate` starts. Both operations use the same persisted Creative state and per-book lock. The change adds a deterministic concurrent regression test using independent Service values over the same state directory; a production fix is in scope only if that test proves the boundary is insufficient.

Source coverage is limited to background memory consolidation, shared budget admission and settlement, and the constraint that requests reserve budget before model execution. The supplied maturity requirements' child-task allocation rules remain outside this single-task budget race.

## Source coverage

| Source item and location | Read status | Content to preserve | Spec location | Acceptance ID | Coverage status | Reason or replacement |
| --- | --- | --- | --- | --- | --- | --- |
| S1: supplied Agent Maturity attachment, §4.7, “Memory Consolidation” | complete | Consolidation creates reviewable candidates and retains source lineage; it does not automatically write Canon. | §1, §5 | A1 | background | Existing candidate and source behavior remains authoritative; this change exercises admission only. |
| S2: supplied follow-up requirements, §9.2, concurrent model budget and pre-request reservation | complete | Concurrent work cannot exceed its shared budget; reserve before network execution; unknown usage remains reserved. | §§2–4 | A1, A2 | covered | Applied to the existing per-book Creative budget used by both admission paths. |
| S3: supplied follow-up requirements, §9.6, budget reservation, settlement, unknown usage, exhaustion and Go settlement authority | complete | Reserve and settle against the existing authority; keep unknown usage reserved; stop safely when exhausted; Go remains the business-points authority. | §§2–4 | A1–A3 | covered | The test protects Creative token/job admission while the existing Go meter continues to own business points. |
| S4: supplied follow-up requirements, §12.5, parent and child budget bounds | complete | Child budgets cannot exceed the parent budget. | — | — | non-goal | This test does not create child tasks or change the fixed read-only orchestration budget. |

## Directory structure

### Created

- `specs/memory-budget/spec.md` — complete behavior of the shared per-book Creative budget admission and settlement.

### Modified

- `apps/api-go/internal/creative/memory_budget_test.go` — exercise simultaneous admission from independent services sharing one per-book state directory.
- `apps/api-go/internal/creative/memory_budget.go` — change only if the concurrent regression proves an admission race.

### Deleted

None

### Not created

- A second budget ledger or task authority — Creative state and the Go business-points meter already own these decisions.
- A model request or provider fixture — admission is deterministic and must complete before any provider work.

# Non-goals

- Changing daily budget limits, task scheduling, retry behavior, model quality or candidate publication.
- Adding child tasks, dynamic agent roles, a database or a new budget service.
- Measuring real provider usage or making claims about semantic memory quality.

# Acceptance examples

- A1: With the shared daily token limit set to one token less than two valid reservations, race one normal Creative job claim against one `memory.consolidate` reservation using independent Service instances over the same state directory. Exactly one is admitted; persisted token and attempt counters reflect that admission and never exceed their configured limits.
- A2: Reopen the shared state through a fresh Service and verify that the committed daily counters match the winning admission. Existing memory reservation idempotency and settlement tests continue to prove a replay does not double-reserve and unknown usage does not release tokens.
- A3: Run the Creative and memory task race suites with Go's race detector; no model provider is contacted and no change is made to the stored state schema or Go business-points authority.
