package billing

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

// Fail before/after every durable write (intent, account, code/pool). A fresh
// Ledger models a different API/Worker process recovering the interrupted write.
func TestBillingWriteFailuresRecoverExactlyOnce(t *testing.T) {
	for _, operation := range []string{"redeem", "reserve", "settle"} {
		for boundary := 1; boundary <= 3; boundary++ {
			for _, after := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%d/after=%v", operation, boundary, after), func(t *testing.T) {
					l, _ := ledger(t)
					ctx := context.Background()
					codes, err := CreateCodes(ctx, l.State, CodeSpec{Kind: "plan", Plan: Plus, Interval: "month", Periods: 1}, 1, time.Time{}, "fixture")
					if err != nil {
						t.Fatal(err)
					}
					if operation == "settle" {
						if err := l.Reserve(ctx, "alice", "shared", "thinking", 50); err != nil {
							t.Fatal(err)
						}
					}
					invoke := func(x *Ledger) error {
						switch operation {
						case "redeem":
							_, e := x.Redeem(ctx, "alice", codes[0])
							return e
						case "reserve":
							return x.Reserve(ctx, "alice", "shared", "thinking", 50)
						default:
							return x.Settle(ctx, "alice", "shared", 7)
						}
					}
					writes := 0
					durable := &Ledger{State: l.State, Now: l.Now}
					l.write = func(ctx context.Context, path string, v any) error {
						writes++
						if writes == boundary && !after {
							return errors.New("injected disk error")
						}
						if err := durable.writeState(ctx, path, v); err != nil {
							return err
						}
						if writes == boundary && after {
							return errors.New("injected ambiguous disk error")
						}
						return nil
					}
					if invoke(l) == nil {
						t.Fatal("fault was not injected")
					}
					other := &Ledger{State: l.State, Now: l.Now}
					committed := boundary > 1 || after
					if operation == "redeem" && committed {
						if _, e := other.Redeem(ctx, "bob", codes[0]); code(e) != "CODE_USED" {
							t.Fatal("another user acquired committed code", e)
						}
					}
					if err := invoke(other); err != nil {
						t.Fatal(err)
					}
					if err := invoke(other); err != nil {
						t.Fatal("retry", err)
					}
					u, err := other.View(ctx, "alice")
					if err != nil {
						t.Fatal(err)
					}
					switch operation {
					case "redeem":
						if u.ExpiresAt != "2026-11-25T12:00:00Z" {
							t.Fatal("double grant", u.ExpiresAt)
						}
						if _, e := other.Redeem(ctx, "bob", codes[0]); code(e) != "CODE_USED" {
							t.Fatal(e)
						}
					case "reserve", "settle":
						var p pool
						if _, err := storage.Read(other.poolPath("2026-10-25"), &p); err != nil {
							t.Fatal(err)
						}
						if operation == "reserve" && (len(p.Open) != 1 || p.Open[poolOp("alice", "shared")] != 50 || u.Day.Reserved != 50) {
							t.Fatal("orphan/missing reservation", p, u.Day)
						}
						if operation == "settle" && (p.Used != 7 || len(p.Open) != 0 || u.Day.Used != 7 || u.Day.Reserved != 0) {
							t.Fatal("duplicate settlement", p, u.Day)
						}
					}
					if _, err := os.Stat(filepath.Join(l.dir(), "pending-v1.json")); !os.IsNotExist(err) {
						t.Fatal("journal not cleared", err)
					}
				})
			}
		}
	}
}

func TestBillingCrashHelper(t *testing.T) {
	state := os.Getenv("BILLING_CRASH_STATE")
	if state == "" {
		return
	}
	l := &Ledger{State: state}
	durable := &Ledger{State: state}
	l.write = func(ctx context.Context, path string, v any) error {
		if err := durable.writeState(ctx, path, v); err != nil {
			return err
		}
		if path == l.accountPath("alice") {
			os.Exit(87)
		}
		return nil
	}
	if _, err := l.Redeem(context.Background(), "alice", os.Getenv("BILLING_CRASH_CODE")); err != nil {
		t.Fatal(err)
	}
	t.Fatal("crash point not reached")
}

