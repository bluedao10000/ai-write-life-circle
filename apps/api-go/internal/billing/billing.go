// Package billing meters model usage per author in AI points and holds each
// author's plan (harness/design/pricing-plans.md).
//
// 1 point = 1,000 billable tokens, where billable = uncached input +
// 0.02 × cached input + 4 × output (the
// DeepSeek flash peak price ratio). Every model call follows reserve → settle:
//   - Reserve before the call. An operation is admitted while the account's
//     open reservations are below what is left of its monthly allowance plus
//     active top-ups, and settled + open usage is below the daily limit (and,
//     for Free, the site-wide Free pool). An account can therefore overrun by
//     at most one operation.
//   - Settle with the actual usage afterwards (or release with 0 when no model
//     call happened). Settling is idempotent per operation ID. Settled points
//     use the monthly allowance first, then top-ups (earliest expiry first).
//   - A reservation that is never settled is charged in full once its lease
//     expires: unknown usage is never refunded.
//
// Plans are granted by an operator or a redeem code until payments exist
// (Phase 2). A granted plan carries an expiry; afterwards the account falls
// back to its default (Free, or Pro for the legacy owner). Top-ups are frozen
// while the account is on Free.
//
// State lives under <state>/billing as atomic JSON guarded by the shared
// kernel lock and recoverable redo journal, so the API and Worker processes can both meter.
package billing

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

type Plan string

const (
	Free Plan = "free"
	Plus Plan = "plus"
	Pro  Plan = "pro"
)

// Limits are the allowances and prices of a plan. For Books, Sessions and
// ImportsPerMonth a zero value means unlimited.
type Limits struct {
	Monthly         int  `json:"monthly"`
	Daily           int  `json:"daily"`
	Review          bool `json:"review"`
	Topups          bool `json:"topups"`
	Books           int  `json:"books"`
	Sessions        int  `json:"sessions"`
	ImportsPerMonth int  `json:"importsPerMonth"`
	Priority        bool `json:"priority"`
	MonthlyUSDCents int  `json:"monthlyUsdCents"`
	YearlyUSDCents  int  `json:"yearlyUsdCents"`
}

// Plans mirrors the confirmed pricing table (§3). Pro's 300 books is the
// fair-use cap of "unlimited".
var Plans = map[Plan]Limits{
	Free: {Monthly: 1500, Daily: 300, Books: 3, Sessions: 1, ImportsPerMonth: 2},
	Plus: {Monthly: 6000, Daily: 1500, Review: true, Topups: true, Books: 30, Sessions: 2, MonthlyUSDCents: 499, YearlyUSDCents: 4900},
	Pro:  {Monthly: 18000, Daily: 4000, Review: true, Topups: true, Books: 300, Sessions: 4, Priority: true, MonthlyUSDCents: 1299, YearlyUSDCents: 12900},
}

// Pack is a top-up offer (paid plans only).
type Pack struct {
	Points   int `json:"points"`
	USDCents int `json:"usdCents"`
}

var Packs = []Pack{{Points: 3000, USDCents: 299}, {Points: 10000, USDCents: 899}}

const (
	// DefaultFreeDailyPoints caps all Free accounts together per UTC day
	// (about $60 at worst-case peak pricing).
	DefaultFreeDailyPoints = 200000
	defaultTTL             = 15 * time.Minute
	maxDone                = 2000
	maxRecent              = 50
	maxTopups              = 100
	// MaxTopupPoints bounds one operator or code top-up.
	MaxTopupPoints = 1000000
	topupLifetime  = 12 // months
)

const PricingVersion = "ai-points-cache-v1"

// PointsFor counts input inclusive of cached tokens. Integer hundredths avoid
// rounding away the 0.02 cache rate before the final point ceiling.
func PointsFor(input, output int, cachedInput ...int) int {
	cached := 0
	if len(cachedInput) > 0 && cachedInput[0] >= 0 && cachedInput[0] <= max(input, 0) {
		cached = cachedInput[0]
	}
	billable := 100*(max(input, 0)-cached) + 2*cached + 400*max(output, 0)
	if billable <= 0 {
		return 0
	}
	return (billable + 99999) / 100000
}

