package billing

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestTopupsAfterAllowanceEarliestExpiryFirstAndFrozenOnFree(t *testing.T) {
	l, c := ledger(t)
	ctx := context.Background()
	if _, e := l.Grant(ctx, "p", Grant{Plan: Plus, Interval: "month", Periods: 1, Source: "manual"}); e != nil {
		t.Fatal(e)
	}
	if _, e := l.AddTopup(ctx, "p", "late", 3000, "manual"); e != nil {
		t.Fatal(e)
	}
	c.t = c.t.Add(time.Hour)
	if _, e := l.AddTopup(ctx, "p", "later", 3000, "manual"); e != nil {
		t.Fatal(e)
	}
	if _, e := l.AddTopup(ctx, "p", "late", 3000, "manual"); e != nil { // idempotent
		t.Fatal(e)
	}
	// Use the whole 6,000 allowance plus 500 more across several days.
	for day := 0; day < 5; day++ {
		op := "d" + string(rune('0'+day))
		if e := l.Reserve(ctx, "p", op, "thinking", 1); e != nil {
			t.Fatal(day, e)
		}
		_ = l.Settle(ctx, "p", op, 1300)
		c.t = c.t.AddDate(0, 0, 1)
	}
	u, _ := l.View(ctx, "p")
	if u.Month.Used != 6000 || u.Topups.UsedThisMonth != 500 || u.Topups.Left != 5500 || u.ByKind["thinking"] != 6500 {
		t.Fatalf("allowance first, then top-ups: %+v %+v", u.Month, u.Topups)
	}
	if len(u.Topups.Items) != 2 || u.Topups.Items[0].Left != 2500 || u.Topups.Items[1].Left != 3000 {
		t.Fatalf("earliest expiry must be used first: %+v", u.Topups.Items)
	}
	if len(u.Recent) != 5 || u.Recent[0].Points != 1300 {
		t.Fatalf("recent: %+v", u.Recent)
	}
	// Revoking the plan freezes the top-ups: Free's 1,500 allowance is
	// already used this month, so nothing is admitted.
	if _, e := l.Grant(ctx, "p", Grant{Plan: Free}); e != nil {
		t.Fatal(e)
	}
	if code(l.Reserve(ctx, "p", "frozen", "thinking", 1)) != "PLAN_QUOTA_EXCEEDED" {
		t.Fatal("frozen top-ups were usable on Free")
	}
	if u, _ := l.View(ctx, "p"); !u.Topups.Frozen || u.Topups.Left != 5500 {
		t.Fatalf("frozen top-ups must be kept: %+v", u.Topups)
	}
	// A paid plan again unfreezes them.
	_, _ = l.Grant(ctx, "p", Grant{Plan: Pro, Interval: "month", Periods: 1, Source: "manual"})
	if e := l.Reserve(ctx, "p", "thawed", "thinking", 1); e != nil {
		t.Fatal(e)
	}
}

func TestTopupsExpireAfterTwelveMonthsAndDoNotRaiseDailyCap(t *testing.T) {
	l, c := ledger(t)
	ctx := context.Background()
	_, _ = l.Grant(ctx, "p", Grant{Plan: Plus, Interval: "year", Periods: 2, Source: "manual"})
	_, _ = l.AddTopup(ctx, "p", "t", 10000, "manual")
	_ = l.Reserve(ctx, "p", "a", "review", 1)
	_ = l.Settle(ctx, "p", "a", 1500)
	if code(l.Reserve(ctx, "p", "b", "review", 1)) != "PLAN_QUOTA_EXCEEDED" {
		t.Fatal("top-ups must not raise the daily cap")
	}
	c.t = c.t.AddDate(1, 0, 1)
	u, _ := l.View(ctx, "p")
	if u.Topups.Left != 0 || len(u.Topups.Items) != 0 {
		t.Fatalf("top-up outlived 12 months: %+v", u.Topups)
	}
}

