package application

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

// SavedRevisionAt is read-only; historical evidence never adopts Harness state.
func (s *Service) SavedRevisionAt(ctx context.Context, id, revision string) (StoredRevision, error) {
	c, e := s.Source(id)
	if e != nil {
		return StoredRevision{}, e
	}
	var out StoredRevision
	e = s.StateLock(ctx, s.draftPath(c)+".lock", func() error {
		var state *DraftState
		_, e := storage.Read(s.draftPath(c), &state)
		if e != nil {
			return e
		}
		candidates := []StoredRevision{sourceRevision(c, nil)}
		if state != nil {
			candidates = append(candidates, state.History...)
			candidates = append(candidates, state.Revisions...)
			if state.Source != nil {
				candidates = append(candidates, *state.Source)
			}
		}
		if revision == "" {
			out, e = s.readReviewRevision(c)
			return e
		}
		for _, r := range candidates {
			if r.ID == revision && r.Hash == compat.Hash(r.Markdown) {
				out = r
				return nil
			}
		}
		return Fail(404, "NOT_FOUND", "Saved revision not found.")
	})
	return out, e
}