// Ledger implements application.Meter.
type Ledger struct {
	State string
	// LegacyOwner is the configured author (the site owner). It is on Pro
	// unless its account records another plan.
	LegacyOwner string
	TTL         time.Duration
	Now         func() time.Time
	// write is overridden only by fault-injection tests.
	write func(context.Context, string, any) error
}

var _ application.Meter = (*Ledger)(nil)

type hold struct {
	PricingVersion string `json:"pricingVersion,omitempty"`
	Kind           string `json:"kind"`
	Points         int    `json:"points"`
	Month          string `json:"month"`
	Day            string `json:"day"`
	Expires        string `json:"expiresAt"`
	Free           bool   `json:"free,omitempty"`
}

type topup struct {
	ID      string `json:"id"`
	Points  int    `json:"points"`
	Left    int    `json:"left"`
	Granted string `json:"grantedAt"`
	Expires string `json:"expiresAt"`
	Source  string `json:"source"`
}

type entry struct {
	PricingVersion string `json:"pricingVersion,omitempty"`
	Kind           string `json:"kind"`
	Points         int    `json:"points"`
	At             string `json:"at"`
}

type account struct {
	tx *transaction

	Schema int    `json:"schema"`
	Actor  string `json:"actorId"`
	// Plan is an explicit plan; PlanUntil (RFC 3339) bounds it when set.
	Plan      Plan   `json:"plan,omitempty"`
	Interval  string `json:"interval,omitempty"`
	Source    string `json:"source,omitempty"`
	PlanUntil string `json:"planUntil,omitempty"`
	// Email is the last verified sign-in email, for operator lookup only.
	Email     string            `json:"email,omitempty"`
	Month     string            `json:"month"`
	MonthUsed int               `json:"monthUsed"`
	TopupUsed int               `json:"topupUsed,omitempty"`
	ByKind    map[string]int    `json:"byKind,omitempty"`
	Day       string            `json:"day"`
	DayUsed   int               `json:"dayUsed"`
	Topups    []topup           `json:"topups,omitempty"`
	Recent    []entry           `json:"recent,omitempty"`
	Open      map[string]hold   `json:"open"`
	Done      map[string]string `json:"done"`
	// Redeemed maps redeem-code digests to the redemption time.
	Redeemed    map[string]string `json:"redeemed,omitempty"`
	RedeemDay   string            `json:"redeemDay,omitempty"`
	RedeemFails int               `json:"redeemFails,omitempty"`
}

type pool struct {
	Schema int            `json:"schema"`
	Day    string         `json:"day"`
	Used   int            `json:"used"`
	Open   map[string]int `json:"open"`
}

// Control is the operator switch shared by every process (writer-agent-control).
type Control struct {
	Schema int `json:"schema"`
	// Paused is "", "free" (Free accounts only) or "all".
	Paused string `json:"paused,omitempty"`
	// FreeDailyPoints overrides DefaultFreeDailyPoints when positive.
	FreeDailyPoints int `json:"freeDailyPoints,omitempty"`
}

func (l *Ledger) now() time.Time {
	if l.Now != nil {
		return l.Now().UTC()
	}
	return time.Now().UTC()
}
func (l *Ledger) ttl() time.Duration {
	if l.TTL > 0 {
		return l.TTL
	}
	return defaultTTL
}
func (l *Ledger) dir() string { return filepath.Join(l.State, "billing") }
func (l *Ledger) accountPath(actor string) string {
	return filepath.Join(l.dir(), "accounts", compat.Key(actor)+".json")
}
func (l *Ledger) poolPath(day string) string { return filepath.Join(l.dir(), "free-pool", day+".json") }
func ControlPath(state string) string        { return filepath.Join(state, "billing", "control-v1.json") }

// ReadControl returns the operator switch (zero value when unset).
func ReadControl(state string) (Control, error) {
	var out Control
	err := (&Ledger{State: state}).transaction(context.Background(), func(_ *transaction) error {
		var err error
		out, err = readControl(state)
		return err
	})
	return out, err
}

func readControl(state string) (Control, error) {
	var c Control
	found, e := storage.Read(ControlPath(state), &c)
	if e != nil {
		return Control{}, e
	}
	if found && c.Schema != 1 {
		return Control{}, fmt.Errorf("invalid billing control")
	}
	return c, nil
}