func TestGrantExtendsSamePlanReplacesOtherAndExpires(t *testing.T) {
	l, c := ledger(t)
	ctx := context.Background()
	u, e := l.Grant(ctx, "g", Grant{Plan: Plus, Interval: "month", Periods: 1, Source: "manual"})
	if e != nil || u.Plan != Plus || u.ExpiresAt != "2026-11-25T12:00:00Z" || u.Interval != "month" || u.Source != "manual" {
		t.Fatalf("%+v %v", u, e)
	}
	if u, _ = l.Grant(ctx, "g", Grant{Plan: Plus, Interval: "year", Periods: 1, Source: "manual"}); u.ExpiresAt != "2027-11-25T12:00:00Z" {
		t.Fatal("same plan must extend from its expiry", u.ExpiresAt)
	}
	if u, _ = l.Grant(ctx, "g", Grant{Plan: Pro, Interval: "month", Periods: 2, Source: "manual"}); u.Plan != Pro || u.ExpiresAt != "2026-12-25T12:00:00Z" {
		t.Fatal("another plan starts now", u)
	}
	c.t = time.Date(2026, 12, 25, 12, 0, 0, 0, time.UTC)
	if u, _ = l.View(ctx, "g"); u.Plan != Free || u.ExpiresAt != "" || u.Month.Limit != 1500 {
		t.Fatalf("expired plan must fall back to Free: %+v", u)
	}
	if e := l.Allow(ctx, "g", "review"); e != nil {
		t.Fatal("expired plan should fall back to Free trials", e)
	}
	// The legacy owner falls back to Pro, not Free.
	_, _ = l.Grant(ctx, "owner", Grant{Plan: Plus, Interval: "month", Periods: 1, Source: "manual"})
	c.t = c.t.AddDate(0, 2, 0)
	if u, _ = l.View(ctx, "owner"); u.Plan != Pro {
		t.Fatal("legacy owner default", u.Plan)
	}
	for _, bad := range []Grant{{Plan: "gold", Interval: "month", Periods: 1, Source: "manual"}, {Plan: Plus, Interval: "week", Periods: 1, Source: "manual"}, {Plan: Plus, Interval: "month", Periods: 0, Source: "manual"}, {Plan: Plus, Interval: "year", Periods: 4, Source: "manual"}} {
		if _, e := l.Grant(ctx, "g", bad); e == nil {
			t.Fatal("invalid grant accepted", bad)
		}
	}
}

func TestEntitlementsFollowThePlan(t *testing.T) {
	l, _ := ledger(t)
	ctx := context.Background()
	e, _ := l.Entitlements(ctx, "free")
	if e.Plan != "free" || e.Books != 3 || e.Sessions != 1 || e.ImportsPerMonth != 2 || e.Priority {
		t.Fatalf("%+v", e)
	}
	_, _ = l.Grant(ctx, "pro", Grant{Plan: Pro, Interval: "month", Periods: 1, Source: "manual"})
	if e, _ = l.Entitlements(ctx, "pro"); e.Books != 300 || e.Sessions != 4 || e.ImportsPerMonth != 0 || !e.Priority {
		t.Fatalf("%+v", e)
	}
	if e, _ = l.Entitlements(ctx, ""); e.Books != 0 {
		t.Fatal("unmetered owner must be unlimited")
	}
	cache := &PriorityCache{Ledger: l}
	if !cache.Priority(ctx, "pro") || cache.Priority(ctx, "free") || !cache.Priority(ctx, "owner") {
		t.Fatal("priority cache")
	}
}

func TestEmailLookup(t *testing.T) {
	l, _ := ledger(t)
	ctx := context.Background()
	_ = l.RecordEmail(ctx, "u-1", " Writer@Example.com ")
	_ = l.RecordEmail(ctx, "u-2", "other@example.com")
	found, e := FindByEmail(l.State, "writer@example.COM")
	if e != nil || len(found) != 1 || found[0] != "u-1" {
		t.Fatal(found, e)
	}
	if !AccountExists(l.State, "u-2") || AccountExists(l.State, "u-3") {
		t.Fatal("AccountExists")
	}
}

