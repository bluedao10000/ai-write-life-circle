package procedural

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agenttasks"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

func fixture(t *testing.T) (*Service, application.Actor) {
	t.Helper()
	ctx := context.Background()
	actor := application.Actor{ID: "owner", Role: "author"}
	base := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	m := application.NewManagement(base, actor.ID)
	b, e := m.Mutate(ctx, actor, "", "create", application.StructureInput{Operation: "create", Title: "procedural fixture"})
	if e != nil {
		t.Fatal(e)
	}
	app, e := m.Resolve(actor, b.ID)
	if e != nil {
		t.Fatal(e)
	}
	tasks := &agenttasks.Service{Management: m, State: base.State}
	registry := agenttasks.Registry{Schema: 1, Tasks: map[string]agenttasks.Record{}}
	for i, id := range []string{"task-a", "task-b", "same-input", "failed", "foreign"} {
		input := []string{"input-a", "input-b", "input-a", "input-c", "input-d"}[i]
		r := agenttasks.Record{Task: agenttasks.Task{ID: id, Author: actor.ID, Book: b.ID, Kind: "knowledge.extract", Strategy: "knowledge-extraction-v1", InputHash: input}, Knowledge: &knowledge.PreparedJob{}, Finished: true, Outcome: "completed", CompletedAt: "2026-11-01T00:00:00Z"}
		if id == "failed" {
			r.Outcome = "failed"
		}
		if id == "foreign" {
			r.Task.Author = "other"
		}
		registry.Tasks[id] = r
	}
	if e = storage.Write(ctx, filepath.Join(base.State, "agent-runtime/tasks-v1.json"), registry); e != nil {
		t.Fatal(e)
	}
	now := time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC)
	return &Service{App: app, Tasks: tasks, Clock: func() time.Time { return now }}, actor
}
func TestProceduralLifecycleRequiresIndependentEvidenceAndAuthorReview(t *testing.T) {
	s, a := fixture(t)
	ctx := context.Background()
	empty, e := s.List(ctx, a)
	if e != nil || len(empty) != 0 {
		t.Fatal(empty, e)
	}
	if _, e = os.Stat(s.path()); !os.IsNotExist(e) {
		t.Fatal("reading an old directory created new state", e)
	}
	one, e := s.Create(ctx, a, "one", Input{Content: "single success", TaskIDs: []string{"task-a"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Decide(ctx, a, "confirm-one", one.ID, Decision{1, "confirm"}); e == nil {
		t.Fatal("single successful execution confirmed")
	}
	same, e := s.Create(ctx, a, "same", Input{Content: "same input", TaskIDs: []string{"task-a", "same-input"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Decide(ctx, a, "confirm-same", same.ID, Decision{1, "confirm"}); e == nil {
		t.Fatal("repeated input counted as independent evidence")
	}
	for _, ids := range [][]string{{"failed"}, {"foreign"}, {"task-a", "task-a"}} {
		if _, e = s.Create(ctx, a, compat.UUID(), Input{Content: "invalid source", TaskIDs: ids}); e == nil {
			t.Fatal(ids)
		}
	}
	in := Input{Content: "UNIQUE_OPERATING_RULE: read evidence before comparing character claims", TaskIDs: []string{"task-a", "task-b"}}
	candidate, e := s.Create(ctx, a, "create", in)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := s.Create(ctx, a, "create", in)
	if e != nil || replay.ID != candidate.ID {
		t.Fatal(replay, e)
	}
	if _, e = s.Create(ctx, a, "create", Input{Content: "different", TaskIDs: in.TaskIDs}); e == nil {
		t.Fatal("idempotency key changed input")
	}
	confirmed, e := s.Decide(ctx, a, "confirm", candidate.ID, Decision{1, "confirm"})
	if e != nil || confirmed.Status != "confirmed" {
		t.Fatal(confirmed, e)
	}
	if _, e = s.Decide(ctx, a, "stale-reject", candidate.ID, Decision{1, "reject"}); e == nil {
		t.Fatal("stale version mutated memory")
	}
	restarted := &Service{App: s.App, Tasks: s.Tasks, Clock: s.Clock}
	views, e := restarted.List(ctx, a)
	if e != nil {
		t.Fatal(e)
	}
	available := 0
	for _, v := range views {
		if v.Available {
			available++
		}
	}
	if available != 1 {
		t.Fatal(views)
	}
	if _, e = restarted.List(ctx, application.Actor{ID: "other", Role: "author"}); e == nil {
		t.Fatal("cross-author read accepted")
	}
	later := s.now().Add(31 * 24 * time.Hour)
	restarted.Clock = func() time.Time { return later }
	if _, e = restarted.Decide(ctx, a, "expired-confirm", one.ID, Decision{1, "confirm"}); e == nil || application.AsError(e).Code != "MEMORY_EXPIRED" {
		t.Fatal("expired candidate confirmed", e)
	}
	views, e = restarted.List(ctx, a)
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range views {
		if v.Available || v.UnavailableReason != "expired" {
			t.Fatal(v)
		}
	}
	deleted, e := s.Decide(ctx, a, "delete", confirmed.ID, Decision{confirmed.Version, "delete"})
	if e != nil || deleted.Content != "" || len(deleted.Evidence) != 0 {
		t.Fatal(deleted, e)
	}
	if _, e = s.Create(ctx, a, "create", in); e == nil || application.AsError(e).Status != 410 {
		t.Fatal("deleted content replayed", e)
	}
	if _, e = s.Decide(ctx, a, "confirm", candidate.ID, Decision{1, "confirm"}); e == nil || application.AsError(e).Status != 410 {
		t.Fatal("confirmation replay resurrected memory", e)
	}
	if repeated, e := s.Decide(ctx, a, "delete", confirmed.ID, Decision{confirmed.Version, "delete"}); e != nil || repeated.Status != "deleted" {
		t.Fatal(repeated, e)
	}
	raw, e := os.ReadFile(s.path())
	if e != nil || strings.Contains(string(raw), "UNIQUE_OPERATING_RULE") {
		t.Fatal("deleted content retained in receipts", e)
	}
}
func TestProceduralSourceRemovalInvalidatesRetrievalAndFutureConfirmation(t *testing.T) {
	s, a := fixture(t)
	ctx := context.Background()
	r, e := s.Create(ctx, a, "create", Input{Content: "reviewed rule", TaskIDs: []string{"task-a", "task-b"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Decide(ctx, a, "confirm", r.ID, Decision{1, "confirm"}); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(s.Tasks.State, "agent-runtime/tasks-v1.json")
	raw, _ := os.ReadFile(path)
	var registry agenttasks.Registry
	if e = json.Unmarshal(raw, &registry); e != nil {
		t.Fatal(e)
	}
	delete(registry.Tasks, "task-a")
	if e = storage.Write(ctx, path, registry); e != nil {
		t.Fatal(e)
	}
	views, e := s.List(ctx, a)
	if e != nil || len(views) != 1 || views[0].Available || views[0].UnavailableReason != "source_unavailable" {
		t.Fatal(views, e)
	}
}

func TestBookDeletionPurgesProceduralStateAndFencesOldService(t *testing.T) {
	s, a := fixture(t)
	ctx := context.Background()
	if _, e := s.Create(ctx, a, "create", Input{Content: "private operating rule", TaskIDs: []string{"task-a", "task-b"}}); e != nil {
		t.Fatal(e)
	}
	book, e := s.Tasks.Management.Get(a, s.App.Project)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Tasks.Management.Delete(ctx, a, book.ID, "delete-book", application.DeleteBookInput{BaseVersion: book.Version}); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(s.path()); !os.IsNotExist(e) {
		t.Fatal("procedural state survived book deletion", e)
	}
	if _, e = s.Create(ctx, a, "late-create", Input{Content: "late write", TaskIDs: []string{"task-a"}}); e == nil {
		t.Fatal("late service resurrected deleted book")
	}
}

func TestRejectingConfirmedExperienceRemovesItFromAvailableMemory(t *testing.T) {
	s, a := fixture(t)
	ctx := context.Background()
	r, e := s.Create(ctx, a, "create", Input{Content: "bounded experience", TaskIDs: []string{"task-a", "task-b"}})
	if e != nil {
		t.Fatal(e)
	}
	confirmed, e := s.Decide(ctx, a, "confirm", r.ID, Decision{1, "confirm"})
	if e != nil {
		t.Fatal(e)
	}
	rejected, e := s.Decide(ctx, a, "reject", r.ID, Decision{confirmed.Version, "reject"})
	if e != nil || rejected.Status != "rejected" {
		t.Fatal(rejected, e)
	}
	if _, e = s.Decide(ctx, a, "confirm", r.ID, Decision{1, "confirm"}); e != nil {
		t.Fatal(e)
	}
	views, e := s.List(ctx, a)
	if e != nil || len(views) != 1 || views[0].Available || views[0].Status != "rejected" {
		t.Fatal("receipt replay changed current review state", views, e)
	}
}

func TestConcurrentReviewsUseOneVersionAndStorageBudgetRejectsBeforeCommit(t *testing.T) {
	s, a := fixture(t)
	ctx := context.Background()
	r, e := s.Create(ctx, a, "create", Input{Content: "bounded rule", TaskIDs: []string{"task-a", "task-b"}})
	if e != nil {
		t.Fatal(e)
	}
	results := make(chan error, 2)
	for _, key := range []string{"review-a", "review-b"} {
		go func(key string) { _, e := s.Decide(ctx, a, key, r.ID, Decision{1, "confirm"}); results <- e }(key)
	}
	successes, conflicts := 0, 0
	for i := 0; i < 2; i++ {
		e := <-results
		if e == nil {
			successes++
		} else if application.AsError(e).Code == "MEMORY_VERSION_CONFLICT" {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal(successes, conflicts)
	}
	st, e := s.load(a)
	if e != nil {
		t.Fatal(e)
	}
	// Existing request history fills the configured byte budget.
	st.Requests["full"] = receipt{ID: r.ID, Operation: "create", Input: strings.Repeat("x", 8*1024*1024), Result: r}
	if e = storage.Write(ctx, s.path(), st); e != nil {
		t.Fatal(e)
	}
	_, e = s.Create(ctx, a, "over-budget", Input{Content: "NEVER_COMMITTED", TaskIDs: []string{"task-a"}})
	if e == nil || application.AsError(e).Code != "MEMORY_STORAGE_LIMIT" {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(s.path())
	if e != nil || strings.Contains(string(raw), "NEVER_COMMITTED") {
		t.Fatal("failed write published", e)
	}
}