// WriteControl updates the operator switch atomically.
func WriteControl(ctx context.Context, state string, c Control) error {
	if c.Paused != "" && c.Paused != "free" && c.Paused != "all" {
		return fmt.Errorf("paused must be empty, free or all")
	}
	c.Schema = 1
	return (&Ledger{State: state}).transaction(ctx, func(tx *transaction) error { return tx.put(ControlPath(state), c) })
}

func before(now time.Time, rfc string) bool {
	t, e := time.Parse(time.RFC3339Nano, rfc)
	return e == nil && now.Before(t)
}

// explicit reports the account's own plan while it is in force.
func explicit(a account, now time.Time) (Plan, bool) {
	if _, ok := Plans[a.Plan]; !ok {
		return "", false
	}
	if a.PlanUntil != "" && !before(now, a.PlanUntil) {
		return "", false
	}
	return a.Plan, true
}

func (l *Ledger) planOf(a account, now time.Time) Plan {
	if p, ok := explicit(a, now); ok {
		return p
	}
	if l.LegacyOwner != "" && a.Actor == l.LegacyOwner {
		return Pro
	}
	return Free
}

func (l *Ledger) load(actor string) (account, error) {
	a := account{Schema: 1, Actor: actor, Open: map[string]hold{}, Done: map[string]string{}}
	found, e := storage.Read(l.accountPath(actor), &a)
	if e != nil {
		return a, e
	}
	if found && (a.Schema != 1 || a.Actor != actor) {
		return a, fmt.Errorf("invalid billing account")
	}
	if a.Open == nil {
		a.Open = map[string]hold{}
	}
	if a.Done == nil {
		a.Done = map[string]string{}
	}
	return a, nil
}

// withAccount runs fn on the locked, rolled-over account and persists it.
func (l *Ledger) withAccount(ctx context.Context, actor string, fn func(*account, time.Time) error) error {
	return l.transaction(ctx, func(tx *transaction) error {
		return l.accountTransaction(ctx, tx, actor, fn)
	})
}

func (l *Ledger) accountTransaction(ctx context.Context, tx *transaction, actor string, fn func(*account, time.Time) error) error {
	path := l.accountPath(actor)
	a, e := l.load(actor)
	if e != nil {
		return e
	}
	a.tx = tx
	now := l.now()
	month, day := now.Format("2006-01"), now.Format("2006-01-02")
	if a.Month != month {
		a.Month, a.MonthUsed, a.TopupUsed, a.ByKind = month, 0, 0, nil
	}
	if a.Day != day {
		a.Day, a.DayUsed = day, 0
	}
	// Expired reservations are charged in full: the model may have run.
	for op, h := range a.Open {
		if before(now, h.Expires) {
			continue
		}
		if e := l.finish(ctx, &a, op, h, h.Points, now); e != nil {
			return e
		}
	}
	if e := fn(&a, now); e != nil {
		return e
	}
	l.prune(&a, now)
	return tx.put(path, a)
}

// activeTopups returns indices of usable top-ups, earliest expiry first.
func activeTopups(a account, now time.Time) []int {
	out := []int{}
	for i, t := range a.Topups {
		if t.Left > 0 && before(now, t.Expires) {
			out = append(out, i)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return a.Topups[out[i]].Expires < a.Topups[out[j]].Expires })
	return out
}

func topupLeft(a account, now time.Time) int {
	n := 0
	for _, i := range activeTopups(a, now) {
		n += a.Topups[i].Left
	}
	return n
}

