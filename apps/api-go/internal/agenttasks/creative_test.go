package agenttasks

import (
	"context"
	"strings"
	"sync"
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

func TestReadonlyModelStepConcurrentAdmissionsShareOneParentBudget(t *testing.T) {
	ctx := context.Background()
	base := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	actor := application.Actor{ID: "author", Role: "author"}
	m := application.NewManagement(base, "author")
	book, e := m.Mutate(ctx, actor, "", "create", application.StructureInput{Operation: "create", Title: "readonly concurrency"})
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
	on := true
	if _, e = c.Configure(ctx, actor, "enable", compat.UUID(), creative.SettingsInput{Consent: true, Model: &info, DailyTokenBudget: 1000000, DailyJobBudget: 20, MultiAgentPlanCheck: &on}); e != nil {
		t.Fatal(e)
	}
	chapter := book.Chapters[0].ID
	if _, e = c.CreateAsset(ctx, actor, compat.UUID(), creative.AssetInput{Kind: "event", Content: creative.Content{Name: "林舟离开", Summary: "林舟在章末离开", Plan: &creative.Plan{ChapterID: chapter}}, Status: "accepted"}); e != nil {
		t.Fatal(e)
	}
	source, _ := app.Source(chapter)
	head, _ := app.Head(ctx, source)
	key := compat.UUID()
	if _, e = app.Save(ctx, actor, chapter, key, map[string]any{"baseRevisionId": head.ID, "markdown": "天亮后林舟留下修复灯塔。"}, &key); e != nil {
		t.Fatal(e)
	}
	if _, e = c.RequestPlanCheck(ctx, actor, compat.UUID(), chapter); e != nil {
		t.Fatal(e)
	}
	s := &Service{Management: m, State: base.State, Config: cfg, Token: strings.Repeat("a", 64)}
	task, e := s.Claim(ctx, "fixture", cfg.Fingerprint())
	if e != nil || task == nil || task.Kind != "creative.plan_check" || task.Strategy != creative.PlanStrategyReadonly {
		t.Fatalf("claim readonly task: %+v %v", task, e)
	}
	child := task.Reserved / creative.PlanCheckModelCalls
	planner := envelope(task)
	planner.ModelStep = &ModelStep{Role: "creative.plan.planner", CallIndex: 1, ParentTaskID: task.ID, MaxTokens: child}
	if e = s.Action(ctx, task.ID, "started", planner); e != nil {
		t.Fatal(e)
	}

	type result struct {
		label string
		err   error
	}
	results := make(chan result, 4)
	var wg sync.WaitGroup
	for callIndex, role := range []string{"creative.plan.researcher", "creative.plan.analyst", "creative.plan.critic"} {
		wg.Add(1)
		go func(callIndex int, role string) {
			defer wg.Done()
			in := envelope(task)
			step := ModelStep{Role: role, CallIndex: callIndex + 2, ParentTaskID: task.ID, MaxTokens: child}
			in.ModelStep = &step
			results <- result{label: role, err: s.Action(ctx, task.ID, "started", in)}
		}(callIndex, role)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		in := envelope(task)
		step := ModelStep{Role: "creative.plan.researcher", CallIndex: 2, ParentTaskID: task.ID, MaxTokens: child + 1}
		in.ModelStep = &step
		results <- result{label: "expanded researcher", err: s.Action(ctx, task.ID, "started", in)}
	}()
	wg.Wait()
	close(results)
	for row := range results {
		if row.label == "expanded researcher" {
			failure := application.AsError(row.err)
			if row.err == nil || failure == nil || failure.Code != "AGENT_CONFIG_CHANGED" {
				t.Fatalf("expanded child budget accepted: %v", row.err)
			}
		} else if row.err != nil {
			t.Fatalf("%s admission: %v", row.label, row.err)
		}
	}
	coordinator := envelope(task)
	coordinator.ModelStep = &ModelStep{Role: "creative.plan.coordinator", CallIndex: 5, ParentTaskID: task.ID, MaxTokens: task.Reserved - child*(creative.PlanCheckModelCalls-1)}
	if e = s.Action(ctx, task.ID, "started", coordinator); e != nil {
		t.Fatal(e)
	}
	restarted := *s
	state, e := restarted.load()
	if e != nil {
		t.Fatal(e)
	}
	record := state.Tasks[task.ID]
	if len(record.ModelSteps) != creative.PlanCheckModelCalls {
		t.Fatalf("concurrent admissions=%d %+v", len(record.ModelSteps), record.ModelSteps)
	}
	seen, sum := map[int]bool{}, 0
	for _, admission := range record.ModelSteps {
		seen[admission.CallIndex] = true
		sum += admission.MaxTokens
	}
	for index := 1; index <= creative.PlanCheckModelCalls; index++ {
		if !seen[index] {
			t.Fatalf("missing admission %d: %+v", index, record.ModelSteps)
		}
	}
	if sum != task.Reserved {
		t.Fatalf("child admission sum=%d parent reservation=%d", sum, task.Reserved)
	}
}
