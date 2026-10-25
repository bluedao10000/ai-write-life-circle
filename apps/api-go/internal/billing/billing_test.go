package billing

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func ledger(t *testing.T) (*Ledger, *clock) {
	t.Helper()
	c := &clock{time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)}
	return &Ledger{State: t.TempDir(), LegacyOwner: "owner", Now: c.now}, c
}

func code(e error) string {
	if e == nil {
		return ""
	}
	return application.AsError(e).Code
}

func TestPointsFor(t *testing.T) {
	for _, tc := range []struct{ in, out, want int }{{0, 0, 0}, {1, 0, 1}, {1000, 0, 1}, {1001, 0, 2}, {10000, 2000, 18}, {-5, 0, 0}} {
		if got := PointsFor(tc.in, tc.out); got != tc.want {
			t.Fatalf("PointsFor(%d,%d)=%d want %d", tc.in, tc.out, got, tc.want)
		}
	}
}

func TestFreeDailyAndMonthlyLimitsAdmitAtMostOneOverrun(t *testing.T) {
	l, c := ledger(t)
	ctx := context.Background()
	// 300 daily: three 100-point operations fill the day; the fourth is refused.
	for i := 0; i < 3; i++ {
		op := fmt.Sprint("a", i)
		if e := l.Reserve(ctx, "alice", op, "thinking", 100); e != nil {
			t.Fatal(i, e)
		}
		if e := l.Settle(ctx, "alice", op, 100); e != nil {
			t.Fatal(e)
		}
	}
	if code(l.Reserve(ctx, "alice", "a3", "thinking", 1)) != "PLAN_QUOTA_EXCEEDED" {
		t.Fatal("daily limit not enforced")
	}
	// Admission is checked before adding the hold: one large op may overrun.
	c.t = c.t.AddDate(0, 0, 1)
	if e := l.Reserve(ctx, "alice", "big", "review", 250); e != nil {
		t.Fatal(e)
	}
	if code(l.Reserve(ctx, "alice", "next", "thinking", 100)) != "" {
		t.Fatal("outstanding 250 < 300 must still admit")
	}
	if code(l.Reserve(ctx, "alice", "third", "thinking", 1)) != "PLAN_QUOTA_EXCEEDED" {
		t.Fatal("open holds must count toward the limit")
	}
	_ = l.Settle(ctx, "alice", "big", 0)
	_ = l.Settle(ctx, "alice", "next", 0)
	// Monthly 1500: burn it across days.
	for day := 0; day < 4; day++ {
		c.t = c.t.AddDate(0, 0, 1)
		op := fmt.Sprint("m", day)
		if e := l.Reserve(ctx, "alice", op, "knowledge", 1); e != nil {
			t.Fatal(day, e)
		}
		_ = l.Settle(ctx, "alice", op, 300)
	}
	c.t = c.t.AddDate(0, 0, 1)
	if code(l.Reserve(ctx, "alice", "over", "knowledge", 1)) != "PLAN_QUOTA_EXCEEDED" {
		u, _ := l.View(ctx, "alice")
		t.Fatalf("monthly limit not enforced: %+v", u)
	}
	// A new UTC month restores the allowance.
	c.t = time.Date(2026, 11, 1, 0, 0, 1, 0, time.UTC)
	if e := l.Reserve(ctx, "alice", "november", "knowledge", 1); e != nil {
		t.Fatal(e)
	}
}

func TestReserveSettleIdempotentAndExpiry(t *testing.T) {
	l, c := ledger(t)
	ctx := context.Background()
	if e := l.Reserve(ctx, "bob", "op", "review", 50); e != nil {
		t.Fatal(e)
	}
	if e := l.Reserve(ctx, "bob", "op", "review", 50); e != nil {
		t.Fatal(e)
	}
	_ = l.Settle(ctx, "bob", "op", 7)
	_ = l.Settle(ctx, "bob", "op", 500) // second settle ignored
	if e := l.Reserve(ctx, "bob", "op", "review", 50); e != nil {
		t.Fatal(e) // settled op replays without a new hold
	}
	u, _ := l.View(ctx, "bob")
	if u.Day.Used != 7 || u.Day.Reserved != 0 {
		t.Fatalf("%+v", u.Day)
	}
	// Negative settlement charges the reservation (usage unknown).
	_ = l.Reserve(ctx, "bob", "unknown", "knowledge", 40)
	_ = l.Settle(ctx, "bob", "unknown", -1)
	// An abandoned hold is charged in full once its lease expires.
	_ = l.Reserve(ctx, "bob", "crashed", "knowledge", 30)
	c.t = c.t.Add(16 * time.Minute)
	u, _ = l.View(ctx, "bob")
	if u.Day.Used != 77 || u.Day.Reserved != 0 {
		t.Fatalf("%+v", u.Day)
	}
	_ = l.Settle(ctx, "bob", "crashed", 1) // late settlement is ignored
	if u, _ = l.View(ctx, "bob"); u.Day.Used != 77 {
		t.Fatal(u.Day)
	}
}