func (l *Ledger) finish(ctx context.Context, a *account, op string, h hold, charge int, now time.Time) error {
	charge = max(charge, 0)
	if h.Month == a.Month {
		limits := Plans[l.planOf(*a, now)]
		rest := charge - min(charge, max(limits.Monthly-a.MonthUsed, 0))
		a.MonthUsed += charge - rest
		if rest > 0 && limits.Topups {
			for _, i := range activeTopups(*a, now) {
				take := min(rest, a.Topups[i].Left)
				a.Topups[i].Left -= take
				a.TopupUsed += take
				rest -= take
				if rest == 0 {
					break
				}
			}
		}
		// Whatever neither covers is the one admitted overrun.
		a.MonthUsed += rest
		if charge > 0 {
			if a.ByKind == nil {
				a.ByKind = map[string]int{}
			}
			a.ByKind[h.Kind] += charge
		}
	}
	if h.Day == a.Day {
		a.DayUsed += charge
	}
	if h.Free {
		if e := l.withPool(a.tx, h.Day, func(p *pool) { delete(p.Open, poolOp(a.Actor, op)); delete(p.Open, op); p.Used += charge }); e != nil {
			return e
		}
	}
	if charge > 0 {
		a.Recent = append(a.Recent, entry{PricingVersion: h.PricingVersion, Kind: h.Kind, Points: charge, At: now.Format(time.RFC3339)})
		if len(a.Recent) > maxRecent {
			a.Recent = a.Recent[len(a.Recent)-maxRecent:]
		}
	}
	delete(a.Open, op)
	a.Done[op] = a.Day
	return nil
}

func (l *Ledger) prune(a *account, now time.Time) {
	cutoff := now.AddDate(0, 0, -40).Format("2006-01-02")
	for op, day := range a.Done {
		if day < cutoff {
			delete(a.Done, op)
		}
	}
	// Top-ups are dropped 40 days after they expire; the grace keeps them
	// visible to operators handling a support request.
	kept := a.Topups[:0]
	stale := now.AddDate(0, 0, -40)
	for _, t := range a.Topups {
		if before(stale, t.Expires) {
			kept = append(kept, t)
		}
	}
	a.Topups = kept
	if len(a.Topups) == 0 {
		a.Topups = nil
	}
	if len(a.Done) <= maxDone {
		return
	}
	ops := make([]string, 0, len(a.Done))
	for op := range a.Done {
		ops = append(ops, op)
	}
	sort.Slice(ops, func(i, j int) bool { return a.Done[ops[i]] < a.Done[ops[j]] })
	for _, op := range ops[:len(ops)-maxDone] {
		delete(a.Done, op)
	}
}

func (l *Ledger) withPool(tx *transaction, day string, fn func(*pool)) error {
	path := l.poolPath(day)
	p := pool{Schema: 1, Day: day, Open: map[string]int{}}
	found, e := tx.read(path, &p)
	if e != nil {
		return e
	}
	if found && (p.Schema != 1 || p.Day != day) {
		return fmt.Errorf("invalid free pool")
	}
	if p.Open == nil {
		p.Open = map[string]int{}
	}
	fn(&p)
	return tx.put(path, p)
}

func outstanding(a account) (month, day int) {
	for _, h := range a.Open {
		if h.Month == a.Month {
			month += h.Points
		}
		if h.Day == a.Day {
			day += h.Points
		}
	}
	return
}

func paused(c Control, plan Plan) bool {
	return c.Paused == "all" || (c.Paused == "free" && plan == Free)
}

// Errors are author-facing; codes are stable for the web client.
func pausedError() error {
	return application.Fail(503, "AI_PAUSED", "AI 功能暂时暂停，写作和保存不受影响。")
}
func quotaError(scope string) error {
	switch scope {
	case "day":
		return application.Fail(402, "PLAN_QUOTA_EXCEEDED", "今天的 AI 点数已用完，明天（UTC 0 点）恢复。写作和保存不受影响。")
	case "pool":
		return application.Fail(402, "FREE_POOL_EXHAUSTED", "今天的免费 AI 额度已全部用完，明天（UTC 0 点）恢复。写作和保存不受影响。")
	case "month-topups":
		return application.Fail(402, "PLAN_QUOTA_EXCEEDED", "本月的 AI 点数和加油包都已用完，下月 1 日（UTC）恢复。写作和保存不受影响。")
	}
	return application.Fail(402, "PLAN_QUOTA_EXCEEDED", "本月的 AI 点数已用完，下月 1 日（UTC）恢复。写作和保存不受影响。")
}

func (l *Ledger) admit(a account, plan Plan, c Control, now time.Time) error {
	if paused(c, plan) {
		return pausedError()
	}
	limits := Plans[plan]
	month, day := outstanding(a)
	available := max(limits.Monthly-a.MonthUsed, 0)
	if limits.Topups {
		available += topupLeft(a, now)
	}
	if month >= available {
		if limits.Topups {
			return quotaError("month-topups")
		}
		return quotaError("month")
	}
	if a.DayUsed+day >= limits.Daily {
		return quotaError("day")
	}
	return nil
}

