package agenttasks

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

const memoryKnowledgeOutput = `{"entities":[{"key":"lin","type":"character","name":"林舟","aliases":[],"identity":"","existingEntityId":null}],"assertions":[{"entityKey":"lin","predicate":"关系","text":"林舟与父亲争执。","targetKey":null,"epistemic":"observation","sourceKind":"narration","speaker":null,"time":null,"quote":"林舟与父亲争执。"}]}`

func TestMemoryOutcomeReadsRevisionObservationsAndCurrentSourceStatus(t *testing.T) {
	s, k := fixture(t)
	time.Sleep(2100 * time.Millisecond)
	task := completeMemoryTask(t, s, "knowledge", memoryKnowledgeOutput)
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	original, e := os.ReadFile(s.path())
	if e != nil {
		t.Fatal(e)
	}
	result, e := s.MemoryOutcome(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if result.Basis != "revision_observations" || !ValidResultVersion(result.Version) || result.Total != 1 || len(result.Items) != 1 || result.Truncated {
		t.Fatal(result)
	}
	item := result.Items[0]
	if item.Text != "林舟与父亲争执。" || item.Status != "current" || item.Epistemic != "observation" {
		t.Fatal(item)
	}
	source, e := s.MemorySource(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	key := "replace-manuscript"
	if _, e = k.App.Save(ctx, actor, source.Source.ChapterID, "fixture", map[string]any{"baseRevisionId": task.Revision, "markdown": "林舟独自远行。"}, &key); e != nil {
		t.Fatal(e)
	}
	stale, e := s.MemoryOutcome(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if stale.Items[0].Status != "stale" {
		t.Fatal(stale)
	}
	after, e := os.ReadFile(s.path())
	if e != nil || string(after) != string(original) {
		t.Fatal("result read mutated task receipt", e)
	}
	if _, e = s.MemoryOutcome(ctx, application.Actor{ID: "other", Role: "author"}, task.Book, task.ID); e == nil {
		t.Fatal("cross-author result read")
	}
	raw, _ := json.Marshal(result)
	for _, field := range []string{"leaseToken", "reservedTokens", "request", "configFingerprint", "APIKey"} {
		if strings.Contains(string(raw), field) {
			t.Fatal("internal execution field exposed", field)
		}
	}
	if e = s.CleanupBook(ctx, task.Book); e != nil {
		t.Fatal(e)
	}
	if _, e = s.MemoryOutcome(ctx, actor, task.Book, task.ID); e == nil {
		t.Fatal("removed receipt read")
	}
}

func TestMemoryOutcomePreservesAuthorDecisionAndStopsAfterDiscussionDeletion(t *testing.T) {
	s, c := creativeFixture(t)
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	task, e := s.Claim(ctx, "fixture", s.Config.Fingerprint(), "creative")
	if e != nil || task == nil {
		t.Fatal(task, e)
	}
	var input struct {
		Focus []string `json:"focusMessageIds"`
	}
	if e = json.Unmarshal([]byte(task.Request.Input), &input); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(map[string]any{"summary": "人物恐惧", "noChange": false, "changes": []any{map[string]any{"ref": "a", "operation": "CREATE", "stance": "author_decision", "kind": "character", "name": "林舟", "summary": "害怕深海", "evidence": []any{map[string]any{"messageId": input.Focus[0], "quote": "林舟害怕深海"}}}}})
	in := envelope(task)
	in.Response = llm.Response{Text: string(raw), Usage: &llm.Usage{InputTokens: 10, OutputTokens: 10}}
	if e = s.Action(ctx, task.ID, "started", in); e != nil {
		t.Fatal(e)
	}
	if e = s.Action(ctx, task.ID, "complete", in); e != nil {
		t.Fatal(e)
	}
	result, e := s.MemoryOutcome(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if result.Basis != "task_result" || result.Total != 1 || result.Items[0].Status != "proposed" || result.Items[0].Feedback != "" {
		t.Fatal(result)
	}
	if !strings.Contains(result.Items[0].Text, "害怕深海") {
		t.Fatal(result)
	}
	if _, e = c.Decide(ctx, actor, "reject", creative.DecideInput{Decisions: []creative.DecisionInput{{ProposalID: result.Items[0].ID, Action: "reject"}}}); e != nil {
		t.Fatal(e)
	}
	rejected, e := s.MemoryOutcome(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if rejected.Version == result.Version || rejected.Items[0].Status != "rejected" || rejected.Items[0].Feedback != "reject" {
		t.Fatal(rejected)
	}
	if e = c.CancelSession(ctx, "session"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.MemoryOutcome(ctx, actor, task.Book, task.ID); e == nil {
		t.Fatal("deleted discussion result exposed")
	}
}

func TestMemoryOutcomePlanAssessmentTracksDecisionAndPlanVersion(t *testing.T) {
	s, k := fixture(t)
	c := s.creative(k.App)
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	book, e := s.Management.Get(actor, k.App.Project)
	if e != nil {
		t.Fatal(e)
	}
	chapter := book.Chapters[0].ID
	plan, e := c.CreateAsset(ctx, actor, "plan", creative.AssetInput{Kind: "event", Content: creative.Content{Name: "父子和解", Summary: "本章父子和解", Plan: &creative.Plan{ChapterID: chapter}}, Status: "accepted"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = c.RequestPlanCheck(ctx, actor, "check", chapter); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(map[string]any{"checks": []any{map[string]any{"assetId": plan.ID, "assessment": "diverged", "quote": "林舟与父亲争执", "explanation": "父子仍在争执", "question": "是否推迟和解？"}}})
	task := completeMemoryTask(t, s, "creative", string(raw))
	result, e := s.MemoryOutcome(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if result.Total != 1 || result.Items[0].Kind != "plan_assessment" || result.Items[0].Epistemic != "diverged" || result.Items[0].Status != "open" {
		t.Fatal(result)
	}
	if _, e = c.DecideDivergence(ctx, actor, "decision", result.Items[0].ID, creative.DivergenceDecision{Action: "intentional"}); e != nil {
		t.Fatal(e)
	}
	decided, e := s.MemoryOutcome(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if decided.Items[0].Feedback != "intentional" || decided.Items[0].Status != "decided" || decided.Version == result.Version {
		t.Fatal(decided)
	}
	next := plan.Content
	next.Summary = "后续章节和解"
	if _, e = c.UpdateAsset(ctx, actor, "edit-plan", plan.ID, creative.AssetUpdate{BaseVersion: plan.Version, Content: &next}); e != nil {
		t.Fatal(e)
	}
	stale, e := s.MemoryOutcome(ctx, actor, task.Book, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	if stale.Items[0].Status != "stale" || stale.Items[0].Feedback != "intentional" {
		t.Fatal(stale)
	}
}
