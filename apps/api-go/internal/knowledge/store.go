package knowledge

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
)

func (s *Service) path() string {
	return filepath.Join(s.App.State, "knowledge", compat.Key(s.App.Project), "index-v1.json")
}
func (s *Service) load() (State, error) {
	st := State{}
	found, e := storage.Read(s.path(), &st)
	if e != nil {
		return st, e
	}
	if !found {
		return State{BookID: s.App.Project, SchemaVersion: 1, Settings: Settings{DailyTokenBudget: 100000000, DailyJobBudget: 200}, Entities: map[string]Entity{}, Assertions: map[string]Assertion{}, Jobs: []Job{}, Corrections: []Correction{}, Changes: []Change{}, Requests: map[string]receipt{}, Index: map[string][]string{}}, nil
	}
	if st.BookID != s.App.Project || st.SchemaVersion != 1 || st.Version < 0 || st.BudgetTokens < 0 || st.BudgetAttempts < 0 || st.Entities == nil || st.Assertions == nil || st.Requests == nil || st.Index == nil {
		return st, application.Fail(500, "KNOWLEDGE_STORAGE_INVALID", "Knowledge state is invalid.")
	}
	for id, entity := range st.Entities {
		if id != entity.ID || entity.BookID != st.BookID || !types[entity.Type] {
			return st, application.Fail(500, "KNOWLEDGE_STORAGE_INVALID", "Invalid knowledge entity.")
		}
	}
	legacyCompletion := map[string]string{}
	for _, c := range st.Changes {
		if c.Kind == "extracted" && c.JobID != "" {
			legacyCompletion[c.JobID] = c.At
		}
	}
	for index, job := range st.Jobs {
		if job.CreatedAt == "" {
			if at := legacyCompletion[job.ID]; at != "" {
				job.CreatedAt = at
				st.Jobs[index] = job
			} else {
				return st, application.Fail(500, "KNOWLEDGE_STORAGE_INVALID", "Knowledge job lacks creation time.")
			}
		}
	}
	for id, a := range st.Assertions {
		if id != a.ID || len(a.Sources) == 0 {
			return st, application.Fail(500, "KNOWLEDGE_STORAGE_INVALID", "Invalid assertion.")
		}
		if _, ok := st.Entities[a.EntityID]; !ok {
			return st, application.Fail(500, "KNOWLEDGE_STORAGE_INVALID", "Invalid entity reference.")
		}
		if a.TargetID != "" {
			if _, ok := st.Entities[a.TargetID]; !ok {
				return st, application.Fail(500, "KNOWLEDGE_STORAGE_INVALID", "Invalid relation reference.")
			}
		}
		for _, src := range a.Sources {
			if src.BookID != st.BookID || src.RevisionID == "" || src.ContentHash == "" || src.Start < 0 || src.End-src.Start != compat.UTF16Len(src.Quote) {
				return st, application.Fail(500, "KNOWLEDGE_STORAGE_INVALID", "Invalid source reference.")
			}
		}
	}
	return st, nil
}
func (s *Service) transaction(ctx context.Context, fn func(*State) (bool, error)) error {
	return s.App.StateLock(ctx, s.path()+".lock", func() error {
		st, e := s.load()
		if e != nil {
			return e
		}
		changed, e := fn(&st)
		if e != nil {
			return e
		}
		if changed {
			st.Version++
			return s.App.CommitBookState(ctx, func() error { return storage.Write(ctx, s.path(), st) })
		}
		return nil
	})
}