// Allow reports whether the owner may start an author-initiated AI feature now.
func (l *Ledger) Allow(ctx context.Context, owner, feature string) error {
	if owner == "" {
		return nil
	}
	var out error
	e := l.withAccount(ctx, owner, func(a *account, now time.Time) error {
		c, err := readControl(l.State)
		if err != nil {
			return err
		}
		plan := l.planOf(*a, now)
		if feature == "review" && !Plans[plan].Review {
			out = application.Fail(402, "PLAN_FEATURE_REQUIRED", "连续性审查需要 Plus 或 Pro 方案。写作和其他功能不受影响。")
			return nil
		}
		out = l.admit(*a, plan, c, now)
		return nil
	})
	if e != nil {
		return e
	}
	return out
}

// Reserve holds points for one model call before it happens.
func (l *Ledger) Reserve(ctx context.Context, owner, op, kind string, points int) error {
	if owner == "" {
		return nil
	}
	if op == "" || len(op) > 256 {
		return fmt.Errorf("invalid billing operation")
	}
	var out error
	e := l.withAccount(ctx, owner, func(a *account, now time.Time) error {
		c, err := readControl(l.State)
		if err != nil {
			return err
		}
		plan := l.planOf(*a, now)
		if kind == "review" && !Plans[plan].Review {
			out = application.Fail(402, "PLAN_FEATURE_REQUIRED", "连续性审查需要 Plus 或 Pro 方案。")
			return nil
		}
		if _, ok := a.Done[op]; ok {
			return nil
		}
		if h, ok := a.Open[op]; ok {
			if h.Kind != kind {
				return fmt.Errorf("billing operation kind mismatch")
			}
			return nil
		}
		if out = l.admit(*a, plan, c, now); out != nil {
			return nil
		}
		h := hold{PricingVersion: PricingVersion, Kind: kind, Points: max(points, 1), Month: a.Month, Day: a.Day, Expires: now.Add(l.ttl()).Format(time.RFC3339Nano), Free: plan == Free}
		if h.Free {
			cap := c.FreeDailyPoints
			if cap <= 0 {
				cap = DefaultFreeDailyPoints
			}
			if e := l.withPool(a.tx, a.Day, func(p *pool) {
				open := 0
				for _, v := range p.Open {
					open += v
				}
				if p.Used+open >= cap {
					out = quotaError("pool")
					return
				}
				p.Open[poolOp(a.Actor, op)] = h.Points
			}); e != nil {
				return e
			}
			if out != nil {
				return nil
			}
		}
		a.Open[op] = h
		return nil
	})
	if e != nil {
		return e
	}
	return out
}

// Authorize checks current rights without charging the account's own open hold
// against admission a second time. It is shared by Go and Pi execution starts.
func (l *Ledger) Authorize(ctx context.Context, owner, op, kind string) error {
	if owner == "" {
		return nil
	}
	return l.withAccount(ctx, owner, func(a *account, now time.Time) error {
		plan := l.planOf(*a, now)
		if kind == "review" && !Plans[plan].Review {
			return application.Fail(402, "PLAN_FEATURE_REQUIRED", "连续性审查需要 Plus 或 Pro 方案。")
		}
		control, err := readControl(l.State)
		if err != nil {
			return err
		}
		if paused(control, plan) {
			return pausedError()
		}
		h, ok := a.Open[op]
		if !ok || h.Kind != kind || !before(now, h.Expires) {
			return application.Fail(409, "BILLING_RESERVATION_EXPIRED", "AI 点数预留已失效，请重新发起。")
		}
		return nil
	})
}

// Settle records the actual points of a reserved operation; points < 0
// charges the full reservation (usage unknown). Unknown or already settled
// operations are ignored.
func (l *Ledger) Settle(ctx context.Context, owner, op string, points int) error {
	if owner == "" || op == "" {
		return nil
	}
	return l.withAccount(ctx, owner, func(a *account, now time.Time) error {
		h, ok := a.Open[op]
		if !ok {
			return nil
		}
		if points < 0 {
			points = h.Points
		}
		return l.finish(ctx, a, op, h, points, now)
	})
}

