package billing

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestReviewTrialConcurrentAccountsBooksRetriesAndUTC(t *testing.T) {
	l, c := ledger(t)
	ctx := context.Background()
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			other := &Ledger{State: l.State, Now: l.Now, LegacyOwner: l.LegacyOwner}
			if other.Reserve(ctx, "writer", fmt.Sprintf("review:book-%d:1", i), "review", 20) == nil {
				accepted.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if accepted.Load() != 2 {
		t.Fatal("account-level quota bypass", accepted.Load())
	}
	u, e := l.View(ctx, "writer")
	if e != nil || u.Review.Reserved != 2 || u.Review.Remaining != 0 {
		t.Fatal(u, e)
	}
	// A different account has its own trial budget; books do not define quota scope.
	if e = l.Reserve(ctx, "other", "review:other-book:1", "review", 20); e != nil {
		t.Fatal(e)
	}
	a, e := l.load("writer")
	if e != nil {
		t.Fatal(e)
	}
	var op string
	for id := range a.Open {
		op = id
		break
	}
	if e = l.Authorize(ctx, "writer", op, "review"); e != nil {
		t.Fatal(e)
	}
	if e = l.Settle(ctx, "writer", op, 5); e != nil {
		t.Fatal(e)
	}
	if e = l.Settle(ctx, "writer", op, 99); e != nil {
		t.Fatal(e)
	}
	if e = l.Reserve(ctx, "writer", op, "review", 20); e != nil {
		t.Fatal("same operation replay", e)
	}
	retry := "review:" + trialRun(op) + ":2"
	if e = l.Reserve(ctx, "writer", retry, "review", 20); e != nil {
		t.Fatal("retry must not consume a third trial", e)
	}
	_ = l.Authorize(ctx, "writer", retry, "review")
	_ = l.Settle(ctx, "writer", retry, 5)
	u, _ = l.View(ctx, "writer")
	if u.Review.Used != 1 || u.Review.Reserved != 1 || u.Day.Used != 10 {
		t.Fatal(u)
	}
	// UTC monthly reset is persisted without destroying old usage receipts.
	c.t = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	u, _ = l.View(ctx, "writer")
	if u.Review.Remaining != 2 || u.Review.ResetsAt != "2026-12-01T00:00:00Z" {
		t.Fatal(u.Review)
	}
}

func TestReviewTrialRefundsOnlyBeforeDurableModelStart(t *testing.T) {
	for _, phase := range []string{"cancel-before", "timeout-before", "prepare-failed", "cancel-after", "timeout-after", "failed-after"} {
		t.Run(phase, func(t *testing.T) {
			l, c := ledger(t)
			ctx := context.Background()
			op := "review:run:1"
			if e := l.Reserve(ctx, "a", op, "review", 100); e != nil {
				t.Fatal(e)
			}
			started := phase == "cancel-after" || phase == "timeout-after" || phase == "failed-after"
			if started {
				if e := l.Authorize(ctx, "a", op, "review"); e != nil {
					t.Fatal(e)
				}
			}
			switch phase {
			case "cancel-before", "cancel-after":
				_ = l.ReleaseUnstartedReview(ctx, "a", op)
			case "timeout-before", "timeout-after":
				c.t = c.t.Add(time.Hour)
			default:
				_ = l.Settle(ctx, "a", op, 0)
			}
			if phase == "cancel-after" {
				_ = l.Settle(ctx, "a", op, 7)
			}
			u, e := l.View(ctx, "a")
			if e != nil {
				t.Fatal(e)
			}
			if started && (u.Review.Used != 1 || u.Review.Remaining != 1) {
				t.Fatal("started call refunded", u)
			}
			if !started && (u.Review.Remaining != 2 || u.Day.Used != 0 || u.Day.Reserved != 0) {
				t.Fatal("unstarted call charged", u)
			}
			if phase == "cancel-after" && u.Day.Used != 7 {
				t.Fatal("known cancel usage should settle actual cost", u)
			}
		})
	}
}

func TestReviewTrialStrictPointReservationAndGlobalPool(t *testing.T) {
	l, _ := ledger(t)
	ctx := context.Background()
	if e := l.Reserve(ctx, "a", "review:oversized:1", "review", 600); code(e) != "PLAN_QUOTA_EXCEEDED" {
		t.Fatal("600 points must not fit Free daily 300", e)
	}
	if e := l.Reserve(ctx, "a", "review:bounded:1", "review", 217); e != nil {
		t.Fatal(e)
	}
	if e := l.Reserve(ctx, "a", "review:second:1", "review", 217); code(e) != "PLAN_QUOTA_EXCEEDED" {
		t.Fatal("concurrent holds must fit daily budget", e)
	}
	_ = l.ReleaseUnstartedReview(ctx, "a", "review:bounded:1")
	if e := WriteControl(ctx, l.State, Control{FreeDailyPoints: 200}); e != nil {
		t.Fatal(e)
	}
	if e := l.Reserve(ctx, "b", "review:global:1", "review", 217); code(e) != "FREE_POOL_EXHAUSTED" {
		t.Fatal("global pool must fit entire hold", e)
	}
	u, _ := l.View(ctx, "b")
	if u.Review.Remaining != 2 {
		t.Fatal("rejected hold consumed quota", u)
	}
}
