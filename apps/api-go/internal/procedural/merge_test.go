package procedural

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agenttasks"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"os"
	"sync"
	"testing"
	"time"
)

func TestMergeCandidatesPreservesEvidenceExpiryAndReview(t *testing.T) {
	s, a := fixture(t)
	ctx := context.Background()
	first, e := s.Create(ctx, a, "first", Input{Content: "核对来源。", TaskIDs: []string{"task-a"}})
	if e != nil {
		t.Fatal(e)
	}
	expiry := s.now().Add(time.Hour).Format(time.RFC3339Nano)
	second, e := s.Create(ctx, a, "second", Input{Content: first.Content, TaskIDs: []string{"task-b"}, ExpiresAt: expiry})
	if e != nil {
		t.Fatal(e)
	}
	in := MergeInput{first.Version, []MergeSource{{second.ID, second.Version}}}
	merged, e := s.Merge(ctx, a, "merge", first.ID, in)
	if e != nil {
		t.Fatal(e)
	}
	if merged.Status != "candidate" || merged.Version != 2 || len(merged.Evidence) != 2 || merged.ExpiresAt != expiry {
		t.Fatalf("%+v", merged)
	}
	views, e := s.List(ctx, a)
	if e != nil {
		t.Fatal(e)
	}
	for _, view := range views {
		if view.Available {
			t.Fatal("merge approved a rule")
		}
		if view.ID == second.ID && (view.Status != "rejected" || view.Version != 2) {
			t.Fatal(view)
		}
	}
	restarted := &Service{App: s.App, Tasks: s.Tasks, Clock: s.Clock}
	replay, e := restarted.Merge(ctx, a, "merge", first.ID, in)
	if e != nil || replay.Version != 2 {
		t.Fatal(replay, e)
	}
	if _, e = s.Decide(ctx, a, "confirm", merged.ID, Decision{merged.Version, "confirm"}); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Decide(ctx, a, "delete", merged.ID, Decision{3, "delete"}); e != nil {
		t.Fatal(e)
	}
	if _, e = restarted.Merge(ctx, a, "merge", first.ID, in); e == nil {
		t.Fatal("deleted target revived by merge replay")
	}
}

func TestMergeRejectsInvalidSourcesWithoutPartialWrites(t *testing.T) {
	for _, scenario := range []string{"version", "different-content", "confirmed", "expired", "duplicate", "foreign"} {
		t.Run(scenario, func(t *testing.T) {
			s, a := fixture(t)
			ctx := context.Background()
			first, e := s.Create(ctx, a, "first", Input{Content: "相同经验", TaskIDs: []string{"task-a", "task-b"}})
			if e != nil {
				t.Fatal(e)
			}
			content := first.Content
			if scenario == "different-content" {
				content = "另一条经验"
			}
			second, e := s.Create(ctx, a, "second", Input{Content: content, TaskIDs: []string{"task-a", "task-b"}})
			if e != nil {
				t.Fatal(e)
			}
			in := MergeInput{1, []MergeSource{{second.ID, 1}}}
			switch scenario {
			case "version":
				in.Sources[0].BaseVersion = 2
			case "confirmed":
				if _, e = s.Decide(ctx, a, "confirmed", second.ID, Decision{1, "confirm"}); e != nil {
					t.Fatal(e)
				}
				in.Sources[0].BaseVersion = 2
			case "expired":
				now := s.now().Add(31 * 24 * time.Hour)
				s.Clock = func() time.Time { return now }
			case "duplicate":
				in.Sources = append(in.Sources, in.Sources[0])
			case "foreign":
				a.ID = "other"
			}
			before, _ := os.ReadFile(s.path())
			if _, e = s.Merge(ctx, a, "merge", first.ID, in); e == nil {
				t.Fatal("invalid merge accepted")
			}
			after, _ := os.ReadFile(s.path())
			if string(before) != string(after) {
				t.Fatal("failed merge changed persisted state")
			}
		})
	}
}

