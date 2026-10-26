package agenttasks

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Service, *knowledge.Service) {
	return fixtureOwnedBy(t, "author", "author")
}

// fixtureOwnedBy creates one book owned by owner in a deployment whose
// configured (legacy) author is legacyOwner.
func fixtureOwnedBy(t *testing.T, legacyOwner, owner string) (*Service, *knowledge.Service) {
	t.Helper()
	ctx := context.Background()
	base := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	actor := application.Actor{ID: owner, Role: "author"}
	m := application.NewManagement(base, legacyOwner)
	book, e := m.Mutate(ctx, actor, "", "create", application.StructureInput{Operation: "create", Title: "合成协议测试"})
	if e != nil {
		t.Fatal(e)
	}
	app, e := m.Resolve(actor, book.ID)
	if e != nil {
		t.Fatal(e)
	}
	c, e := app.Source(book.Chapters[0].ID)
	if e != nil {
		t.Fatal(e)
	}
	head, e := app.Head(ctx, c)
	if e != nil {
		t.Fatal(e)
	}
	key := "save"
	_, e = app.Save(ctx, actor, c.ID, "fixture", map[string]any{"baseRevisionId": head.ID, "markdown": "林舟与父亲争执。"}, &key)
	if e != nil {
		t.Fatal(e)
	}
	cfg := llm.Config{Provider: "openai-compatible", BaseURL: "http://127.0.0.1:9999", Model: "fixture", ResponseFormat: "json_object", TokenParameter: "max_tokens", Timeout: time.Second * 5, MaxContextBytes: 12000, MaxOutputTokens: 2048, MaxResponseBytes: 256 * 1024}
	k := knowledge.New(app, cfg, nil)
	k.QueueOnly = true
	info := cfg.Info()
	_, e = k.Mutate(ctx, actor, "enable", "consent", knowledge.Mutation{Consent: true, Model: &info, DailyTokenBudget: 200000, DailyJobBudget: 20})
	if e != nil {
		t.Fatal(e)
	}
	return &Service{Management: m, State: base.State, Config: cfg, Token: strings.Repeat("a", 64)}, k
}
func switchOwner(t *testing.T, s *Service, owner string) {
	t.Helper()
	c := executorpolicy.Controller{State: s.State}
	if e := c.Drain(context.Background(), "knowledge"); e != nil {
		t.Fatal(e)
	}
	if e := c.Switch(context.Background(), "knowledge", owner); e != nil {
		t.Fatal(e)
	}
}
func envelope(task *Task) Envelope {
	return Envelope{Lease: task.Lease, Epoch: task.Epoch, Attempt: task.Attempt, Kind: task.Kind, InputHash: task.InputHash, Instance: "fixture"}
}
func TestClaimStartedCompletionReceiptsAndRollback(t *testing.T) {
	s, k := fixture(t)
	ctx := context.Background()
	if task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint()); e != nil || task != nil {
		t.Fatal("default Go ownership changed", task, e)
	}
	if _, e := s.Claim(ctx, "fixture", "wrong model"); e == nil {
		t.Fatal("configuration mismatch transmitted snapshot")
	}
	switchOwner(t, s, "pi")
	time.Sleep(2100 * time.Millisecond)
	task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint())
	if e != nil || task == nil {
		t.Fatal(task, e)
	}
	if !strings.Contains(task.Request.Input, "林舟") || task.Reserved < 1 || task.Revision == "" {
		t.Fatal("incomplete bounded snapshot")
	}
	duplicate, e := s.Claim(ctx, "another", s.Config.Fingerprint())
	if e != nil || duplicate != nil {
		t.Fatal("duplicate valid lease", e)
	}
	in := envelope(task)
	in.Response = llm.Response{Text: `{"entities":[],"assertions":[]}`, Usage: &llm.Usage{InputTokens: 10, OutputTokens: 10}}
	if e = s.Action(ctx, task.ID, "complete", in); e == nil {
		t.Fatal("completion before started")
	}
	if e = s.Action(ctx, task.ID, "started", in); e != nil {
		t.Fatal(e)
	}
	if e = s.Action(ctx, task.ID, "started", in); e != nil {
		t.Fatal("started must be idempotent", e)
	}
	bad := in
	bad.Attempt++
	if e = s.Action(ctx, task.ID, "complete", bad); e == nil {
		t.Fatal("forged attempt accepted")
	}
	if e = s.Action(ctx, task.ID, "complete", in); e != nil {
		t.Fatal(e)
	}
	before, e := k.Query(ctx, knowledge.Query{Limit: 20})
	if e != nil {
		t.Fatal(e)
	}
	// Simulate domain commit + lost task-registry acknowledgement, then API restart.
	if e = s.transaction(ctx, func(st *Registry) error {
		r := st.Tasks[task.ID]
		r.Finished = true
		r.ResultHash = "expired"
		r.Task.Deadline = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
		st.Tasks[task.ID] = r
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	restarted := *s
	if e = restarted.Action(ctx, task.ID, "complete", in); e != nil {
		t.Fatal("domain receipt replay", e)
	}
	after, _ := k.Query(ctx, knowledge.Query{Limit: 20})
	if after.BudgetTokens != before.BudgetTokens || after.BudgetAttempts != before.BudgetAttempts {
		t.Fatal("usage settled twice")
	}
	switchOwner(t, s, "go")
	if e = s.Action(ctx, task.ID, "complete", in); e != nil {
		t.Fatal("committed receipt was lost after rollback", e)
	}
}
func TestPrivateTaskCredentialAndNoAnonymousSnapshot(t *testing.T) {
	s, _ := fixture(t)
	for _, token := range []string{"", strings.Repeat("b", 64)} {
		r := httptest.NewRequest("POST", "/internal/v1/agent/tasks/claim", strings.NewReader(`{"instance":"fixture","configFingerprint":"wrong"}`))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 401 || strings.Contains(w.Body.String(), "林舟") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	r := httptest.NewRequest("GET", "/internal/v1/agent/tasks/capabilities", nil)
	r.Header.Set("Authorization", "Bearer "+s.Token)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	var info map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &info)
	if w.Code != 200 || info["protocol"] != Protocol {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestClaimSnapshotRevokedBeforeStartAndDeletedBookScrubbed(t *testing.T) {
	s, k := fixture(t)
	ctx := context.Background()
	switchOwner(t, s, "pi")
	time.Sleep(2100 * time.Millisecond)
	task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint())
	if e != nil || task == nil {
		t.Fatal(e)
	}
	page, e := k.Query(ctx, knowledge.Query{Limit: 20})
	if e != nil {
		t.Fatal(e)
	}
	_, e = k.Mutate(ctx, application.Actor{ID: "author", Role: "author"}, "pause", "pause", knowledge.Mutation{BaseVersion: page.Version})
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Action(ctx, task.ID, "started", envelope(task)); e == nil {
		t.Fatal("paused task started")
	}
	if e = s.CleanupBook(ctx, task.Book); e != nil {
		t.Fatal(e)
	}
	st, e := s.load()
	if e != nil || len(st.Tasks) != 0 {
		t.Fatal("book task snapshot retained", e)
	}
}
func TestInputTamperingCannotCommit(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	switchOwner(t, s, "pi")
	time.Sleep(2100 * time.Millisecond)
	task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint())
	if e != nil || task == nil {
		t.Fatal(e)
	}
	in := envelope(task)
	in.InputHash = "sha256:" + strings.Repeat("0", 64)
	if e = s.Action(ctx, task.ID, "started", in); e == nil {
		t.Fatal("changed snapshot accepted")
	}
	in = envelope(task)
	in.Response = llm.Response{Text: `{"entities":[{"key":"x","type":"character","name":"伪造","aliases":[],"identity":"","existingEntityId":null}],"assertions":[{"entityKey":"x","predicate":"身份","text":"伪造","targetKey":null,"epistemic":"observation","sourceKind":"narration","speaker":null,"time":null,"quote":"正文中不存在"}]}`}
	if e = s.Action(ctx, task.ID, "started", in); e != nil {
		t.Fatal(e)
	}
	if e = s.Action(ctx, task.ID, "complete", in); e != nil {
		t.Fatal(e)
	}
	app, _ := s.Management.Resolve(application.Actor{ID: "author", Role: "author"}, task.Book)
	page, e := s.knowledge(app).Query(ctx, knowledge.Query{Limit: 20})
	if e != nil || len(page.Assertions) != 0 {
		t.Fatal("invalid evidence reached Knowledge", e)
	}
}

func TestKnowledgeLargeCandidatePreservesLegacyAllowance(t *testing.T) {
	s, k := fixture(t)
	ctx := context.Background()
	switchOwner(t, s, "pi")
	time.Sleep(2100 * time.Millisecond)
	task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint())
	if e != nil || task == nil {
		t.Fatal(task, e)
	}
	in := envelope(task)
	if e = s.Action(ctx, task.ID, "started", in); e != nil {
		t.Fatal(e)
	}
	out := knowledge.Output{Entities: []knowledge.CandidateEntity{{Key: "e", Type: "character", Name: "林舟", Aliases: []string{}, Identity: ""}}, Assertions: []knowledge.CandidateAssertion{}}
	for i := 0; i < 110; i++ {
		out.Assertions = append(out.Assertions, knowledge.CandidateAssertion{EntityKey: "e", Predicate: fmt.Sprintf("observation-%d", i), Text: strings.Repeat("x", 900), Epistemic: "observation", Kind: "narration", Quote: "林舟"})
	}
	text, _ := json.Marshal(out)
	if len(text) <= 96*1024 || len(text) > knowledge.CandidateBytes {
		t.Fatal("invalid fixture length", len(text))
	}
	in.Response = llm.Response{Text: string(text)}
	payload, _ := json.Marshal(in)
	r := httptest.NewRequest("POST", "/internal/v1/agent/tasks/"+task.ID+"/complete", strings.NewReader(string(payload)))
	r.Header.Set("Authorization", "Bearer "+s.Token)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	view, e := k.Query(ctx, knowledge.Query{Limit: 100})
	if e != nil || view.AssertionTotal != 110 {
		t.Fatal(view.AssertionTotal, e)
	}
}

