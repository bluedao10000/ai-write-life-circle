package agenttasks

import (
	"context"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func creativeFixture(t *testing.T) (*Service, *creative.Service) {
	t.Helper()
	ctx := context.Background()
	base := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	actor := application.Actor{ID: "author", Role: "author"}
	m := application.NewManagement(base, "author")
	book, e := m.Mutate(ctx, actor, "", "create", application.StructureInput{Operation: "create", Title: "creative protocol"})
	if e != nil {
		t.Fatal(e)
	}
	app, e := m.Resolve(actor, book.ID)
	if e != nil {
		t.Fatal(e)
	}
	cfg := llm.Config{Provider: "openai-compatible", BaseURL: "http://127.0.0.1:9999", Model: "fixture", ResponseFormat: "json_object", TokenParameter: "max_tokens", Timeout: 5e9, MaxContextBytes: 12000, MaxOutputTokens: 2048, MaxResponseBytes: 256 * 1024}
	c := creative.New(app, cfg, nil)
	c.QueueOnly = true
	info := cfg.Info()
	if _, e = c.Configure(ctx, actor, "enable", compat.UUID(), creative.SettingsInput{Consent: true, Model: &info, DailyTokenBudget: 1000000, DailyJobBudget: 20}); e != nil {
		t.Fatal(e)
	}
	session, mid := "session", compat.UUID()
	if _, e = c.AcceptTurn(ctx, session, mid, "auto"); e != nil {
		t.Fatal(e)
	}
	snap := &creative.Snapshot{SessionID: session, BookID: book.ID, Status: "idle", Messages: []creative.SnapshotMessage{
		{ID: mid, Role: "user", Text: "林舟害怕深海。", Status: "completed"},
		{ID: mid + "-answer", Role: "assistant", Text: "这可以作为人物恐惧的来源。", Status: "completed"},
	}}
	r := &creative.Reconciler{Management: m, For: func(a *application.Service) *creative.Service {
		x := creative.New(a, cfg, nil)
		x.QueueOnly = true
		return x
	}, Fetch: func(context.Context, string) (*creative.Snapshot, bool, error) { return snap, true, nil }}
	if e = r.Sweep(ctx); e != nil {
		t.Fatal(e)
	}
	return &Service{Management: m, State: base.State, Config: cfg, Token: strings.Repeat("a", 64)}, c
}

func TestCreativeClaimAndCompletion(t *testing.T) {
	s, c := creativeFixture(t)
	ctx := context.Background()
	task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint())
	if e != nil || task == nil {
		t.Fatal("creative task not claimed", e)
	}
	if task.Kind != "creative.organize" || task.Request.SchemaName != "creative_organize" {
		t.Fatalf("unexpected task: %s %s", task.Kind, task.Request.SchemaName)
	}
	in := envelope(task)
	in.Response = llm.Response{Text: `{"summary":"林舟害怕深海","noChange":true,"noChangeReason":"No creative asset change","changes":[]}`}
	if e = s.Action(ctx, task.ID, "started", in); e != nil {
		t.Fatal(e)
	}
	if e = s.Action(ctx, task.ID, "complete", in); e != nil {
		t.Fatal(e)
	}
	view, e := c.Overview(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if view.Jobs["completed"] != 1 {
		t.Fatalf("creative job not committed: %+v", view.Jobs)
	}
}