func TestRedeemPlanAndTopupCodes(t *testing.T) {
	l, c := ledger(t)
	ctx := context.Background()
	plan, e := CreateCodes(ctx, l.State, CodeSpec{Kind: "plan", Plan: Plus, Interval: "month", Periods: 1}, 2, time.Time{}, "beta")
	if e != nil || len(plan) != 2 || !strings.HasPrefix(plan[0], "WA-") || len(plan[0]) != 22 {
		t.Fatal(plan, e)
	}
	// Typed loosely: lower case, no dashes, O for 0.
	loose := strings.ToLower(strings.ReplaceAll(plan[0], "-", ""))
	u, e := l.Redeem(ctx, "alice", strings.ReplaceAll(loose, "0", "o"))
	if e != nil || u.Plan != Plus || u.Source != "code" || u.ExpiresAt != "2026-11-25T12:00:00Z" {
		t.Fatal(u, e)
	}
	if u, e = l.Redeem(ctx, "alice", plan[0]); e != nil || u.ExpiresAt != "2026-11-25T12:00:00Z" {
		t.Fatal("same owner replay must not extend again", u.ExpiresAt, e)
	}
	if code(func() error { _, e := l.Redeem(ctx, "bob", plan[0]); return e }()) != "CODE_USED" {
		t.Fatal("code reused by another account")
	}
	// The second Plus code extends; a Pro code conflicts with active Plus.
	if u, _ = l.Redeem(ctx, "alice", plan[1]); u.ExpiresAt != "2026-12-25T12:00:00Z" {
		t.Fatal("second code must extend", u.ExpiresAt)
	}
	pro, _ := CreateCodes(ctx, l.State, CodeSpec{Kind: "plan", Plan: Pro, Interval: "year", Periods: 1}, 1, time.Time{}, "")
	if code(func() error { _, e := l.Redeem(ctx, "alice", pro[0]); return e }()) != "PLAN_CONFLICT" {
		t.Fatal("conflicting plan code accepted")
	}
	// Top-up codes need a paid plan.
	top, _ := CreateCodes(ctx, l.State, CodeSpec{Kind: "topup", Points: 3000}, 1, time.Now().UTC().Add(time.Hour), "")
	if code(func() error { _, e := l.Redeem(ctx, "carol", top[0]); return e }()) != "PLAN_FEATURE_REQUIRED" {
		t.Fatal("Free account redeemed a top-up")
	}
	if u, e = l.Redeem(ctx, "alice", top[0]); e != nil || u.Topups.Left != 3000 {
		t.Fatal(u.Topups, e)
	}
	// Expired codes are refused.
	old, _ := CreateCodes(ctx, l.State, CodeSpec{Kind: "topup", Points: 3000}, 1, time.Now().Add(time.Hour), "")
	c.t = time.Now().Add(2 * time.Hour)
	if code(func() error { _, e := l.Redeem(ctx, "alice", old[0]); return e }()) != "CODE_EXPIRED" {
		t.Fatal("expired code accepted")
	}
	list, _ := ListCodes(l.State)
	if len(list) != 5 {
		t.Fatal(len(list))
	}
	for _, info := range list {
		if strings.Contains(strings.Join(plan, ""), info.Digest) {
			t.Fatal("listing leaked a code")
		}
	}
}

func TestRedeemGuessesAreRateLimited(t *testing.T) {
	l, c := ledger(t)
	ctx := context.Background()
	for i := 0; i < maxRedeemFails; i++ {
		if code(func() error { _, e := l.Redeem(ctx, "mallory", "WA-0000-0000-0000-000"+string(rune('0'+i))); return e }()) != "CODE_INVALID" {
			t.Fatal(i)
		}
	}
	if code(func() error { _, e := l.Redeem(ctx, "mallory", "not a code"); return e }()) != "REDEEM_RATE_LIMITED" {
		t.Fatal("guessing not limited")
	}
	c.t = c.t.AddDate(0, 0, 1)
	if code(func() error { _, e := l.Redeem(ctx, "mallory", "nope"); return e }()) != "CODE_INVALID" {
		t.Fatal("limit must reset daily")
	}
}

func TestCodeSpecValidation(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	for _, bad := range []CodeSpec{{Kind: "plan", Plan: Free, Interval: "month", Periods: 1}, {Kind: "plan", Plan: Plus, Interval: "month", Periods: 1, Points: 5}, {Kind: "topup", Points: 0}, {Kind: "topup", Points: 10, Plan: Pro}, {Kind: "gift"}} {
		if _, e := CreateCodes(ctx, dir, bad, 1, time.Time{}, ""); e == nil {
			t.Fatal("invalid spec accepted", bad)
		}
	}
	if _, e := CreateCodes(ctx, dir, CodeSpec{Kind: "topup", Points: 10}, 1, time.Now().Add(-time.Hour), ""); e == nil {
		t.Fatal("past expiry accepted")
	}
}
