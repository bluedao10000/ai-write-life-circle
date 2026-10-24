package publication

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
	"strings"
)

type Service struct {
	// Books is trusted server configuration, immutable after startup. Never accept
	// an owner or Harness root from an HTTP request.
	ResolveBook func(application.Actor, string) (Book, error)
	Books       map[string]Book
	StateDir    string
	write       func(context.Context, string, any) error
}

func New(dir string, books map[string]Book) *Service {
	copyBooks := map[string]Book{}
	for id, b := range books {
		copyBooks[id] = b
	}
	return &Service{StateDir: dir, Books: copyBooks, write: storage.Write}
}
func fail(status int, code, detail string) error { return application.Fail(status, code, detail) }
func storageFailure() error {
	return fail(500, "PUBLICATION_STORAGE_FAILED", "Publication could not be committed. Retry with the same Idempotency-Key.")
}
func (s *Service) path() string { return filepath.Join(s.StateDir, "publications", "state-v1.json") }
func (s *Service) load() (state, error) {
	var st state
	found, err := storage.Read(s.path(), &st)
	if err != nil {
		return st, storageFailure()
	}
	if !found {
		return state{1, map[string]Publication{}, map[string]Preview{}, map[string]requestRecord{}, map[string]string{}, []Audit{}}, nil
	}
	if st.Schema != 1 || st.Publications == nil || st.Previews == nil || st.Requests == nil || st.AuthorSlugs == nil || st.Audit == nil {
		return st, storageFailure()
	}
	for id, p := range st.Publications {
		if id != p.BookID || p.ID == "" || p.OwnerID == "" || p.AuthorSlug == "" || len(p.Versions) == 0 || p.ChapterSlugs == nil || p.Current != p.Versions[len(p.Versions)-1].ID {
			return st, storageFailure()
		}

		seen := map[string]bool{}
		for i, v := range p.Versions {
			if v.ID == "" || seen[v.ID] || v.PublicationID != p.ID || v.Number != i+1 || (v.State != "listed" && v.State != "unlisted") || validateMetadata(v.Metadata) != nil || (v.State == "listed" && len(v.Chapters) == 0) {
				return st, storageFailure()
			}
			seen[v.ID] = true
			chapterSlugs := map[string]bool{}
			for _, c := range v.Chapters {
				if !validSlug(c.Slug) || chapterSlugs[c.Slug] || c.ContentHash != compat.Hash(c.Markdown) || strings.TrimSpace(c.Markdown) == "" || c.RevisionID == "" || c.ChapterID == "" || c.VolumeOrder < 1 {
					return st, storageFailure()
				}
				chapterSlugs[c.Slug] = true
			}
		}
	}
	return st, nil
}
func (s *Service) transaction(ctx context.Context, fn func(*state) (bool, error)) error {
	err := storage.Lock(ctx, s.path()+".lock", func() error {
		st, err := s.load()
		if err != nil {
			return err
		}
		changed, err := fn(&st)
		if err != nil {
			return err
		}
		if changed {
			if err = s.write(ctx, s.path(), st); err != nil {
				return storageFailure()
			}
		}
		return nil
	})
	if err != nil {
		if _, ok := err.(*application.Error); ok {
			return err
		}
		return storageFailure()
	}
	return nil
}
func (s *Service) authorize(actor application.Actor, id string) (Book, error) {
	if actor.Role != "author" {
		return Book{}, fail(403, "AUTHOR_DECISION_REQUIRED", "Only the owning author can manage publication.")
	}
	if s.ResolveBook != nil {
		return s.ResolveBook(actor, id)
	}
	b, ok := s.Books[id]
	if !ok || b.App == nil || b.OwnerID == "" || actor.ID != b.OwnerID {
		return Book{}, fail(404, "NOT_FOUND", "Book not found.")
	}
	return b, nil
}

// CheckDelete uses the publication state directly rather than resolving the
// managed catalog, so an unlisted book's immutable history can be removed while
// the catalog deletion is still being prepared.
func (s *Service) CheckDelete(ctx context.Context, a application.Actor, id string) error {
	if a.Role != "author" || a.ID == "" {
		return fail(403, "AUTHOR_DECISION_REQUIRED", "Only the owning author can delete publication state.")
	}
	return s.transaction(ctx, func(st *state) (bool, error) {
		p, ok := st.Publications[id]
		if !ok {
			return false, nil
		}
		if p.OwnerID != a.ID {
			return false, fail(404, "NOT_FOUND", "Book not found.")
		}
		if current(p).State == "listed" {
			return false, fail(409, "PUBLICATION_LISTED", "请先在发布页下架作品，再删除。")
		}
		return false, nil
	})
}

// DeleteOwned purges publication-only state after the managed catalog has
// committed the book's disappearance. CheckDelete rejects an existing listed
// version before normal deletion; remeasuring the state here also resolves the
// narrow race in which another request lists the book just after that check.
func (s *Service) DeleteOwned(ctx context.Context, a application.Actor, id string) error {
	if a.Role != "author" || a.ID == "" {
		return fail(403, "AUTHOR_DECISION_REQUIRED", "Only the owning author can delete publication state.")
	}
	return s.transaction(ctx, func(st *state) (bool, error) {
		p, ok := st.Publications[id]
		if !ok {
			return false, nil
		}
		if p.OwnerID != a.ID {
			return false, fail(404, "NOT_FOUND", "Book not found.")
		}
		delete(st.Publications, id)
		for previewID, preview := range st.Previews {
			if preview.BookID == id {
				delete(st.Previews, previewID)
			}
		}
		for requestID, request := range st.Requests {
			if request.Version.PublicationID == p.ID {
				delete(st.Requests, requestID)
			}
		}
		// Preserve the immutable publication audit trail. The catalog tombstone
		// and lack of a publication record already make the deleted book
		// inaccessible, while the audit remains useful for owners and operators.
		used := false
		for _, other := range st.Publications {
			if other.OwnerID == a.ID {
				used = true
				break
			}
		}
		if !used && st.AuthorSlugs[a.ID] != "" {
			delete(st.AuthorSlugs, a.ID)
		}
		return true, nil
	})
}
func current(p Publication) Version { return p.Versions[len(p.Versions)-1] }
func sameBase(base *string, p Publication) bool {
	return (base == nil && p.Current == "") || (base != nil && *base == p.Current)
}
func versionConflict() error {
	return fail(409, "PUBLICATION_VERSION_CONFLICT", "Publication changed. Reload, preview and confirm again.")
}

func storageTransaction(ctx context.Context, s *Service, fn func(*state) error) error {
	err := storage.Lock(ctx, s.path()+".lock", func() error {
		st, err := s.load()
		if err != nil {
			return err
		}
		return fn(&st)
	})
	if err != nil {
		if _, ok := err.(*application.Error); ok {
			return err
		}
		return storageFailure()
	}
	return nil
}
