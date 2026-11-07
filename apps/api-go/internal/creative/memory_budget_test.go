package creative

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type budgetReservationGate struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (m *budgetReservationGate) Allow(context.Context, string, string) error { return nil }
func (m *budgetReservationGate) Reserve(ctx context.Context, _, _, _ string, _ int) error {
	m.once.Do(func() { close(m.entered) })
	select {
	case <-m.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (m *budgetReservationGate) Authorize(context.Context, string, string, string) error { return nil }
func (m *budgetReservationGate) Settle(context.Context, string, string, int) error       { return nil }
func (m *budgetReservationGate) Entitlements(context.Context, string) (application.Entitlements, error) {
	return application.Entitlements{}, nil
}

func TestMemoryAttemptBudgetIsIdempotentAndRetainsUnknownUsage(t *testing.T) {
	f := setup(t)
	f.enable()
	enabled := true
	if _, e := f.s.Configure(context.Background(), author, "memory", compat.UUID(), SettingsInput{AutoMemoryConsolidation: &enabled}); e != nil {
		t.Fatal(e)
	}

	before, e := f.s.Overview(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	day, e := f.s.ReserveMemoryAttempt(context.Background(), "task-known", 1200)
	if e != nil {
		t.Fatal(e)
	}
	replayedDay, e := f.s.ReserveMemoryAttempt(context.Background(), "task-known", 1200)
	if e != nil || replayedDay != day {
		t.Fatal(replayedDay, e)
	}
	if _, e = f.s.ReserveMemoryAttempt(context.Background(), "task-known", 1300); application.AsError(e).Status != 409 {
		t.Fatal("changed reservation was accepted", e)
	}

	response := llm.Response{Usage: &llm.Usage{InputTokens: 100, OutputTokens: 20}}
	if e = f.s.SettleMemoryAttempt(context.Background(), "task-known", day, 1200, response, true); e != nil {
		t.Fatal(e)
	}
	settled, e := f.s.Overview(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if settled.Settings.BudgetTokens != before.Settings.BudgetTokens+120 || settled.Settings.BudgetAttempts != before.Settings.BudgetAttempts+1 {
		t.Fatalf("known usage was not settled: %+v", settled)
	}
	if e = f.s.SettleMemoryAttempt(context.Background(), "task-known", day, 1200, response, true); e != nil {
		t.Fatal(e)
	}
	replayed, _ := f.s.Overview(context.Background())
	if replayed.Settings.BudgetTokens != settled.Settings.BudgetTokens || replayed.Settings.BudgetAttempts != settled.Settings.BudgetAttempts {
		t.Fatal("known usage was settled twice")
	}
	changed := llm.Response{Usage: &llm.Usage{InputTokens: 101, OutputTokens: 20}}
	if e = f.s.SettleMemoryAttempt(context.Background(), "task-known", day, 1200, changed, false); e != nil {
		t.Fatal("repeated terminal report was not idempotent", e)
	}
	afterRetry, _ := f.s.Overview(context.Background())
	if afterRetry.Settings.BudgetTokens != settled.Settings.BudgetTokens || afterRetry.Settings.BudgetAttempts != settled.Settings.BudgetAttempts {
		t.Fatal("repeated terminal report rewrote settlement")
	}
	if e = f.s.SettleMemoryAttempt(context.Background(), "task-known", day, 1201, response, true); application.AsError(e).Status != 409 {
		t.Fatal("changed settlement identity was accepted", e)
	}

	beforeUnknown, _ := f.s.Overview(context.Background())
	unknownDay, e := f.s.ReserveMemoryAttempt(context.Background(), "task-unknown", 900)
	if e != nil {
		t.Fatal(e)
	}
	if e = f.s.SettleMemoryAttempt(context.Background(), "task-unknown", unknownDay, 900, llm.Response{}, true); e != nil {
		t.Fatal(e)
	}
	afterUnknown, _ := f.s.Overview(context.Background())
	if afterUnknown.Settings.BudgetTokens != beforeUnknown.Settings.BudgetTokens+900 || afterUnknown.Settings.BudgetAttempts != beforeUnknown.Settings.BudgetAttempts+1 {
		t.Fatal("unknown usage released its reservation")
	}
	if e = f.s.SettleMemoryAttempt(context.Background(), "task-unknown", unknownDay, 900, llm.Response{}, false); e != nil {
		t.Fatal("unknown settlement retry was not idempotent", e)
	}
	afterUnknownRetry, _ := f.s.Overview(context.Background())
	if afterUnknownRetry.Settings.BudgetTokens != afterUnknown.Settings.BudgetTokens {
		t.Fatal("unknown settlement retry released the reservation")
	}

	beforeUnsent, _ := f.s.Overview(context.Background())
	unsentDay, e := f.s.ReserveMemoryAttempt(context.Background(), "task-unsent", 700)
	if e != nil {
		t.Fatal(e)
	}
	if e = f.s.SettleMemoryAttempt(context.Background(), "task-unsent", unsentDay, 700, llm.Response{}, false); e != nil {
		t.Fatal(e)
	}
	afterUnsent, _ := f.s.Overview(context.Background())
	if afterUnsent.Settings.BudgetTokens != beforeUnsent.Settings.BudgetTokens || afterUnsent.Settings.BudgetAttempts != beforeUnsent.Settings.BudgetAttempts {
		t.Fatal("unsent attempt was not released")
	}
	if e = f.s.SettleMemoryAttempt(context.Background(), "task-unsent", unsentDay, 700, response, true); e != nil {
		t.Fatal("conflicting terminal retry was not idempotent", e)
	}
	afterUnsentRetry, _ := f.s.Overview(context.Background())
	if afterUnsentRetry.Settings.BudgetTokens != afterUnsent.Settings.BudgetTokens {
		t.Fatal("terminal retry rewrote an unsent settlement")
	}

	restarted := New(f.s.App, f.s.Config, nil)
	if e = restarted.SettleMemoryAttempt(context.Background(), "task-known", day, 1200, response, true); e != nil {
		t.Fatal("restart lost settlement receipt", e)
	}
}

func TestCreativeClaimSerializesAgainstMemoryBudgetAcrossServices(t *testing.T) {
	f := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	reserve := f.s.reserve()
	limit := reserve*2 - 1
	model := f.s.Config.Info()
	if _, err := f.s.Configure(ctx, author, "enable", "budget-race-enable", SettingsInput{
		Consent: true, Model: &model, DailyTokenBudget: limit, DailyJobBudget: 10,
	}); err != nil {
		t.Fatal(err)
	}
	enabled := true
	if _, err := f.s.Configure(ctx, author, "memory", "budget-race-memory", SettingsInput{AutoMemoryConsolidation: &enabled}); err != nil {
		t.Fatal(err)
	}
	now := f.s.stamp()
	if err := f.s.transaction(ctx, func(st *State) (bool, error) {
		st.Jobs = append(st.Jobs, Job{ID: "creative-budget-race", Kind: "organize", Model: st.Settings.Model, Status: "pending", Due: now, CreatedAt: now})
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}

	gate := &budgetReservationGate{entered: make(chan struct{}), release: make(chan struct{})}
	f.s.App.Meter = gate
	jobService := New(f.s.App, f.s.Config, f.s.Client)
	memoryService := New(f.s.App, f.s.Config, nil)
	type claimResult struct {
		job *ClaimedJob
		err error
	}
	claimed := make(chan claimResult, 1)
	go func() {
		job, err := jobService.claim(ctx)
		claimed <- claimResult{job: job, err: err}
	}()
	select {
	case <-gate.entered:
	case <-ctx.Done():
		t.Fatal("creative claim did not reach its metering reservation")
	}

	type memoryResult struct {
		day string
		err error
	}
	memoryReserved := make(chan memoryResult, 1)
	started := make(chan struct{})
	go func() {
		close(started)
		day, err := memoryService.ReserveMemoryAttempt(ctx, "memory-budget-race", reserve)
		memoryReserved <- memoryResult{day: day, err: err}
	}()
	<-started
	var early *memoryResult
	select {
	case result := <-memoryReserved:
		early = &result
	case <-time.After(100 * time.Millisecond):
	}
	close(gate.release)
	claim := <-claimed
	if claim.err != nil || claim.job == nil {
		t.Fatalf("creative claim failed: %+v", claim)
	}
	if early != nil {
		t.Fatalf("memory budget transaction completed while the creative claim held the shared state lock: %+v", *early)
	}
	memory := <-memoryReserved
	if failure := application.AsError(memory.err); failure == nil || failure.Code != "CREATIVE_BUDGET_EXHAUSTED" {
		t.Fatalf("memory reservation was not rejected after the creative claim: day=%s err=%v", memory.day, memory.err)
	}

	// Close the synthetic points reservation created by the successful claim.
	f.s.App.MeterSettle(ctx, meterOp(claim.job.Job.ID, claim.job.Job.Attempts), 0)
	opened := New(f.s.App, f.s.Config, nil)
	state, err := opened.load()
	if err != nil {
		t.Fatal(err)
	}
	if state.BudgetTokens != reserve || state.BudgetAttempts != 1 || state.BudgetTokens > state.Settings.DailyTokenBudget || state.BudgetAttempts > state.Settings.DailyJobBudget {
		t.Fatalf("shared budget counters exceeded or lost the winning reservation: %+v", state)
	}
}
