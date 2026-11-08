package analysis

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
	"strings"
)

func (s *Service) path() string {
	return filepath.Join(s.App.State, "analysis", compat.Key(s.App.Project), "state-v1.json")
}

func (s *Service) load() (State, error) {
	st := State{}
	found, err := storage.Read(s.path(), &st)
	if err != nil {
		return st, err
	}
	if !found {
		return State{
			SchemaVersion: SchemaVersion,
			BookID:        s.App.Project,
			Jobs:          map[string]*Job{},
			Manifests:     map[string]*Manifest{},
			Findings:      map[string]*Finding{},
			Entities:      map[string]*Entity{},
			Requests:      map[string]receipt{},
		}, nil
	}
	if st.SchemaVersion != SchemaVersion || st.BookID != s.App.Project || st.Version < 0 ||
		st.Jobs == nil || st.Manifests == nil || st.Findings == nil || st.Entities == nil || st.Requests == nil {
		return st, application.Fail(500, "ANALYSIS_STORAGE_INVALID", "Analysis state is invalid.")
	}
	for id, job := range st.Jobs {
		if id != job.AnalysisID || job.BookID != st.BookID || !validJobStatus(job.Status) {
			return st, application.Fail(500, "ANALYSIS_STORAGE_INVALID", "Analysis job is invalid.")
		}
		if _, ok := st.Manifests[job.ManifestID]; !ok {
			return st, application.Fail(500, "ANALYSIS_STORAGE_INVALID", "Analysis manifest is missing.")
		}
	}
	for id, finding := range st.Findings {
		if id != finding.FindingID || finding.AnalysisID == "" || len(finding.Evidence) == 0 {
			return st, application.Fail(500, "ANALYSIS_STORAGE_INVALID", "Analysis finding is invalid.")
		}
	}
	for id, entity := range st.Entities {
		if id != entity.EntityID || entity.BookID != st.BookID || entity.Name == "" {
			return st, application.Fail(500, "ANALYSIS_STORAGE_INVALID", "World entity is invalid.")
		}
	}
	return st, nil
}

func (s *Service) transaction(ctx context.Context, fn func(*State) (bool, error)) error {
	return s.App.StateLock(ctx, s.path()+".lock", func() error {
		st, err := s.load()
		if err != nil {
			return err
		}
		changed, err := fn(&st)
		if err != nil {
			return err
		}
		if changed {
			st.Version++
			return s.App.CommitBookState(ctx, func() error { return storage.Write(ctx, s.path(), st) })
		}
		return nil
	})
}

func validJobStatus(status string) bool {
	switch status {
	case "queued", "running", "paused", "completed", "failed", "cancelled":
		return true
	}
	return false
}

func validBatchStatus(status string) bool {
	switch status {
	case "pending", "running", "completed", "failed", "stale":
		return true
	}
	return false
}

func newID(prefix string) string {
	return prefix + strings.ReplaceAll(compat.UUID(), "-", "")[:24]
}
