package creative

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestReadonlyPlanCheckUsesOneParentReservationAndFiveCalls(t *testing.T) {
	f := setup(t)
	f.enable()
	ctx := context.Background()
	on := true
	settings, err := f.s.Configure(ctx, author, "orchestration", compat.UUID(), SettingsInput{MultiAgentPlanCheck: &on})
	if err != nil || !settings.MultiAgentPlanCheck {
		t.Fatalf("enable orchestration: %+v %v", settings, err)
	}

	chapter := f.book.Chapters[0].ID
	plan, err := f.s.CreateAsset(ctx, author, compat.UUID(), AssetInput{Kind: "event", Content: Content{Name: "主角离开", Summary: "主角在章末离开组织", Plan: &Plan{ChapterID: chapter}}, Status: "accepted"})
	if err != nil {
		t.Fatal(err)
	}
	source, _ := f.s.App.Source(chapter)
	head, _ := f.s.App.Head(ctx, source)
	text := "他最终留在了原地。"
	saveKey := compat.UUID()
	if _, err = f.s.App.Save(ctx, author, chapter, saveKey, map[string]any{"baseRevisionId": head.ID, "markdown": text}, &saveKey); err != nil {
		t.Fatal(err)
	}
	job, err := f.s.RequestPlanCheck(ctx, author, compat.UUID(), chapter)
	if err != nil || job.Strategy != PlanStrategyReadonly {
		t.Fatalf("request: %+v %v", job, err)
	}
	claimed, err := f.s.Claim(ctx)
	if err != nil || claimed == nil {
		t.Fatal("claim", err)
	}
	if claimed.Reserved != f.s.reserve()*PlanCheckModelCalls {
		t.Fatalf("one parent reservation=%d", claimed.Reserved)
	}
	prepared, err := f.s.Prepare(ctx, claimed)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(planOutput{Checks: []planCheck{{AssetID: plan.ID, Assessment: "diverged", Quote: "最终留在了原地", Explanation: "计划要求离开，正文选择留下。", Question: "要修改计划还是调整下一章？"}}})
	response := llm.Response{Text: string(raw), Usage: &llm.Usage{InputTokens: 100, OutputTokens: 30}, ModelCalls: PlanCheckModelCalls}
	if err = f.s.Complete(ctx, prepared, response, true, nil); err != nil {
		t.Fatal(err)
	}
	st, err := f.s.load()
	if err != nil {
		t.Fatal(err)
	}
	if got := st.Jobs[len(st.Jobs)-1]; got.ModelCalls != PlanCheckModelCalls || got.Status != "completed" || got.ReservedTokens != claimed.Reserved {
		t.Fatalf("stored job=%+v", got)
	}
	divergences, err := f.s.Divergences(ctx, chapter)
	if err != nil || len(divergences) != 1 || divergences[0].Assessment != "diverged" {
		t.Fatalf("divergences=%+v error=%v", divergences, err)
	}
}

func TestReadonlyPlanCheckInterruptionNeverRetriesImplicitly(t *testing.T) {
	state := State{Jobs: []Job{{ID: "job", Kind: "plan_check", Strategy: PlanStrategyReadonly, Status: "running", Attempts: 1, Deadline: time.Now().Add(-time.Second).Format(time.RFC3339Nano)}}}
	if !recoverLeases(&state, time.Now()) {
		t.Fatal("expired lease was not recovered")
	}
	if state.Jobs[0].Status != "failed" || state.Jobs[0].Failure != "CREATIVE_INTERRUPTED" {
		t.Fatalf("job=%+v", state.Jobs[0])
	}
}

func TestReadonlyPlanProviderFailureDoesNotScheduleAnotherAttempt(t *testing.T) {
	f := setup(t)
	f.enable()
	ctx := context.Background()
	on := true
	if _, err := f.s.Configure(ctx, author, "orchestration", compat.UUID(), SettingsInput{MultiAgentPlanCheck: &on}); err != nil {
		t.Fatal(err)
	}
	chapter := f.book.Chapters[0].ID
	if _, err := f.s.CreateAsset(ctx, author, compat.UUID(), AssetInput{Kind: "event", Content: Content{Name: "计划", Plan: &Plan{ChapterID: chapter}}, Status: "accepted"}); err != nil {
		t.Fatal(err)
	}
	source, _ := f.s.App.Source(chapter)
	head, _ := f.s.App.Head(ctx, source)
	saveKey := compat.UUID()
	if _, err := f.s.App.Save(ctx, author, chapter, saveKey, map[string]any{"baseRevisionId": head.ID, "markdown": "正文"}, &saveKey); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.RequestPlanCheck(ctx, author, compat.UUID(), chapter); err != nil {
		t.Fatal(err)
	}
	claimed, err := f.s.Claim(ctx)
	if err != nil || claimed == nil {
		t.Fatal("claim", err)
	}
	prepared, err := f.s.Prepare(ctx, claimed)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.s.Complete(ctx, prepared, llm.Response{ModelCalls: 2}, true, llm.Fail("LLM_TIMEOUT")); err != nil {
		t.Fatal(err)
	}
	st, err := f.s.load()
	if err != nil {
		t.Fatal(err)
	}
	job := st.Jobs[len(st.Jobs)-1]
	if job.Status != "failed" || job.Attempts != 1 || job.ModelCalls != 2 || job.UsageIncomplete != true {
		t.Fatalf("failed job=%+v", job)
	}
	if next, err := f.s.Claim(ctx); err != nil || next != nil {
		t.Fatalf("readonly failure was implicitly retried: %+v %v", next, err)
	}
}