// Entitlements returns the non-AI limits of the owner's current plan. It
// recovers pending billing writes before reading the account snapshot.
func (l *Ledger) Entitlements(ctx context.Context, owner string) (application.Entitlements, error) {
	if owner == "" {
		return application.Entitlements{}, nil
	}
	var out application.Entitlements
	err := l.transaction(ctx, func(_ *transaction) error {
		a, err := l.load(owner)
		if err != nil {
			return err
		}
		plan := l.planOf(a, l.now())
		limits := Plans[plan]
		out = application.Entitlements{Plan: string(plan), Books: limits.Books, Sessions: limits.Sessions, ImportsPerMonth: limits.ImportsPerMonth, Priority: limits.Priority}
		return nil
	})
	return out, err
}

// Usage is the author-facing view of an account.
type Usage struct {
	Plan Plan `json:"plan"`
	// Interval, Source and ExpiresAt describe a granted plan; empty for the
	// default plan.
	Interval  string          `json:"interval,omitempty"`
	Source    string          `json:"source,omitempty"`
	ExpiresAt string          `json:"expiresAt,omitempty"`
	Month     Window          `json:"month"`
	Day       Window          `json:"day"`
	Topups    TopupView       `json:"topups"`
	Features  map[string]bool `json:"features"`
	Limits    PlanLimits      `json:"limits"`
	ByKind    map[string]int  `json:"byKind"`
	Recent    []Entry         `json:"recent"`
	Paused    bool            `json:"paused"`
	// Counts is filled by the API with the author's books and imports.
	Counts  *Counts `json:"counts,omitempty"`
	Catalog Catalog `json:"catalog"`
}
type Window struct {
	Limit    int    `json:"limit"`
	Used     int    `json:"used"`
	Reserved int    `json:"reserved"`
	ResetsAt string `json:"resetsAt"`
}
type TopupView struct {
	// Left is the usable balance; while Frozen (Free plan) it cannot be used.
	Left          int         `json:"left"`
	Frozen        bool        `json:"frozen"`
	UsedThisMonth int         `json:"usedThisMonth"`
	Items         []TopupItem `json:"items"`
}
type TopupItem struct {
	Points    int    `json:"points"`
	Left      int    `json:"left"`
	ExpiresAt string `json:"expiresAt"`
}
type PlanLimits struct {
	Books           int  `json:"books"`
	Sessions        int  `json:"sessions"`
	ImportsPerMonth int  `json:"importsPerMonth"`
	Priority        bool `json:"priority"`
}
type Entry struct {
	PricingVersion string `json:"pricingVersion,omitempty"`
	Kind           string `json:"kind"`
	Points         int    `json:"points"`
	At             string `json:"at"`
}
type Counts struct {
	Books            int `json:"books"`
	ImportsThisMonth int `json:"importsThisMonth"`
}
type CatalogPlan struct {
	ID Plan `json:"id"`
	Limits
}
type Catalog struct {
	Plans []CatalogPlan `json:"plans"`
	Packs []Pack        `json:"packs"`
}

// PlanCatalog lists the offers in display order.
func PlanCatalog() Catalog {
	out := Catalog{Packs: append([]Pack(nil), Packs...)}
	for _, p := range []Plan{Free, Plus, Pro} {
		out.Plans = append(out.Plans, CatalogPlan{ID: p, Limits: Plans[p]})
	}
	return out
}

