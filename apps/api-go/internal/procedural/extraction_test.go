package procedural

import (
	"context"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

func TestExtractedCandidatesKeepAuthorizationThroughMergeAndReview(t *testing.T) {
	s, actor := fixture(t)
	ctx := context.Background()
	revoked := false
	checks := 0
	s.ValidateExtraction = func(_ context.Context, _ application.Actor, book string, origin Extraction) error {
		checks++
		if book != s.App.Project || origin.RunID != "run-a" {
			t.Fatal("incorrect extraction identity")
		}
		if revoked {
			return application.Fail(403, "CAPABILITY_REVOKED", "Revoked.")
		}
		return nil
	}
	first, e := s.CreateExtracted(ctx, actor, "extracted", Input{Content: "核对来源。", TaskIDs: []string{"task-a"}}, Extraction{SessionID: "session", RunID: "run-a", PromptVersion: "memory-extraction-v1"})
	if e != nil {
		t.Fatal(e)
	}
	manual, e := s.Create(ctx, actor, "manual", Input{Content: first.Content, TaskIDs: []string{"task-b"}})
	if e != nil {
		t.Fatal(e)
	}
	merged, e := s.Merge(ctx, actor, "merge", manual.ID, MergeInput{BaseVersion: 1, Sources: []MergeSource{{first.ID, 1}}})
	if e != nil {
		t.Fatal(e)
	}
	if len(merged.Extractions) != 1 || merged.Extractions[0].RunID != "run-a" {
		t.Fatal("merge discarded extraction authority")
	}
	revoked = true
	if _, e = s.Decide(ctx, actor, "denied-confirm", merged.ID, Decision{2, "confirm"}); application.AsError(e).Status != 403 {
		t.Fatal(e)
	}
	revoked = false
	confirmed, e := s.Decide(ctx, actor, "confirm", merged.ID, Decision{2, "confirm"})
	if e != nil {
		t.Fatal(e)
	}
	revoked = true
	views, e := s.List(ctx, actor)
	if e != nil {
		t.Fatal(e)
	}
	for _, view := range views {
		if view.ID == confirmed.ID && (view.Available || view.UnavailableReason != "source_unavailable") {
			t.Fatal(view)
		}
	}
	deleted, e := s.Decide(ctx, actor, "delete", merged.ID, Decision{confirmed.Version, "delete"})
	if e != nil || len(deleted.Extractions) != 0 {
		t.Fatal(deleted, e)
	}
	if checks < 4 {
		t.Fatal("missing current authorization checks")
	}
}