func TestRedemptionRecoversAfterProcessDeath(t *testing.T) {
	l := &Ledger{State: t.TempDir()}
	ctx := context.Background()
	codes, err := CreateCodes(ctx, l.State, CodeSpec{Kind: "plan", Plan: Plus, Interval: "month", Periods: 1}, 1, time.Time{}, "crash")
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestBillingCrashHelper$")
	child.Env = append(os.Environ(), "BILLING_CRASH_STATE="+l.State, "BILLING_CRASH_CODE="+codes[0])
	if err := child.Run(); err == nil {
		t.Fatal("child did not crash")
	}
	// Different author/process must first roll forward Alice's committed claim.
	if _, err := l.Redeem(ctx, "bob", codes[0]); code(err) != "CODE_USED" {
		t.Fatal("code issued twice", err)
	}
	first, err := l.View(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	second, err := l.Redeem(ctx, "alice", codes[0])
	if err != nil {
		t.Fatal(err)
	}
	if first.Plan != Plus || first.ExpiresAt != second.ExpiresAt {
		t.Fatal("claim not idempotent", first, second)
	}
}

func TestPoolOperationIDsAreScopedToAuthor(t *testing.T) {
	l, _ := ledger(t)
	ctx := context.Background()
	for _, owner := range []string{"alice", "bob"} {
		if err := l.Reserve(ctx, owner, "same", "knowledge", 50); err != nil {
			t.Fatal(err)
		}
	}
	if err := l.Settle(ctx, "alice", "same", 7); err != nil {
		t.Fatal(err)
	}
	var p pool
	if _, err := storage.Read(l.poolPath("2026-10-25"), &p); err != nil {
		t.Fatal(err)
	}
	if p.Used != 7 || p.Open[poolOp("bob", "same")] != 50 || len(p.Open) != 1 {
		t.Fatal(p)
	}
}

func TestReviewAuthorizationAfterDowngradeAndExpiry(t *testing.T) {
	for _, expire := range []bool{false, true} {
		t.Run(fmt.Sprint(expire), func(t *testing.T) {
			l, c := ledger(t)
			ctx := context.Background()
			if _, err := l.Grant(ctx, "alice", Grant{Plan: Plus, Interval: "month", Periods: 1, Source: "manual"}); err != nil {
				t.Fatal(err)
			}
			if err := l.Reserve(ctx, "alice", "claimed", "review", 50); err != nil {
				t.Fatal(err)
			}
			if expire {
				c.t = c.t.AddDate(0, 1, 0)
			} else if err := l.SetPlan(ctx, "alice", Free); err != nil {
				t.Fatal(err)
			}
			for _, op := range []string{"claimed", "new"} {
				if code(l.Reserve(ctx, "alice", op, "review", 50)) != "PLAN_FEATURE_REQUIRED" {
					t.Fatal("queued review admitted")
				}
			}
			if code(l.Authorize(ctx, "alice", "claimed", "review")) != "PLAN_FEATURE_REQUIRED" {
				t.Fatal("claimed review executed")
			}
		})
	}
}

func TestConcurrentRedemptionHasOneOwner(t *testing.T) {
	l, _ := ledger(t)
	ctx := context.Background()
	codes, e := CreateCodes(ctx, l.State, CodeSpec{Kind: "plan", Plan: Plus, Interval: "month", Periods: 1}, 1, time.Time{}, "concurrent")
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	results := make([]error, 12)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			other := &Ledger{State: l.State, Now: l.Now}
			_, results[i] = other.Redeem(ctx, fmt.Sprint(i), codes[0])
		}(i)
	}
	wg.Wait()
	success := 0
	for _, err := range results {
		if err == nil {
			success++
		} else if code(err) != "CODE_USED" {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatal("multiple owners", success)
	}
}

func TestMultipleExpiredHoldsSettleIntoOnePoolImage(t *testing.T) {
	l, c := ledger(t)
	ctx := context.Background()
	for _, op := range []string{"one", "two"} {
		if err := l.Reserve(ctx, "alice", op, "knowledge", 40); err != nil {
			t.Fatal(err)
		}
	}
	c.t = c.t.AddDate(0, 0, 1)
	for range 2 {
		if _, err := l.View(ctx, "alice"); err != nil {
			t.Fatal(err)
		}
	}
	var p pool
	if _, err := storage.Read(l.poolPath("2026-10-25"), &p); err != nil {
		t.Fatal(err)
	}
	if p.Used != 80 || len(p.Open) != 0 {
		t.Fatal("expired holds lost or doubled", p)
	}
	u, err := l.View(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if u.Month.Used != 80 || u.Day.Used != 0 || u.Day.Reserved != 0 {
		t.Fatal(u)
	}
}