// SEC-003: background claiming covers every author's books and runs each task
// as the owner of its book, not as the configured legacy author.
func TestClaimRunsAsTheBookOwner(t *testing.T) {
	s, _ := fixtureOwnedBy(t, "legacy-author", "u-0123456789abcdef0123456789abcdef")
	ctx := context.Background()
	switchOwner(t, s, "pi")
	time.Sleep(2100 * time.Millisecond)
	task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint())
	if e != nil || task == nil {
		t.Fatal("per-user book was not discovered", task, e)
	}
	if task.Author != "u-0123456789abcdef0123456789abcdef" {
		t.Fatalf("task runs as %q", task.Author)
	}
	if e := s.Action(ctx, task.ID, "started", envelope(task)); e != nil {
		t.Fatal(e)
	}
	// A task whose recorded author no longer owns the book is fenced.
	forged := *task
	forged.Author = "legacy-author"
	if _, e := s.resolveTask(forged); e == nil {
		t.Fatal("task resolved for a non-owner")
	}
}

func TestPiReviewStartRechecksPlanAndReleasesUnusedReservation(t *testing.T) {
	s, k := fixture(t)
	ctx := context.Background()
	actor := application.Actor{Role: "author"}
	// Use the actual managed owner from the fixture rather than the configured legacy owner.
	books, e := s.Management.OwnedBooks()
	if e != nil || len(books) != 1 {
		t.Fatal(books, e)
	}
	actor = books[0].Owner
	ledger := &billing.Ledger{State: s.State}
	s.Management.UseMeter(ledger)
	if e := ledger.SetPlan(ctx, actor.ID, billing.Plus); e != nil {
		t.Fatal(e)
	}
	app, e := s.Management.Resolve(actor, k.App.Project)
	if e != nil {
		t.Fatal(e)
	}
	chapters, e := app.Projection()
	if e != nil {
		t.Fatal(e)
	}
	sources, e := application.Sources(chapters)
	if e != nil || len(sources) == 0 {
		t.Fatal(sources, e)
	}
	chapter := sources[0]
	revision, e := app.ReviewRevision(ctx, chapter)
	if e != nil {
		t.Fatal(e)
	}
	r := review.New(app, s.Config, nil)
	defer r.Close()
	r.DisableLocalExecution = true
	plan, e := r.Preview(ctx, actor, chapter.ID, review.Input{RevisionID: revision.ID, ContentHash: revision.Hash, ReviewTypes: []string{"character_consistency"}})
	if e != nil {
		t.Fatal(e)
	}
	in := review.CreateInput{Input: plan.Input}
	in.Consent.Confirmed = true
	in.Consent.PlanHash = plan.PlanHash
	if _, e := r.Start(ctx, actor, chapter.ID, "review", in); e != nil {
		t.Fatal(e)
	}
	controller := executorpolicy.Controller{State: s.State}
	if e := controller.Drain(ctx, "review"); e != nil {
		t.Fatal(e)
	}
	if e := controller.Switch(ctx, "review", "pi"); e != nil {
		t.Fatal(e)
	}
	task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint(), "review")
	if e != nil || task == nil {
		t.Fatal(task, e)
	}
	if e := ledger.SetPlan(ctx, actor.ID, billing.Free); e != nil {
		t.Fatal(e)
	}
	if e := s.Action(ctx, task.ID, "started", envelope(task)); application.AsError(e).Code != "PLAN_FEATURE_REQUIRED" {
		t.Fatal("downgraded task started", e)
	}
	u, e := ledger.View(ctx, actor.ID)
	if e != nil {
		t.Fatal(e)
	}
	if u.Day.Reserved != 0 || u.Day.Used != 0 {
		t.Fatal("unused reservation charged", u.Day)
	}
	st, e := s.load()
	if e != nil {
		t.Fatal(e)
	}
	if !st.Tasks[task.ID].Finished || st.Tasks[task.ID].Started {
		t.Fatal("denied task not terminated")
	}
}
