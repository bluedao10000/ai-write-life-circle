// Package billing meters model usage per author in AI points (pricing plan
// Phase 0, harness/design/pricing-plans.md).
//
// 1 point = 1,000 billable tokens, where billable = input + 4 × output (the
// DeepSeek flash peak price ratio). Every model call follows reserve → settle:
//   - Reserve before the call. An operation is admitted while the account's
//     settled usage plus open reservations is below its monthly and daily
//     limits (and, for Free, the site-wide Free pool), so an account can
//     overrun by at most one operation.
//   - Settle with the actual usage afterwards (or release with 0 when no model
//     call happened). Settling is idempotent per operation ID.
//   - A reservation that is never settled is charged in full once its lease
//     expires: unknown usage is never refunded.
//
// State lives under <state>/billing as atomic JSON guarded by the shared
// O_EXCL lock protocol, so the API and Worker processes can both meter.
package billing

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
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

// Limits are the AI-point allowances of a plan.
type Limits struct {
	Monthly int  `json:"monthly"`
	Daily   int  `json:"daily"`
	Review  bool `json:"review"`
}

// Plans mirrors the confirmed pricing table.
var Plans = map[Plan]Limits{
	Free: {Monthly: 1500, Daily: 300, Review: false},
	Plus: {Monthly: 6000, Daily: 1500, Review: true},
	Pro:  {Monthly: 18000, Daily: 4000, Review: true},
}

const (
	// DefaultFreeDailyPoints caps all Free accounts together per UTC day
	// (about $60 at worst-case peak pricing).
	DefaultFreeDailyPoints = 200000
	defaultTTL             = 15 * time.Minute
	maxDone                = 2000
)

// PointsFor converts token usage into AI points, rounding up.
func PointsFor(input, output int) int {
	billable := max(input, 0) + 4*max(output, 0)
	if billable <= 0 {
		return 0
	}
	return (billable + 999) / 1000
}

// Ledger implements application.Meter.
type Ledger struct {
	State string
	// LegacyOwner is the configured author (the site owner). It is on Pro
	// unless its account records another plan.
	LegacyOwner string
	TTL         time.Duration
	Now         func() time.Time
}

var _ application.Meter = (*Ledger)(nil)

type hold struct {
	Kind    string `json:"kind"`
	Points  int    `json:"points"`
	Month   string `json:"month"`
	Day     string `json:"day"`
	Expires string `json:"expiresAt"`
	Free    bool   `json:"free,omitempty"`
}

type account struct {
	Schema    int               `json:"schema"`
	Actor     string            `json:"actorId"`
	Plan      Plan              `json:"plan,omitempty"`
	Month     string            `json:"month"`
	MonthUsed int               `json:"monthUsed"`
	Day       string            `json:"day"`
	DayUsed   int               `json:"dayUsed"`
	Open      map[string]hold   `json:"open"`
	Done      map[string]string `json:"done"`
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
	return storage.Lock(ctx, ControlPath(state)+".lock", func() error { return storage.Write(ctx, ControlPath(state), c) })
}

