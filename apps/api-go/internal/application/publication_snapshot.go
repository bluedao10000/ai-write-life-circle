package application

import (
	"context"
	"sort"
)

// WithPublicationRevisions holds every selected draft lock through the publication
// commit. Saves cannot race validation and pointer switching. Callers must not
// call Head/Save inside fn; locks are ordered by chapter ID across processes.
func (s *Service) WithPublicationRevisions(ctx context.Context, ids []string, fn func([]Chapter, map[string]StoredRevision) error) error {
	keys := append([]string(nil), ids...)
	sort.Strings(keys)
	initial := map[string]Chapter{}
	for _, id := range keys {
		if _, exists := initial[id]; exists {
			return Fail(422, "VALIDATION_FAILED", "Duplicate chapter selection.")
		}
		c, err := s.Source(id)
		if err != nil {
			return err
		}
		initial[id] = c
	}
	var lock func(int) error
	lock = func(i int) error {
		if i < len(keys) {
			return s.StateLock(ctx, s.draftPath(initial[keys[i]])+".lock", func() error { return lock(i + 1) })
		}
		projection, err := s.Projection()
		if err != nil {
			return err
		}
		all, err := Sources(projection)
		if err != nil {
			return err
		}
		revisions := map[string]StoredRevision{}
		for _, id := range keys {
			c, err := Unique(projection, id)
			if err != nil {
				return err
			}
			state, err := s.loadDraft(ctx, c)
			if err != nil {
				return err
			}
			revisions[id] = head(c, state)
		}
		return fn(OrderedChapters(all), revisions)
	}
	return lock(0)
}