func (l *Ledger) view(a account, now time.Time, c Control) Usage {
	plan := l.planOf(a, now)
	limits := Plans[plan]
	month, day := outstanding(a)
	first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	tomorrow := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
	u := Usage{
		Plan:     plan,
		Month:    Window{Limit: limits.Monthly, Used: a.MonthUsed, Reserved: month, ResetsAt: first.AddDate(0, 1, 0).Format(time.RFC3339)},
		Day:      Window{Limit: limits.Daily, Used: a.DayUsed, Reserved: day, ResetsAt: tomorrow.Format(time.RFC3339)},
		Topups:   TopupView{Left: topupLeft(a, now), Frozen: !limits.Topups, UsedThisMonth: a.TopupUsed, Items: []TopupItem{}},
		Features: map[string]bool{"review": limits.Review, "topups": limits.Topups},
		Limits:   PlanLimits{Books: limits.Books, Sessions: limits.Sessions, ImportsPerMonth: limits.ImportsPerMonth, Priority: limits.Priority},
		ByKind:   map[string]int{},
		Recent:   []Entry{},
		Paused:   paused(c, plan),
		Catalog:  PlanCatalog(),
	}
	if p, ok := explicit(a, now); ok && p == plan {
		u.Interval, u.Source, u.ExpiresAt = a.Interval, a.Source, a.PlanUntil
	}
	for _, i := range activeTopups(a, now) {
		t := a.Topups[i]
		u.Topups.Items = append(u.Topups.Items, TopupItem{Points: t.Points, Left: t.Left, ExpiresAt: t.Expires})
	}
	for k, v := range a.ByKind {
		u.ByKind[k] = v
	}
	for i := len(a.Recent) - 1; i >= 0; i-- {
		u.Recent = append(u.Recent, Entry(a.Recent[i]))
	}
	return u
}

// View returns the owner's current allowance.
func (l *Ledger) View(ctx context.Context, owner string) (Usage, error) {
	c, e := ReadControl(l.State)
	if e != nil {
		return Usage{}, e
	}
	var out Usage
	e = l.withAccount(ctx, owner, func(a *account, now time.Time) error {
		out = l.view(*a, now, c)
		return nil
	})
	return out, e
}

// RecordEmail remembers the owner's verified sign-in email so operators can
// find the account by email. It writes only when the email changed.
func (l *Ledger) RecordEmail(ctx context.Context, owner, email string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	if owner == "" || email == "" || len(email) > 320 {
		return nil
	}
	if a, e := l.load(owner); e == nil && a.Email == email {
		return nil
	}
	return l.withAccount(ctx, owner, func(a *account, _ time.Time) error { a.Email = email; return nil })
}

// FindByEmail returns the actor IDs whose last verified email matches.
func FindByEmail(state, email string) ([]string, error) {
	var out []string
	err := (&Ledger{State: state}).transaction(context.Background(), func(_ *transaction) error {
		var err error
		out, err = findByEmail(state, email)
		return err
	})
	return out, err
}

func findByEmail(state, email string) ([]string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	dir := filepath.Join(state, "billing", "accounts")
	entries, e := os.ReadDir(dir)
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	out := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, e := os.ReadFile(filepath.Join(dir, entry.Name()))
		if e != nil {
			return nil, e
		}
		var a account
		if json.Unmarshal(raw, &a) == nil && a.Schema == 1 && a.Email == email && a.Actor != "" {
			out = append(out, a.Actor)
		}
	}
	sort.Strings(out)
	return out, nil
}

// SetPlan records an operator-assigned plan without expiry.
func (l *Ledger) SetPlan(ctx context.Context, owner string, plan Plan) error {
	if _, ok := Plans[plan]; !ok {
		return fmt.Errorf("unknown plan")
	}
	return l.withAccount(ctx, owner, func(a *account, _ time.Time) error {
		a.Plan, a.Interval, a.Source, a.PlanUntil = plan, "", "manual", ""
		return nil
	})
}

// Grant gives a plan for Periods months or years. Granting the plan already
// in force extends it from its current expiry; another plan replaces it from
// now. Plan Free revokes any granted plan (the account returns to its default).
type Grant struct {
	Plan     Plan
	Interval string // month or year
	Periods  int
	Source   string // manual, code or payment
}

func (g Grant) validate() error {
	if g.Plan == Free {
		return nil
	}
	if _, ok := Plans[g.Plan]; !ok {
		return fmt.Errorf("plan must be free, plus or pro")
	}
	if g.Interval != "month" && g.Interval != "year" {
		return fmt.Errorf("interval must be month or year")
	}
	if g.Periods < 1 || (g.Interval == "month" && g.Periods > 36) || (g.Interval == "year" && g.Periods > 3) {
		return fmt.Errorf("periods out of range")
	}
	if g.Source != "manual" && g.Source != "code" && g.Source != "payment" {
		return fmt.Errorf("invalid grant source")
	}
	return nil
}

