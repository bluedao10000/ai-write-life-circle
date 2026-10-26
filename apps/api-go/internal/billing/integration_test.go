package billing_test

import (
	"context"
	"fmt"
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

func TestFreeReviewStillRequiresValidRevisionAndConsent(t *testing.T) {
	w := setup(t, "u-free")
	r := review.New(w.app(t), cfg, nil)
	defer r.Close()
	_, e := r.Preview(context.Background(), w.actor, w.book.Chapters[0].ID, review.Input{})
	if application.AsError(e).Code != "VALIDATION_FAILED" {
		t.Fatal("Free review still needs a saved revision", e)
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

type freeReviewModel struct {
	output int
	calls  int
}

func (m *freeReviewModel) Generate(_ context.Context, r llm.Request) (llm.Response, error) {
	m.calls++
	m.output = r.OutputLimit
	return llm.Response{Text: `{"findings":[]}`, Usage: &llm.Usage{InputTokens: 1000, OutputTokens: 200}}, nil
}
func TestFreeReviewEndToEndUsesBoundedConsentQuotaAndPreservesHistory(t *testing.T) {
	w := setup(t, "free-writer")
	ctx := context.Background()
	app := w.app(t)
	c, e := app.Source(w.book.Chapters[0].ID)
	if e != nil {
		t.Fatal(e)
	}
	head, e := app.Head(ctx, c)
	if e != nil {
		t.Fatal(e)
	}
	config := cfg
	config.MaxContextBytes = 256 * 1024
	config.MaxOutputTokens = 131072
	model := &freeReviewModel{}
	r := review.New(app, config, model)
	defer r.Close()
	r.DisableLocalExecution = true
	in := review.Input{RevisionID: head.ID, ContentHash: head.Hash, ReviewTypes: []string{"character_consistency"}}
	for i := 0; i < 2; i++ {
		plan, e := r.Preview(ctx, w.actor, c.ID, in)
		if e != nil {
			t.Fatal(e)
		}
		if plan.Cost == nil || plan.Cost.ReservedPoints > 217 || plan.Cost.MaxOutputTokens != 32768 || plan.BudgetBytes != 65536 {
			t.Fatal("incorrect bounded plan", plan.Cost)
		}
		create := review.CreateInput{Input: in}
		create.Consent.Confirmed = true
		create.Consent.PlanHash = plan.PlanHash
		key := fmt.Sprintf("free-run-%d", i)
		run, e := r.Start(ctx, w.actor, c.ID, key, create)
		if e != nil {
			t.Fatal(e)
		}
		replay, e := r.Start(ctx, w.actor, c.ID, key, create)
		if e != nil || replay.RunID != run.RunID {
			t.Fatal("idempotency", e)
		}
		u, _ := w.ledger.View(ctx, w.actor.ID)
		if u.Review.Reserved != 1 || u.Review.Used != i {
			t.Fatal("API admission not reserved", u)
		}
		did, e := r.ProcessAll(ctx)
		if !did || e != nil {
			t.Fatal("free execution failed", did, e)
		}
		saved, e := r.Get(ctx, w.actor, run.RunID)
		if e != nil || saved.Status != "completed" {
			t.Fatal(saved.Status, e)
		}
	}
	if model.calls != 2 || model.output != 32768 {
		t.Fatal("worker did not enforce consented limit", model)
	}
	if _, e = r.Preview(ctx, w.actor, c.ID, in); application.AsError(e).Code != "REVIEW_TRIAL_EXHAUSTED" {
		t.Fatal("third review should fail", e)
	}
	u, _ := w.ledger.View(ctx, w.actor.ID)
	if u.Review.Used != 2 || u.Review.Remaining != 0 || u.Day.Used != 4 {
		t.Fatal(u)
	}
	history, e := r.List(ctx, w.actor, c.ID)
	if e != nil || len(history) != 2 {
		t.Fatal("history inaccessible after quota exhausted", e)
	}
	// Saved prose has not been modified by review.
	after, e := app.Head(ctx, c)
	if e != nil || after.ID != head.ID || after.Markdown != head.Markdown {
		t.Fatal("review modified prose", e)
	}
}
