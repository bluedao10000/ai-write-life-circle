package creative

import (
	"context"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

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