func applyGrant(a *account, g Grant, now time.Time) {
	if g.Plan == Free {
		a.Plan, a.Interval, a.Source, a.PlanUntil = "", "", "", ""
		return
	}
	start := now
	if p, ok := explicit(*a, now); ok && p == g.Plan && a.PlanUntil != "" {
		start, _ = time.Parse(time.RFC3339Nano, a.PlanUntil)
	}
	until := start.AddDate(0, g.Periods, 0)
	if g.Interval == "year" {
		until = start.AddDate(g.Periods, 0, 0)
	}
	a.Plan, a.Interval, a.Source, a.PlanUntil = g.Plan, g.Interval, g.Source, until.UTC().Format(time.RFC3339)
}

// Grant applies an operator grant and returns the resulting view.
func (l *Ledger) Grant(ctx context.Context, owner string, g Grant) (Usage, error) {
	if owner == "" {
		return Usage{}, fmt.Errorf("owner required")
	}
	if e := g.validate(); e != nil {
		return Usage{}, e
	}
	c, e := ReadControl(l.State)
	if e != nil {
		return Usage{}, e
	}
	var out Usage
	e = l.withAccount(ctx, owner, func(a *account, now time.Time) error {
		applyGrant(a, g, now)
		out = l.view(*a, now, c)
		return nil
	})
	return out, e
}

func addTopup(a *account, id string, points int, source string, now time.Time) error {
	for _, t := range a.Topups {
		if t.ID == id {
			return nil
		}
	}
	if len(a.Topups) >= maxTopups {
		return fmt.Errorf("too many top-ups on this account")
	}
	a.Topups = append(a.Topups, topup{ID: id, Points: points, Left: points, Granted: now.Format(time.RFC3339), Expires: now.AddDate(0, topupLifetime, 0).Format(time.RFC3339), Source: source})
	return nil
}

// AddTopup credits a top-up valid for 12 months; idempotent per id. On a
// Free account it is kept but frozen until the account is on a paid plan.
func (l *Ledger) AddTopup(ctx context.Context, owner, id string, points int, source string) (Usage, error) {
	if owner == "" || id == "" || len(id) > 128 {
		return Usage{}, fmt.Errorf("owner and top-up id required")
	}
	if points < 1 || points > MaxTopupPoints {
		return Usage{}, fmt.Errorf("points out of range")
	}
	c, e := ReadControl(l.State)
	if e != nil {
		return Usage{}, e
	}
	var out Usage
	e = l.withAccount(ctx, owner, func(a *account, now time.Time) error {
		if e := addTopup(a, id, points, source, now); e != nil {
			return e
		}
		out = l.view(*a, now, c)
		return nil
	})
	return out, e
}

// PriorityCache answers "does this owner's plan get priority background
// work?" for the schedulers, which ask every tick. Plans change rarely, so
// answers are cached for TTL (default 30s). Errors mean no priority.
type PriorityCache struct {
	Ledger *Ledger
	TTL    time.Duration
	mu     sync.Mutex
	seen   map[string]cachedPriority
}

type cachedPriority struct {
	priority bool
	at       time.Time
}

func (c *PriorityCache) Priority(ctx context.Context, owner string) bool {
	if c == nil || c.Ledger == nil || owner == "" {
		return false
	}
	ttl := c.TTL
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	now := time.Now()
	c.mu.Lock()
	hit, ok := c.seen[owner]
	c.mu.Unlock()
	if ok && now.Sub(hit.at) < ttl {
		return hit.priority
	}
	plan, e := c.Ledger.Entitlements(ctx, owner)
	priority := e == nil && plan.Priority
	c.mu.Lock()
	if c.seen == nil || len(c.seen) > 10000 {
		c.seen = map[string]cachedPriority{}
	}
	c.seen[owner] = cachedPriority{priority, now}
	c.mu.Unlock()
	return priority
}

// AccountExists reports whether the actor has a billing account (it signed
// in and opened the app at least once).
func AccountExists(state, actor string) bool {
	info, e := os.Stat((&Ledger{State: state}).accountPath(actor))
	return e == nil && info.Mode().IsRegular()
}
