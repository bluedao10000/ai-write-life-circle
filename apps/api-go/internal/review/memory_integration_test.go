package review

import (
	"context"
	"encoding/json"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"strings"
	"testing"
	"time"
)

type memoryFixture struct{}

func (memoryFixture) Generate(_ context.Context, r llm.Request) (llm.Response, error) {
	var in struct {
		TargetMarkdown string             `json:"targetMarkdown"`
		Existing       []knowledge.Entity `json:"existingEntities"`
	}
	_ = json.Unmarshal([]byte(r.Input), &in)
	existing := ""
	for _, e := range in.Existing {
		if e.Name == "林舟" {
			existing = e.ID
		}
	}
	out := knowledge.Output{Entities: []knowledge.CandidateEntity{{Key: "lin", Type: "character", Name: "林舟", Aliases: []string{}, ExistingID: existing}}, Assertions: []knowledge.CandidateAssertion{{EntityKey: "lin", Predicate: "正文陈述", Text: in.TargetMarkdown, Epistemic: "observation", Kind: "narration", Quote: in.TargetMarkdown}}}
	b, _ := json.Marshal(out)
	return llm.Response{Text: string(b)}, nil
}
func TestKnowledgeBackedReviewUsesOriginalRevisionsAndFallback(t *testing.T) {
	ctx := context.Background()
	actor := application.Actor{ID: "synthetic", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, actor.ID)
	b, e := m.Mutate(ctx, actor, "", "new", application.StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	b, e = m.Mutate(ctx, actor, b.ID, "second", application.StructureInput{Operation: "chapter", BaseVersion: b.Version})
	if e != nil {
		t.Fatal(e)
	}
	app, _ := m.Resolve(actor, b.ID)
	for i, chapter := range b.Chapters {
		c, _ := app.Source(chapter.ID)
		h, _ := app.Head(ctx, c)
		text := "林舟出生于北港。"
		if i == 1 {
			text = "林舟在江宁回忆故乡。"
		}
		key := chapter.ID
		_, e = app.Save(ctx, actor, chapter.ID, key, map[string]any{"baseRevisionId": h.ID, "markdown": text}, &key)
		if e != nil {
			t.Fatal(e)
		}
	}
	cfg := llm.Config{Provider: "openai-compatible", BaseURL: "http://localhost", Model: "fixture", MaxContextBytes: 12000, MaxOutputTokens: 2048, Timeout: time.Second, ResponseFormat: "json_object", TokenParameter: "max_tokens", MaxResponseBytes: 256 * 1024}
	memory := knowledge.New(app, cfg, memoryFixture{})
	model := cfg.Info()
	_, e = memory.Mutate(ctx, actor, "enable", "enable", knowledge.Mutation{Consent: true, Model: &model, DailyTokenBudget: 1000000, DailyJobBudget: 20})
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		if e = memory.ProcessOne(ctx); e != nil {
			t.Fatal(e)
		}
	}
	reviewer := New(app, cfg, memoryFixture{})
	defer reviewer.Close()
	called := false
	reviewer.MemoryChapters = func(ctx context.Context, chapter string) ([]string, error) {
		called = true
		return memory.RelatedChapters(ctx, chapter)
	}
	target, _ := app.Source(b.Chapters[1].ID)
	h, _ := app.ReviewRevision(ctx, target)
	input := Input{RevisionID: h.ID, ContentHash: h.Hash, ReviewTypes: []string{"character_consistency"}}
	plan, e := reviewer.BuildPlan(ctx, target.ID, input)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, src := range plan.Sources {
		if src.Kind == "historical_chapter" {
			found = true
			if src.RevisionID == nil || !strings.Contains(src.Excerpt, "林舟出生于北港") {
				t.Fatal("knowledge summary replaced original evidence")
			}
		}
		if src.Kind == "confirmed_knowledge" {
			t.Fatal("AI observations promoted to confirmed knowledge")
		}
	}
	if !called {
		t.Fatal("knowledge retrieval not called")
	}
	if !found {
		t.Fatal("missing prior revision")
	}
	reviewer.MemoryChapters = func(context.Context, string) ([]string, error) {
		return nil, application.Fail(500, "UNAVAILABLE", "index broken")
	}
	if _, e = reviewer.BuildPlan(ctx, target.ID, input); e != nil {
		t.Fatal("memory failure broke existing review", e)
	}
}
