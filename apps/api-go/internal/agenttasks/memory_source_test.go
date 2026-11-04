package agenttasks

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func completeMemoryTask(t *testing.T, s *Service, kind, output string) *Task {
	t.Helper()
	ctx := context.Background()
	task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint(), kind)
	if e != nil || task == nil {
		t.Fatal(task, e)
	}
	in := envelope(task)
	in.Response = llm.Response{Text: output, Usage: &llm.Usage{InputTokens: 10, OutputTokens: 10}}
	if e = s.Action(ctx, task.ID, "started", in); e != nil {
		t.Fatal(e)
	}
	if e = s.Action(ctx, task.ID, "complete", in); e != nil {
		t.Fatal(e)
	}
	return task
}

func TestMemorySourceUsesExactHistoricalRevisionWithoutMutatingTask(t *testing.T) {
	s, k := fixture(t)
	time.Sleep(2100 * time.Millisecond)
	task := completeMemoryTask(t, s, "knowledge", `{"entities":[],"assertions":[]}`)
	actor := application.Actor{ID: "author", Role: "author"}
	ctx := context.Background()
	source, e := s.MemorySource(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if source.Source.Type != "chapter" || source.Source.Text != "林舟与父亲争执。" || source.Source.RevisionID != task.Revision || source.Source.ContentHash != task.ContentHash || source.Truncated {
		t.Fatal(source)
	}
	original, e := os.ReadFile(s.path())
	if e != nil {
		t.Fatal(e)
	}
	head, e := k.App.SavedRevisionAt(ctx, source.Source.ChapterID, "")
	if e != nil {
		t.Fatal(e)
	}
	key := "changed"
	if _, e = k.App.Save(ctx, actor, source.Source.ChapterID, "fixture", map[string]any{"baseRevisionId": head.ID, "markdown": "新的正文，不应取代旧来源。"}, &key); e != nil {
		t.Fatal(e)
	}
	restarted := *s
	after, e := restarted.MemorySource(ctx, actor, task.Book, task.ID)
	if e != nil || after.Source.Text != source.Source.Text {
		t.Fatal(after, e)
	}
	raw, _ := json.Marshal(after)
	for _, secret := range []string{"leaseToken", "request", "reservedTokens", "configFingerprint", "consent"} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("internal execution data exposed", secret)
		}
	}
	stored, e := os.ReadFile(s.path())
	if e != nil || string(stored) != string(original) {
		t.Fatal("preview mutated task receipt", e)
	}
	for _, args := range []struct {
		actor    application.Actor
		book, id string
	}{
		{application.Actor{ID: "other", Role: "author"}, task.Book, task.ID},
		{application.Actor{ID: "author", Role: "reader"}, task.Book, task.ID},
		{actor, "other-book", task.ID}, {actor, task.Book, "missing-task"},
	} {
		if _, e := s.MemorySource(ctx, args.actor, args.book, args.id); e == nil {
			t.Fatal("unauthorized source read", args)
		}
	}
	if e := s.transaction(ctx, func(st *Registry) error {
		r := st.Tasks[task.ID]
		r.Outcome = "failed"
		st.Tasks[task.ID] = r
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if _, e := s.MemorySource(ctx, actor, task.Book, task.ID); e == nil {
		t.Fatal("failed task exposed")
	}
}

func TestMemorySourceDiscussionRetainsRolesAndHonorsSourceDeletion(t *testing.T) {
	s, c := creativeFixture(t)
	task := completeMemoryTask(t, s, "creative", `{"summary":"林舟害怕深海","noChange":true,"noChangeReason":"No change","changes":[]}`)
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	source, e := s.MemorySource(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if source.Source.Type != "discussion" || source.Source.SessionID != "session" || len(source.Source.Messages) != 2 || source.Source.Messages[0].Role != "user" || source.Source.Messages[1].Role != "assistant" {
		t.Fatal(source)
	}
	if source.Source.Messages[0].Text != "林舟害怕深海。" {
		t.Fatal(source)
	}
	if e = c.CancelSession(ctx, "session"); e != nil {
		t.Fatal(e)
	}
	restarted := *s
	if _, e = restarted.MemorySource(ctx, actor, task.Book, task.ID); e == nil {
		t.Fatal("deleted excerpt exposed")
	}
}

func TestMemorySourceBoundsLargeRevisionAndRejectsMismatchedIdentity(t *testing.T) {
	s, k := fixture(t)
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	book, e := s.Management.Get(actor, k.App.Project)
	if e != nil {
		t.Fatal(e)
	}
	chapter := book.Chapters[0].ID
	head, e := k.App.SavedRevisionAt(ctx, chapter, "")
	if e != nil {
		t.Fatal(e)
	}
	text := strings.Repeat("林舟核对原文。", 1800)
	key := "long-source"
	if _, e = k.App.Save(ctx, actor, chapter, "fixture", map[string]any{"baseRevisionId": head.ID, "markdown": text}, &key); e != nil {
		t.Fatal(e)
	}
	s.Config.MaxContextBytes = 64 * 1024
	k.Config = s.Config
	view, e := k.Summary(ctx)
	if e != nil {
		t.Fatal(e)
	}
	info := s.Config.Info()
	if _, e = k.Mutate(ctx, actor, "enable", "long-source-consent", knowledge.Mutation{BaseVersion: view.Version, Consent: true, Model: &info, DailyTokenBudget: 400000, DailyJobBudget: 20}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(2100 * time.Millisecond)
	task := completeMemoryTask(t, s, "knowledge", `{"entities":[],"assertions":[]}`)
	source, e := s.MemorySource(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if !source.Truncated || len(source.Source.Text) > MemorySourceBytes || len(source.Source.Text) < MemorySourceBytes-3 || !utf8.ValidString(source.Source.Text) || !strings.HasPrefix(text, source.Source.Text) {
		t.Fatal(source.Truncated, len(source.Source.Text))
	}
	for _, change := range []func(*Task){func(t *Task) { t.ContentHash = "wrong-hash" }, func(t *Task) { t.Revision = "missing-revision" }} {
		if e = s.transaction(ctx, func(st *Registry) error {
			r := st.Tasks[task.ID]
			r.Task = *task
			change(&r.Task)
			st.Tasks[task.ID] = r
			return nil
		}); e != nil {
			t.Fatal(e)
		}
		if _, e = s.MemorySource(ctx, actor, task.Book, task.ID); e == nil {
			t.Fatal("invalid source identity accepted")
		}
	}
}