func TestConcurrentMergeHasOneVersionWinner(t *testing.T) {
	s, a := fixture(t)
	ctx := context.Background()
	first, e := s.Create(ctx, a, "first", Input{Content: "相同经验", TaskIDs: []string{"task-a"}})
	if e != nil {
		t.Fatal(e)
	}
	second, e := s.Create(ctx, a, "second", Input{Content: first.Content, TaskIDs: []string{"task-b"}})
	if e != nil {
		t.Fatal(e)
	}
	in := MergeInput{1, []MergeSource{{second.ID, 1}}}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, key := range []string{"merge-a", "merge-b"} {
		wg.Add(1)
		go func(key string) { defer wg.Done(); _, e := s.Merge(ctx, a, key, first.ID, in); results <- e }(key)
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("got %d winners", success)
	}
}

func TestMergeRechecksEvidenceAndBoundsUnionBeforeCommit(t *testing.T) {
	for _, scenario := range []string{"missing-task", "foreign-task", "too-many-tasks", "duplicate-evidence"} {
		t.Run(scenario, func(t *testing.T) {
			s, a := fixture(t)
			ctx := context.Background()
			path := filepath.Join(s.Tasks.State, "agent-runtime/tasks-v1.json")
			var registry agenttasks.Registry
			if _, e := storage.Read(path, &registry); e != nil {
				t.Fatal(e)
			}
			firstIDs, secondIDs := []string{"task-a"}, []string{"task-b"}
			if scenario == "too-many-tasks" {
				firstIDs, secondIDs = nil, nil
				for i := 0; i < 9; i++ {
					id := fmt.Sprintf("source-%d", i)
					r := registry.Tasks["task-a"]
					r.Task.ID, r.Task.InputHash = id, id
					registry.Tasks[id] = r
					if i < 8 {
						firstIDs = append(firstIDs, id)
					} else {
						secondIDs = append(secondIDs, id)
					}
				}
			}
			if scenario == "duplicate-evidence" {
				secondIDs = firstIDs
			}
			if e := storage.Write(ctx, path, registry); e != nil {
				t.Fatal(e)
			}
			first, e := s.Create(ctx, a, "first", Input{Content: "相同经验", TaskIDs: firstIDs})
			if e != nil {
				t.Fatal(e)
			}
			second, e := s.Create(ctx, a, "second", Input{Content: first.Content, TaskIDs: secondIDs})
			if e != nil {
				t.Fatal(e)
			}
			if scenario == "missing-task" {
				delete(registry.Tasks, "task-b")
			}
			if scenario == "foreign-task" {
				r := registry.Tasks["task-b"]
				r.Task.Author = "other"
				registry.Tasks["task-b"] = r
			}
			if e := storage.Write(ctx, path, registry); e != nil {
				t.Fatal(e)
			}
			before, e := os.ReadFile(s.path())
			if e != nil {
				t.Fatal(e)
			}
			merged, e := s.Merge(ctx, a, "merge", first.ID, MergeInput{1, []MergeSource{{second.ID, 1}}})
			if scenario == "duplicate-evidence" {
				if e != nil || len(merged.Evidence) != 1 {
					t.Fatal(merged, e)
				}
				if _, e = s.Decide(ctx, a, "confirm", merged.ID, Decision{2, "confirm"}); e == nil || application.AsError(e).Code != "MEMORY_EVIDENCE_INSUFFICIENT" {
					t.Fatal(e)
				}
				return
			}
			if e == nil {
				t.Fatal("invalid evidence merged")
			}
			if scenario == "too-many-tasks" && application.AsError(e).Code != "INVALID_MEMORY_MERGE" {
				t.Fatal(e)
			}
			after, e := os.ReadFile(s.path())
			if e != nil {
				t.Fatal(e)
			}
			if string(before) != string(after) {
				t.Fatal("failed merge changed state")
			}
		})
	}
}