func (l *Ledger) planOf(a account) Plan {
	if _, ok := Plans[a.Plan]; ok && a.Plan != "" {
		return a.Plan
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
	path := l.accountPath(actor)
	return storage.Lock(ctx, path+".lock", func() error {
		a, e := l.load(actor)
		if e != nil {
			return e
		}
		now := l.now()
		month, day := now.Format("2006-01"), now.Format("2006-01-02")
		if a.Month != month {
			a.Month, a.MonthUsed = month, 0
		}
		if a.Day != day {
			a.Day, a.DayUsed = day, 0
		}
		// Expired reservations are charged in full: the model may have run.
		for op, h := range a.Open {
			expires, err := time.Parse(time.RFC3339Nano, h.Expires)
			if err == nil && now.Before(expires) {
				continue
			}
			if e := l.finish(ctx, &a, op, h, h.Points); e != nil {
				return e
			}
		}
		if e := fn(&a, now); e != nil {
			return e
		}
		l.prune(&a, now)
		return storage.Write(ctx, path, a)
	})
}

func (l *Ledger) finish(ctx context.Context, a *account, op string, h hold, charge int) error {
	charge = max(charge, 0)
	if h.Month == a.Month {
		a.MonthUsed += charge
	}
	if h.Day == a.Day {
		a.DayUsed += charge
	}
	if h.Free {
		if e := l.withPool(ctx, h.Day, func(p *pool) { delete(p.Open, op); p.Used += charge }); e != nil {
			return e
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

func (l *Ledger) withPool(ctx context.Context, day string, fn func(*pool)) error {
	path := l.poolPath(day)
	return storage.Lock(ctx, path+".lock", func() error {
		p := pool{Schema: 1, Day: day, Open: map[string]int{}}
		found, e := storage.Read(path, &p)
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
		return storage.Write(ctx, path, p)
	})
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
	}
	return application.Fail(402, "PLAN_QUOTA_EXCEEDED", "本月的 AI 点数已用完，下月 1 日（UTC）恢复。写作和保存不受影响。")
}

func (l *Ledger) admit(ctx context.Context, a account, plan Plan, c Control) error {
	if paused(c, plan) {
		return pausedError()
	}
	limits := Plans[plan]
	month, day := outstanding(a)
	if a.MonthUsed+month >= limits.Monthly {
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
	c, e := ReadControl(l.State)
	if e != nil {
		return e
	}
	var out error
	e = l.withAccount(ctx, owner, func(a *account, _ time.Time) error {
		plan := l.planOf(*a)
		if feature == "review" && !Plans[plan].Review {
			out = application.Fail(402, "PLAN_FEATURE_REQUIRED", "连续性审查需要 Plus 或 Pro 方案。写作和其他功能不受影响。")
			return nil
		}
		out = l.admit(ctx, *a, plan, c)
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
	c, e := ReadControl(l.State)
	if e != nil {
		return e
	}
	var out error
	e = l.withAccount(ctx, owner, func(a *account, now time.Time) error {
		if _, ok := a.Open[op]; ok {
			return nil
		}
		if _, ok := a.Done[op]; ok {
			return nil
		}
		plan := l.planOf(*a)
		if out = l.admit(ctx, *a, plan, c); out != nil {
			return nil
		}
		h := hold{Kind: kind, Points: max(points, 1), Month: a.Month, Day: a.Day, Expires: now.Add(l.ttl()).Format(time.RFC3339Nano), Free: plan == Free}
		if h.Free {
			cap := c.FreeDailyPoints
			if cap <= 0 {
				cap = DefaultFreeDailyPoints
			}
			if e := l.withPool(ctx, a.Day, func(p *pool) {
				open := 0
				for _, v := range p.Open {
					open += v
				}
				if p.Used+open >= cap {
					out = quotaError("pool")
					return
				}
				p.Open[op] = h.Points
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

// Settle records the actual points of a reserved operation; points < 0
// charges the full reservation (usage unknown). Unknown or already settled
// operations are ignored.
func (l *Ledger) Settle(ctx context.Context, owner, op string, points int) error {
	if owner == "" || op == "" {
		return nil
	}
	return l.withAccount(ctx, owner, func(a *account, _ time.Time) error {
		h, ok := a.Open[op]
		if !ok {
			return nil
		}
		if points < 0 {
			points = h.Points
		}
		return l.finish(ctx, a, op, h, points)
	})
}

// Usage is the author-facing view of an account.
type Usage struct {
	Plan     Plan            `json:"plan"`
	Month    Window          `json:"month"`
	Day      Window          `json:"day"`
	Features map[string]bool `json:"features"`
	Paused   bool            `json:"paused"`
}
type Window struct {
	Limit    int    `json:"limit"`
	Used     int    `json:"used"`
	Reserved int    `json:"reserved"`
	ResetsAt string `json:"resetsAt"`
}

// View returns the owner's current allowance.
func (l *Ledger) View(ctx context.Context, owner string) (Usage, error) {
	c, e := ReadControl(l.State)
	if e != nil {
		return Usage{}, e
	}
	var out Usage
	e = l.withAccount(ctx, owner, func(a *account, now time.Time) error {
		plan := l.planOf(*a)
		limits := Plans[plan]
		month, day := outstanding(*a)
		first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		tomorrow := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
		out = Usage{
			Plan:     plan,
			Month:    Window{Limit: limits.Monthly, Used: a.MonthUsed, Reserved: month, ResetsAt: first.AddDate(0, 1, 0).Format(time.RFC3339)},
			Day:      Window{Limit: limits.Daily, Used: a.DayUsed, Reserved: day, ResetsAt: tomorrow.Format(time.RFC3339)},
			Features: map[string]bool{"review": limits.Review},
			Paused:   paused(c, plan),
		}
		return nil
	})
	return out, e
}

// SetPlan records an operator-assigned plan (Phase 1 adds grants and payments).
func (l *Ledger) SetPlan(ctx context.Context, owner string, plan Plan) error {
	if _, ok := Plans[plan]; !ok {
		return fmt.Errorf("unknown plan")
	}
	return l.withAccount(ctx, owner, func(a *account, _ time.Time) error { a.Plan = plan; return nil })
}
