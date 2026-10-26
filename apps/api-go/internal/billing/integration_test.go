package billing_test

import (
	"context"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
)

type world struct {
	m      *application.Management
	ledger *billing.Ledger
	now    time.Time
	book   application.ManagedBook
	actor  application.Actor
}

func setup(t *testing.T, owner string) *world {
	t.Helper()
	ctx := context.Background()
	base := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	m := application.NewManagement(base, "site-owner")
	w := &world{m: m, now: time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC), actor: application.Actor{ID: owner, Role: "author"}}
	w.ledger = &billing.Ledger{State: base.State, LegacyOwner: "site-owner", Now: func() time.Time { return w.now }}
	m.UseMeter(w.ledger)
	book, e := m.Mutate(ctx, w.actor, "", "create", application.StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	w.book = book
	app := w.app(t)
	c, e := app.Source(book.Chapters[0].ID)
	if e != nil {
		t.Fatal(e)
	}
	head, e := app.Head(ctx, c)
	if e != nil {
		t.Fatal(e)
	}
	key := "save"
	if _, e = app.Save(ctx, w.actor, c.ID, "fixture", map[string]any{"baseRevisionId": head.ID, "markdown": "林舟与父亲争执。"}, &key); e != nil {
		t.Fatal(e)
	}
	return w
}

func (w *world) app(t *testing.T) *application.Service {
	t.Helper()
	app, e := w.m.Resolve(w.actor, w.book.ID)
	if e != nil {
		t.Fatal(e)
	}
	if app.Owner != w.actor.ID || app.Meter == nil {
		t.Fatal("resolved book is not metered for its owner")
	}
	return app
}

var cfg = llm.Config{Provider: "openai-compatible", BaseURL: "http://127.0.0.1:9", Model: "fixture", ResponseFormat: "json_object", TokenParameter: "max_tokens", Timeout: 5 * time.Second, MaxContextBytes: 12000, MaxOutputTokens: 2048, MaxResponseBytes: 256 * 1024}

func TestFreeAccountCannotStartReview(t *testing.T) {
	w := setup(t, "u-free")
	r := review.New(w.app(t), cfg, nil)
	defer r.Close()
	_, e := r.Preview(context.Background(), w.actor, w.book.Chapters[0].ID, review.Input{})
	if application.AsError(e).Code != "PLAN_FEATURE_REQUIRED" || application.AsError(e).Status != 402 {
		t.Fatal("Free review preview must be refused before any plan is built", e)
	}
	_, e = r.Start(context.Background(), w.actor, w.book.Chapters[0].ID, "start-key", review.CreateInput{})
	if e == nil {
		t.Fatal("Free review start accepted")
	}
	// A paid plan unlocks the same request path.
	if e := w.ledger.SetPlan(context.Background(), "u-free", billing.Plus); e != nil {
		t.Fatal(e)
	}
	if _, e = r.Preview(context.Background(), w.actor, w.book.Chapters[0].ID, review.Input{}); application.AsError(e).Code == "PLAN_FEATURE_REQUIRED" {
		t.Fatal("Plus still blocked", e)
	}
}

func TestKnowledgeQueueWaitsForAllowanceAndSettlesUsage(t *testing.T) {
	w := setup(t, "u-writer")
	ctx := context.Background()
	k := knowledge.New(w.app(t), cfg, nil)
	k.QueueOnly = true
	info := cfg.Info()
	if _, e := k.Mutate(ctx, w.actor, "enable", "consent", knowledge.Mutation{Consent: true, Model: &info, DailyTokenBudget: 200000, DailyJobBudget: 20}); e != nil {
		t.Fatal(e)
	}
	// Exhaust today's Free allowance through another feature.
	if e := w.ledger.Reserve(ctx, "u-writer", "earlier", "thinking", 1); e != nil {
		t.Fatal(e)
	}
	_ = w.ledger.Settle(ctx, "u-writer", "earlier", 300)
	k.QuietPeriod = 0
	// The saved chapter's job is due immediately but must wait for allowance.
	for i := 0; i < 5; i++ {
		c, e := k.Claim(ctx)
		if e != nil || c != nil {
			t.Fatal("knowledge claimed without AI points", c, e)
		}
	}
	// Next UTC day: the same, already-due job is claimed at once and its
	// usage is charged on completion.
	w.now = w.now.AddDate(0, 0, 1)
	claim, e := k.Claim(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if claim == nil {
		t.Fatal("knowledge never claimed after allowance reset")
	}
	if u, _ := w.ledger.View(ctx, "u-writer"); u.Day.Reserved == 0 {
		t.Fatal("claim did not reserve AI points", u.Day)
	}
	p, e := k.Prepare(ctx, claim)
	if e != nil {
		t.Fatal(e)
	}
	_ = k.Complete(ctx, p, llm.Response{Text: `{"entities":[],"assertions":[]}`, Usage: &llm.Usage{InputTokens: 6000, OutputTokens: 1000, CachedInputTokens: 5000}}, true, nil)
	u, _ := w.ledger.View(ctx, "u-writer")
	if u.Day.Used != 6 || u.Day.Reserved != 0 {
		t.Fatalf("expected 6 cache-discounted points, got %+v", u.Day)
	}
}
