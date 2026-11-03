package review

import (
	"context"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
)

func TestStartWithoutPreviewConsent(t *testing.T) {
	s, fake := testService(t, nil)
	p := plan(t, s)
	ctx := context.Background()
	in := CreateInput{Input: p.Input}
	run, err := s.Start(ctx, testAuthor, p.ChapterID, "direct-start", in)
	if err != nil {
		t.Fatal(err)
	}
	run = finish(t, s, run)
	if run.Status != "completed" || len(run.Findings) != 1 || run.PlanHash == "" || fake.calls.Load() != 1 {
		t.Fatalf("direct review did not complete: %+v", run)
	}
	replay, err := s.Start(ctx, testAuthor, p.ChapterID, "direct-start", in)
	if err != nil || replay.RunID != run.RunID || fake.calls.Load() != 1 {
		t.Fatal("direct request was not idempotent", err)
	}
}

func TestQueuedReviewSurvivesRuntimeSettings(t *testing.T) {
	s, fake := testService(t, nil)
	s.App.Owner = testAuthor.ID
	s.App.Meter = &billing.Ledger{State: s.App.State}
	p := plan(t, s)
	if p.Cost == nil {
		t.Fatal("expected the free review budget")
	}
	run, err := s.Start(context.Background(), testAuthor, p.ChapterID, "runtime-settings", CreateInput{Input: p.Input})
	if err != nil {
		t.Fatal(err)
	}
	s.Config.MaxOutputTokens *= 2
	s.Config.MaxContextBytes *= 2
	s.Config.Timeout += time.Second
	claim, err := s.claimRun(context.Background(), run.RunID)
	if err != nil || claim == nil {
		t.Fatal("could not claim queued review", err)
	}
	request, err := s.Prepare(context.Background(), claim)
	if err != nil || request.OutputLimit != p.Cost.MaxOutputTokens {
		t.Fatal("queued review lost its reserved limit", request, err)
	}
	s.Config.MaxOutputTokens = 512
	request, err = s.Prepare(context.Background(), claim)
	if err != nil || request.OutputLimit != 512 {
		t.Fatal("queued review did not use the lower runtime limit", request, err)
	}
	if err = s.Process(context.Background(), claim); err != nil {
		t.Fatal(err)
	}
	run = finish(t, s, run)
	if run.Status != "completed" || fake.calls.Load() != 1 {
		t.Fatalf("runtime settings blocked review: %+v", run)
	}
}
