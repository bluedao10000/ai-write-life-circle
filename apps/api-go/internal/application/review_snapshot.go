package application

import (
	"context"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

// ReviewRevision reads the current saved revision without adopting or rewriting Draft state.
// It shares the existing lock and CAS semantics but has no persistence side effects.
func (s *Service) ReviewRevision(ctx context.Context, c Chapter) (StoredRevision, error) {
	var result StoredRevision
	err := s.StateLock(ctx, s.draftPath(c)+".lock", func() error {
		var e error
		result, e = s.readReviewRevision(c)
		return e
	})
	return result, err
}
func (s *Service) readReviewRevision(c Chapter) (StoredRevision, error) {
	var result StoredRevision
	var state *DraftState
	found, e := storage.Read(s.draftPath(c), &state)
	if e != nil {
		return result, e
	}
	if !found {
		result = sourceRevision(c, nil)
		return result, nil
	}
	if state == nil || state.SourceHash == "" || state.Revisions == nil {
		return result, errors.New("invalid saved revision state")
	}
	if state.SourceHash != c.SourceHash {
		if len(state.Revisions) == 0 || state.Revisions[len(state.Revisions)-1].Hash != compat.Hash(c.Markdown) {
			return result, conflict(nil, pointer(c.SourceRevisionID))
		}
		result = sourceRevision(c, nil)
	} else {
		result = head(c, state)
	}
	if result.ID == "" || result.Hash != compat.Hash(result.Markdown) {
		return result, errors.New("saved revision hash mismatch")
	}
	return result, nil
}

// WithReviewRevision holds a saved-head lock through a derived-state commit,
// without adopting Harness state or writing any manuscript revision metadata.
func (s *Service) WithReviewRevision(ctx context.Context, id string, fn func(StoredRevision) error) error {
	c, e := s.Source(id)
	if e != nil {
		return e
	}
	return s.StateLock(ctx, s.draftPath(c)+".lock", func() error {
		current, e := s.Source(id)
		if e != nil {
			return e
		}
		r, e := s.readReviewRevision(current)
		if e != nil {
			return e
		}
		return fn(r)
	})
}