func TestPlansFeaturesLegacyOwnerAndIsolation(t *testing.T) {
	l, _ := ledger(t)
	ctx := context.Background()
	if code(l.Allow(ctx, "free-user", "review")) != "PLAN_FEATURE_REQUIRED" {
		t.Fatal("Free account allowed review")
	}
	if e := l.Allow(ctx, "free-user", "thinking"); e != nil {
		t.Fatal(e)
	}
	if e := l.Allow(ctx, "owner", "review"); e != nil {
		t.Fatal("legacy owner is Pro", e)
	}
	if e := l.SetPlan(ctx, "plus-user", Plus); e != nil {
		t.Fatal(e)
	}
	if e := l.Allow(ctx, "plus-user", "review"); e != nil {
		t.Fatal(e)
	}
	u, _ := l.View(ctx, "plus-user")
	if u.Plan != Plus || u.Month.Limit != 6000 || u.Day.Limit != 1500 || !u.Features["review"] {
		t.Fatalf("%+v", u)
	}
	_ = l.Reserve(ctx, "free-user", "x", "thinking", 290)
	_ = l.Settle(ctx, "free-user", "x", 300)
	if e := l.Reserve(ctx, "plus-user", "y", "thinking", 10); e != nil {
		t.Fatal("one account's usage blocked another", e)
	}
	if u, _ := l.View(ctx, "free-user"); u.Month.ResetsAt != "2026-11-01T00:00:00Z" || u.Day.ResetsAt != "2026-10-26T00:00:00Z" {
		t.Fatalf("%+v", u)
	}
}

func TestFreePoolAndPauseSwitch(t *testing.T) {
	l, _ := ledger(t)
	ctx := context.Background()
	if e := WriteControl(ctx, l.State, Control{FreeDailyPoints: 250}); e != nil {
		t.Fatal(e)
	}
	_ = l.Reserve(ctx, "f1", "a", "thinking", 100)
	_ = l.Settle(ctx, "f1", "a", 200)
	_ = l.Reserve(ctx, "f2", "b", "thinking", 60) // 200 + 60 open: admitted at 200 < 250
	if code(l.Reserve(ctx, "f3", "c", "thinking", 1)) != "FREE_POOL_EXHAUSTED" {
		t.Fatal("free pool not enforced")
	}
	if e := l.Reserve(ctx, "owner", "paid", "thinking", 1); e != nil {
		t.Fatal("paid accounts must not use the Free pool", e)
	}
	_ = l.Settle(ctx, "f2", "b", 0) // released: 200 < 250 again
	if e := l.Reserve(ctx, "f3", "c", "thinking", 1); e != nil {
		t.Fatal(e)
	}
	if e := WriteControl(ctx, l.State, Control{Paused: "free"}); e != nil {
		t.Fatal(e)
	}
	if code(l.Reserve(ctx, "f4", "d", "thinking", 1)) != "AI_PAUSED" || l.Reserve(ctx, "owner", "e", "thinking", 1) != nil {
		t.Fatal("free pause")
	}
	_ = WriteControl(ctx, l.State, Control{Paused: "all"})
	if code(l.Reserve(ctx, "owner", "f", "thinking", 1)) != "AI_PAUSED" {
		t.Fatal("global pause")
	}
	if WriteControl(ctx, l.State, Control{Paused: "some"}) == nil {
		t.Fatal("invalid pause accepted")
	}
	if u, _ := l.View(ctx, "owner"); !u.Paused {
		t.Fatal("view hides pause")
	}
}

func TestConcurrentReservationsAcrossLedgers(t *testing.T) {
	l, _ := ledger(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	admitted := make([]bool, 20)
	for i := range admitted {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Separate ledgers model the API and Worker processes.
			other := &Ledger{State: l.State, LegacyOwner: l.LegacyOwner, Now: l.Now}
			admitted[i] = other.Reserve(ctx, "racer", fmt.Sprint("op", i), "knowledge", 100) == nil
		}(i)
	}
	wg.Wait()
	n := 0
	for _, ok := range admitted {
		if ok {
			n++
		}
	}
	if n != 3 {
		t.Fatalf("%d of 20 admitted against a 300 daily limit", n)
	}
}

func TestOwnerlessCallsAreNotMetered(t *testing.T) {
	l, _ := ledger(t)
	ctx := context.Background()
	if l.Reserve(ctx, "", "op", "review", 1e6) != nil || l.Settle(ctx, "", "op", 5) != nil || l.Allow(ctx, "", "review") != nil {
		t.Fatal("unmanaged fixtures must not be metered")
	}
}
