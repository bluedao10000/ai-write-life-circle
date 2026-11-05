package memorytasks

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
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/procedural"
)

type memoryFixture struct {
	app       *application.Service
	tasks     *agenttasks.Service
	knowledge *knowledge.Service
	creative  *creative.Service
	runner    *Coordinator
	config    llm.Config
	state     string
}

func newMemoryFixture(t *testing.T) *memoryFixture {
	t.Helper()
	ctx := context.Background()
	base := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	actor := application.Actor{ID: "author", Role: "author"}
	management := application.NewManagement(base, actor.ID)
	book, err := management.Mutate(ctx, actor, "", "create", application.StructureInput{Operation: "create", Title: "Memory consolidation fixture"})
	if err != nil {
		t.Fatal(err)
	}
	app, err := management.Resolve(actor, book.ID)
	if err != nil {
		t.Fatal(err)
	}
	chapter, err := app.Source(book.Chapters[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	head, err := app.Head(ctx, chapter)
	if err != nil {
		t.Fatal(err)
	}
	key := "initial"
	if _, err = app.Save(ctx, actor, chapter.ID, "fixture", map[string]any{"baseRevisionId": head.ID, "markdown": "林舟在雨夜启程。"}, &key); err != nil {
		t.Fatal(err)
	}
	config := llm.Config{
		Provider: "openai-compatible", BaseURL: "http://127.0.0.1:9999", Model: "fixture",
		ResponseFormat: "json_object", TokenParameter: "max_tokens", Timeout: 5 * time.Second,
		MaxContextBytes: 64 * 1024, MaxOutputTokens: 2048, MaxResponseBytes: 256 * 1024,
	}
	k := knowledge.New(app, config, nil)
	k.QueueOnly = true
	model := config.Info()
	if _, err = k.Mutate(ctx, actor, "enable", "knowledge-consent", knowledge.Mutation{
		Consent: true, Model: &model, DailyTokenBudget: 100000000, DailyJobBudget: 200,
	}); err != nil {
		t.Fatal(err)
	}
	c := creative.New(app, config, nil)
	enabled := true
	if _, err = c.Configure(ctx, actor, "enable", "creative-consent", creative.SettingsInput{
		Consent: true, Model: &model, DailyTokenBudget: 100000000, DailyJobBudget: 200,
		AutoOrganize: &enabled, AutoMemoryConsolidation: &enabled,
	}); err != nil {
		t.Fatal(err)
	}
	tasks := &agenttasks.Service{Management: management, State: base.State, Config: config, Token: strings.Repeat("a", 64)}
	runner := New(tasks, config)
	runner.Validate = func(ctx context.Context, actor application.Actor, book string, origin procedural.Extraction) error {
		return ValidateExtraction(ctx, tasks, actor, book, origin)
	}
	return &memoryFixture{app: app, tasks: tasks, knowledge: k, creative: c, runner: runner, config: config, state: base.State}
}

func (f *memoryFixture) knowledgeTask(t *testing.T, markdown string) *agenttasks.Task {
	return f.knowledgeTaskWithOutput(t, markdown, `{"entities":[],"assertions":[]}`)
}

func (f *memoryFixture) knowledgeTaskWithEntity(t *testing.T, markdown, name, quote string) *agenttasks.Task {
	t.Helper()
	output, _ := json.Marshal(map[string]any{
		"entities": []any{map[string]any{"key": "subject", "type": "character", "name": name, "aliases": []string{}, "identity": "", "existingEntityId": nil}},
		"assertions": []any{map[string]any{
			"entityKey": "subject", "predicate": "observed", "text": quote, "targetKey": nil,
			"epistemic": "observation", "sourceKind": "narration", "speaker": nil, "time": nil, "quote": quote,
		}},
	})
	return f.knowledgeTaskWithOutput(t, markdown, string(output))
}

func (f *memoryFixture) knowledgeTaskWithOutput(t *testing.T, markdown, output string) *agenttasks.Task {
	t.Helper()
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	book, err := f.tasks.Management.Get(actor, f.app.Project)
	if err != nil {
		t.Fatal(err)
	}
	chapter := book.Chapters[0].ID
	head, err := f.app.SavedRevisionAt(ctx, chapter, "")
	if err != nil {
		t.Fatal(err)
	}
	key := "revision-" + compat.UUID()
	if _, err = f.app.Save(ctx, actor, chapter, "fixture", map[string]any{"baseRevisionId": head.ID, "markdown": markdown}, &key); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2100 * time.Millisecond)
	task, err := f.tasks.Claim(ctx, "fixture", f.config.Fingerprint(), "knowledge")
	if err != nil || task == nil {
		t.Fatal(task, err)
	}
	in := agenttasks.Envelope{Lease: task.Lease, Epoch: task.Epoch, Attempt: task.Attempt, Kind: task.Kind, InputHash: task.InputHash, Instance: "fixture"}
	in.Response = llm.Response{Text: output, Usage: &llm.Usage{InputTokens: 10, OutputTokens: 10}, ModelCalls: 1}
	if err = f.tasks.Action(ctx, task.ID, "started", in); err != nil {
		t.Fatal(err)
	}
	if err = f.tasks.Action(ctx, task.ID, "complete", in); err != nil {
		t.Fatal(err)
	}
	if _, err = f.tasks.MemoryOutcome(ctx, actor, task.Book, task.ID); err != nil {
		t.Fatal("knowledge task did not produce a usable result", task.ID, err)
	}
	return task
}

func memoryOutput(taskIDs []string) string {
	raw, _ := json.Marshal(map[string]any{"content": "把长章节拆成可核查的事件，并保留原文回执。", "taskIds": taskIDs, "relations": []any{}})
	return string(raw)
}

func (f *memoryFixture) complete(t *testing.T, taskID string, prepared agenttasks.PreparedMemory, response string) {
	t.Helper()
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	if err := f.runner.Start(ctx, f.app, taskID, &prepared); err != nil {
		t.Fatal(err)
	}
	if err := f.runner.Complete(ctx, f.app, taskID, prepared, llm.Response{
		Text: response, Usage: &llm.Usage{InputTokens: 100, OutputTokens: 40}, ModelCalls: 1,
	}, true, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.runner.Check(ctx, f.app, prepared); err != nil {
		t.Fatal(err)
	}
	_ = actor
}

func memoryRecords(t *testing.T, f *memoryFixture) []procedural.Record {
	t.Helper()
	actor := application.Actor{ID: "author", Role: "author"}
	records, err := (&procedural.Service{App: f.app, Tasks: f.tasks, ValidateExtraction: f.runner.Validate}).Records(context.Background(), actor)
	if err != nil {
		t.Fatal(err)
	}
	return records
}

func TestConsolidationCreatesOnlyAnIdempotentCandidate(t *testing.T) {
	f := newMemoryFixture(t)
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	first := f.knowledgeTask(t, "林舟在雨夜启程，前往北境。")
	if prepared, err := f.runner.Prepare(ctx, f.app, nil); err != nil || prepared != nil {
		t.Fatal("one source started consolidation", prepared, err)
	}
	second := f.knowledgeTask(t, "林舟抵达北境后先寻找旧友。")
	prepared, err := f.runner.Prepare(ctx, f.app, nil)
	if err != nil || prepared == nil {
		snapshot, _ := f.tasks.MemoryEvidence(ctx, actor, f.app.Project)
		t.Fatal(prepared, err, snapshot.Recent())
	}
	if len(prepared.Sources) != 2 || !agenttasks.ValidResultVersion(prepared.Sources[0].ResultVersion) || !agenttasks.ValidResultVersion(prepared.Sources[1].ResultVersion) || prepared.ComparisonOmitted != 0 || !strings.Contains(prepared.Request.System, "only a candidate") {
		t.Fatalf("invalid prepared binding: %+v", prepared)
	}
	if attempted, err := f.runner.Prepare(ctx, f.app, []agenttasks.PreparedMemory{*prepared}); err != nil || attempted != nil {
		t.Fatal("previous attempt was selected again", attempted, err)
	}

	noop := *prepared
	noopDay, err := f.creative.ReserveMemoryAttempt(ctx, "task-noop", noop.ReservedTokens)
	if err != nil {
		t.Fatal(err)
	}
	noop.BudgetDay = noopDay
	if err = f.runner.Complete(ctx, f.app, "task-noop", noop, llm.Response{
		Text: `{"content":null,"taskIds":[],"relations":[]}`, Usage: &llm.Usage{InputTokens: 50, OutputTokens: 10}, ModelCalls: 1,
	}, true, nil); err != nil {
		t.Fatal(err)
	}
	if records := memoryRecords(t, f); len(records) != 0 {
		t.Fatal("no-op created a candidate", records)
	}

	invalid := *prepared
	invalidDay, err := f.creative.ReserveMemoryAttempt(ctx, "task-invalid", invalid.ReservedTokens)
	if err != nil {
		t.Fatal(err)
	}
	invalid.BudgetDay = invalidDay
	if err = f.runner.Complete(ctx, f.app, "task-invalid", invalid, llm.Response{
		Text: `{"content":"candidate","taskIds":[],"relations":[],"extra":true}`, Usage: &llm.Usage{InputTokens: 50, OutputTokens: 10}, ModelCalls: 1,
	}, true, nil); err == nil {
		t.Fatal("unknown output field was accepted")
	}

	valid := *prepared
	validDay, err := f.creative.ReserveMemoryAttempt(ctx, "task-valid", valid.ReservedTokens)
	if err != nil {
		t.Fatal(err)
	}
	valid.BudgetDay = validDay
	taskIDs := []string{first.ID, second.ID}
	response := llm.Response{Text: memoryOutput(taskIDs), Usage: &llm.Usage{InputTokens: 100, OutputTokens: 40}, ModelCalls: 1}
	if err = f.runner.Complete(ctx, f.app, "task-valid", valid, response, true, nil); err != nil {
		t.Fatal(err)
	}
	records := memoryRecords(t, f)
	if len(records) != 1 || records[0].Status != "candidate" || len(records[0].Evidence) != 2 || len(records[0].Extractions) != 1 {
		t.Fatal(records)
	}
	firstID := records[0].ID
	restarted := New(f.tasks, f.config)
	restarted.Validate = f.runner.Validate
	if err = restarted.Complete(ctx, f.app, "task-valid", valid, response, true, nil); err != nil {
		t.Fatal("domain completion was not idempotent after restart", err)
	}
	records = memoryRecords(t, f)
	if len(records) != 1 || records[0].ID != firstID {
		t.Fatal("duplicate completion created another candidate", records)
	}
	views, err := (&procedural.Service{App: f.app, Tasks: f.tasks, ValidateExtraction: f.runner.Validate}).List(ctx, actor)
	if err != nil || len(views) != 1 || views[0].Available || views[0].UnavailableReason != "not_confirmed" {
		t.Fatal(views, err)
	}
	if _, err = (&procedural.Service{App: f.app, Tasks: f.tasks, ValidateExtraction: f.runner.Validate}).Decide(ctx, actor, "confirm", firstID, procedural.Decision{BaseVersion: 1, Action: "confirm"}); err != nil {
		t.Fatal(err)
	}
	if prepared, err := f.runner.Prepare(ctx, f.app, nil); err != nil || prepared != nil {
		t.Fatal("consumed sources were selected again", prepared, err)
	}
}

func TestChangedSourceAndUnavailableComparisonBlockPublication(t *testing.T) {
	f := newMemoryFixture(t)
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	first := f.knowledgeTask(t, "林舟把地图交给同伴。")
	second := f.knowledgeTask(t, "同伴在地图上标记山口。")
	prepared, err := f.runner.Prepare(ctx, f.app, nil)
	if err != nil || prepared == nil {
		snapshot, _ := f.tasks.MemoryEvidence(ctx, actor, f.app.Project)
		t.Fatal(prepared, err, snapshot.Recent())
	}
	startDay, err := f.creative.ReserveMemoryAttempt(ctx, "task-original", prepared.ReservedTokens)
	if err != nil {
		t.Fatal(err)
	}
	original := *prepared
	original.BudgetDay = startDay
	if err = f.runner.Complete(ctx, f.app, "task-original", original, llm.Response{
		Text: memoryOutput([]string{first.ID, second.ID}), Usage: &llm.Usage{InputTokens: 100, OutputTokens: 40}, ModelCalls: 1,
	}, true, nil); err != nil {
		t.Fatal(err)
	}
	record := memoryRecords(t, f)[0]
	if _, err = (&procedural.Service{App: f.app, Tasks: f.tasks, ValidateExtraction: f.runner.Validate}).Decide(ctx, actor, "confirm-original", record.ID, procedural.Decision{BaseVersion: record.Version, Action: "confirm"}); err != nil {
		t.Fatal(err)
	}

	third := f.knowledgeTaskWithEntity(t, "沈岚在山口听见远处的钟声。", "沈岚", "沈岚在山口听见远处的钟声")
	fourth := f.knowledgeTaskWithEntity(t, "顾遥说钟声来自废弃的瞭望塔。", "顾遥", "顾遥说钟声来自废弃的瞭望塔")
	next, err := f.runner.Prepare(ctx, f.app, nil)
	if err != nil || next == nil || len(next.Comparisons) != 1 || next.Comparisons[0].MemoryID != record.ID || next.ComparisonOmitted != 0 {
		t.Fatalf("available comparison was not bound: %+v %v", next, err)
	}

	path := filepath.Join(f.state, "agent-runtime", "tasks-v1.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err = json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	tasks, _ := state["tasks"].(map[string]any)
	task, _ := tasks[first.ID].(map[string]any)
	task["outcome"] = "failed"
	raw, _ = json.Marshal(state)
	if err = os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	after, err := f.runner.Prepare(ctx, f.app, nil)
	if err != nil || after == nil || len(after.Comparisons) != 0 || after.ComparisonOmitted != 0 {
		t.Fatalf("unavailable comparison was exposed: %+v %v", after, err)
	}

	changed := *after
	day, err := f.creative.ReserveMemoryAttempt(ctx, "task-changed", changed.ReservedTokens)
	if err != nil {
		t.Fatal(err)
	}
	changed.BudgetDay = day
	book, _ := f.tasks.Management.Get(actor, f.app.Project)
	chapter := book.Chapters[0].ID
	head, _ := f.app.SavedRevisionAt(ctx, chapter, "")
	key := "change-after-binding"
	if _, err = f.app.Save(ctx, actor, chapter, "fixture", map[string]any{"baseRevisionId": head.ID, "markdown": "来源在校验前发生了改变。"}, &key); err != nil {
		t.Fatal(err)
	}
	if err = f.runner.Complete(ctx, f.app, "task-changed", changed, llm.Response{
		Text: memoryOutput([]string{third.ID, fourth.ID}), Usage: &llm.Usage{InputTokens: 100, OutputTokens: 40}, ModelCalls: 1,
	}, true, nil); err == nil {
		t.Fatal("changed source published a candidate")
	}
	if records := memoryRecords(t, f); len(records) != 1 {
		t.Fatal("failed publication changed the candidate set", records)
	}

	foreign := procedural.Extraction{
		RunID: "task-foreign", Sources: []procedural.ExtractionSource{{TaskID: first.ID, ResultVersion: "sha256:" + strings.Repeat("a", 64)}, {TaskID: "missing", ResultVersion: "sha256:" + strings.Repeat("b", 64)}},
		Provider: f.config.Provider, Model: f.config.Model, PromptVersion: PromptVersion,
	}
	if err = ValidateExtraction(ctx, f.tasks, actor, f.app.Project, foreign); err == nil {
		t.Fatal("foreign source passed extraction validation")
	}
}
