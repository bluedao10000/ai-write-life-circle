package agenttasks

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"sort"
)

// TaskEvidence is a metadata projection of a completed business receipt.
// It contains no request, lease, credential, model output or billing state.
type TaskEvidence struct {
	TaskID      string `json:"taskId"`
	Kind        string `json:"kind"`
	Strategy    string `json:"strategyVersion"`
	InputHash   string `json:"inputHash"`
	CompletedAt string `json:"completedAt"`
}
type EvidenceSnapshot struct{ items map[string]TaskEvidence }

func (s *Service) MemoryEvidence(ctx context.Context, actor application.Actor, book string) (EvidenceSnapshot, error) {
	out := EvidenceSnapshot{items: map[string]TaskEvidence{}}
	if actor.Role != "author" {
		return out, application.Fail(403, "AUTHOR_DECISION_REQUIRED", "Author identity required.")
	}
	if _, e := s.Management.Resolve(actor, book); e != nil {
		return out, e
	}
	if e := ctx.Err(); e != nil {
		return out, e
	}
	state, e := s.load()
	if e != nil {
		return out, e
	}
	for id, r := range state.Tasks {
		if r.Task.Author != actor.ID || r.Task.Book != book || !r.Finished || r.Outcome != "completed" || r.CompletedAt == "" || r.Task.InputHash == "" || r.Task.Strategy == "" {
			continue
		}
		out.items[id] = TaskEvidence{id, r.Task.Kind, r.Task.Strategy, r.Task.InputHash, r.CompletedAt}
	}
	return out, nil
}
func (s EvidenceSnapshot) Lookup(ids []string) ([]TaskEvidence, error) {
	if len(ids) < 1 || len(ids) > 8 {
		return nil, application.Fail(422, "INVALID_MEMORY_EVIDENCE", "Choose 1-8 completed tasks.")
	}
	out := []TaskEvidence{}
	seen := map[string]bool{}
	for _, id := range ids {
		item, ok := s.items[id]
		if !ok {
			return nil, application.Fail(404, "MEMORY_SOURCE_UNAVAILABLE", "Task source unavailable.")
		}
		if seen[id] {
			return nil, application.Fail(422, "INVALID_MEMORY_EVIDENCE", "Distinct completed tasks are required.")
		}
		seen[id] = true
		out = append(out, item)
	}
	return out, nil
}
func (s EvidenceSnapshot) Recent() []TaskEvidence {
	out := []TaskEvidence{}
	for _, item := range s.items {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CompletedAt != out[j].CompletedAt {
			return out[i].CompletedAt > out[j].CompletedAt
		}
		return out[i].TaskID < out[j].TaskID
	})
	if len(out) > 100 {
		out = out[:100]
	}
	return out
}
func (s *Service) Evidence(ctx context.Context, actor application.Actor, book string, ids []string) ([]TaskEvidence, error) {
	snapshot, e := s.MemoryEvidence(ctx, actor, book)
	if e != nil {
		return nil, e
	}
	return snapshot.Lookup(ids)
}
