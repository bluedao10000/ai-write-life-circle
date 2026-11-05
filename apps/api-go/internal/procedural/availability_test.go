package procedural

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agenttasks"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

func TestComparedExperienceMustRemainCurrentlyAvailable(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*testing.T, *Service, Record)
	}{
		{
			name: "version changed",
			mutate: func(t *testing.T, s *Service, target Record) {
				t.Helper()
				if _, err := s.Decide(context.Background(), application.Actor{ID: "owner", Role: "author"}, "reject-target", target.ID, Decision{target.Version, "reject"}); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "source unavailable",
			mutate: func(t *testing.T, s *Service, target Record) {
				t.Helper()
				path := filepath.Join(s.Tasks.State, "agent-runtime", "tasks-v1.json")
				registry := agenttasks.Registry{Schema: 1, Tasks: map[string]agenttasks.Record{}}
				if _, err := storage.Read(path, &registry); err != nil {
					t.Fatal(err)
				}
				record := registry.Tasks[target.Evidence[0].TaskID]
				record.Outcome = "failed"
				registry.Tasks[record.Task.ID] = record
				if err := storage.Write(context.Background(), path, registry); err != nil {
					t.Fatal(err)
				}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, actor := fixture(t)
			ctx := context.Background()
			s.ValidateExtraction = func(context.Context, application.Actor, string, Extraction) error { return nil }
			target, err := s.Create(ctx, actor, "target", Input{Content: "先核对来源版本。", TaskIDs: []string{"task-a", "task-b"}})
			if err != nil {
				t.Fatal(err)
			}
			target, err = s.Decide(ctx, actor, "confirm-target", target.ID, Decision{target.Version, "confirm"})
			if err != nil {
				t.Fatal(err)
			}
			candidate, err := s.CreateExtracted(ctx, actor, "candidate", Input{Content: "冲突时重新读取来源。", TaskIDs: []string{"task-a", "task-b"}}, Extraction{
				SessionID: "session", RunID: "run", Provider: "fixture", Model: "fixture", PromptVersion: "memory-extraction-v1",
				Relations: []ExtractionRelation{{MemoryID: target.ID, MemoryVersion: target.Version, Kind: "refinement", Reason: "版本变化后需要重新核对。"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			views, err := s.List(ctx, actor)
			if err != nil {
				t.Fatal(err)
			}
			if viewByID(views, target.ID).Available != true || viewByID(views, candidate.ID).UnavailableReason != "not_confirmed" {
				t.Fatal(views)
			}
			test.mutate(t, s, target)
			views, err = s.List(ctx, actor)
			if err != nil {
				t.Fatal(err)
			}
			if view := viewByID(views, candidate.ID); view.Available || view.UnavailableReason != "source_unavailable" {
				t.Fatal(view)
			}
			if _, err = s.Decide(ctx, actor, "confirm-candidate", candidate.ID, Decision{candidate.Version, "confirm"}); err == nil || application.AsError(err).Code != "MEMORY_SOURCE_CHANGED" {
				t.Fatal("stale comparison was confirmed", err)
			}
		})
	}
}

func viewByID(views []View, id string) View {
	for _, view := range views {
		if view.ID == id {
			return view
		}
	}
	return View{}
}
