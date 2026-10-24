package publication

import (
	"context"
	"encoding/json"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"strings"
	"time"
)

func (s *Service) snapshots(ctx context.Context, b Book, selections []Selection, fn func([]Snapshot) error) error {
	if len(selections) == 0 {
		return fn([]Snapshot{})
	}
	if len(selections) > 100 {
		return fail(422, "VALIDATION_FAILED", "Select at most 100 saved chapters.")
	}
	ids := []string{}
	selected := map[string]Selection{}
	for _, v := range selections {
		if !validSelection(v) {
			return fail(422, "VALIDATION_FAILED", "Invalid chapter revision selection.")
		}
		if _, ok := selected[v.ChapterID]; ok {
			return fail(422, "VALIDATION_FAILED", "Duplicate chapter selection.")
		}
		ids = append(ids, v.ChapterID)
		selected[v.ChapterID] = v
	}
	return b.App.WithPublicationRevisions(ctx, ids, func(chapters []application.Chapter, heads map[string]application.StoredRevision) error {
		result := []Snapshot{}
		volumes := map[string]int{}
		size := 0
		for _, c := range chapters {
			if _, ok := volumes[c.VolumeID]; !ok {
				volumes[c.VolumeID] = len(volumes) + 1
			}
			expected, ok := selected[c.ID]
			if !ok {
				continue
			}
			h := heads[c.ID]
			order := int64(0)
			if c.Order != nil {
				order = *c.Order
			}
			if expected.RevisionID != h.ID || expected.ContentHash != h.Hash || expected.VolumeID != c.VolumeID || expected.ChapterOrder != order || h.Hash != compat.Hash(h.Markdown) {
				return fail(409, "PUBLICATION_REVISION_CONFLICT", "A selected chapter changed. Preview and confirm again.")
			}
			if strings.TrimSpace(h.Markdown) == "" {
				return fail(422, "EMPTY_CHAPTER", "Empty chapters cannot be published.")
			}
			size += len(h.Markdown)
			if size > 20*1024*1024 {
				return fail(422, "PUBLICATION_TOO_LARGE", "Selected prose exceeds 20 MiB.")
			}
			result = append(result, Snapshot{Selection: expected, Title: c.Title, VolumeTitle: c.VolumeTitle, VolumeOrder: volumes[c.VolumeID], Markdown: h.Markdown})
		}
		if len(result) != len(selected) {
			return fail(409, "PUBLICATION_REVISION_CONFLICT", "Chapter selection is no longer available.")
		}
		return fn(result)
	})
}
func (s *Service) Preview(ctx context.Context, a application.Actor, id string, input PreviewInput) (Preview, error) {
	var out Preview
	b, err := s.authorize(a, id)
	if err != nil {
		return out, err
	}
	if err = validateMetadata(input.Metadata); err != nil {
		return out, err
	}
	err = s.transaction(ctx, func(st *state) (bool, error) {
		if _, err := s.authorize(a, id); err != nil {
			return false, err
		}
		p := st.Publications[id]
		if p.ID == "" && len(input.Chapters) == 0 {
			return false, fail(422, "EMPTY_PUBLICATION", "Select at least one chapter for first publication.")
		}
		if !sameBase(input.BaseVersionID, p) {
			return false, versionConflict()
		}
		for bid, other := range st.Publications {
			for _, v := range other.Versions {
				if bid != id && v.Metadata.Slug == input.Metadata.Slug {
					return false, fail(409, "PUBLIC_SLUG_TAKEN", "The public slug is already reserved.")
				}
			}
		}
		err := s.snapshots(ctx, b, input.Chapters, func(chapters []Snapshot) error {
			previous := []Snapshot{}
			selectedIDs := map[string]bool{}
			for _, c := range chapters {
				selectedIDs[c.ChapterID] = true
			}
			var priorChapters []Snapshot
			if len(p.Versions) > 0 {
				priorChapters = current(p).Chapters
			}
			for _, c := range priorChapters {
				if selectedIDs[c.ChapterID] {
					previous = append(previous, c)
				}
			}
			out = Preview{PreviousChapters: previous, ID: compat.UUID(), BookID: id, BaseVersionID: input.BaseVersionID, Metadata: input.Metadata, Chapters: chapters, ExpiresAt: time.Now().UTC().Add(30 * time.Minute).Format(time.RFC3339Nano), CreatedBy: a.ID}
			return nil
		})
		if err != nil {
			return false, err
		}
		for key, p := range st.Previews {
			expiry, e := time.Parse(time.RFC3339Nano, p.ExpiresAt)
			if e != nil || time.Now().After(expiry) {
				delete(st.Previews, key)
			}
		}
		previewBytes := 0
		for _, p := range st.Previews {
			for _, c := range append(append([]Snapshot{}, p.Chapters...), p.PreviousChapters...) {
				previewBytes += len(c.Markdown)
			}
		}
		for _, c := range out.Chapters {
			previewBytes += len(c.Markdown)
		}
		if len(st.Previews) >= 20 || previewBytes > 64*1024*1024 {
			return false, fail(429, "PREVIEW_LIMIT_REACHED", "Too many active previews. Wait for expiration.")
		}
		// Comparison prose is returned on demand, not duplicated in the frozen
		// commit plan. CAS already binds the old immutable publication version.
		frozen := out
		frozen.PreviousChapters = nil
		st.Previews[out.ID] = frozen
		return true, nil
	})
	return out, err
}
func fingerprint(v any) string { data, _ := json.Marshal(v); return compat.Hash(string(data)) }
func appendVersion(st *state, p *Publication, a application.Actor, action string, v Version) {
	v.ID = compat.UUID()
	v.PublicURL = "/books/" + v.Metadata.Slug
	v.PublicationID = p.ID
	v.Number = len(p.Versions) + 1
	v.CreatedAt = compat.Now()
	v.CreatedBy = a.ID
	v.AuditReference = compat.UUID()
	// Each append allocates a new slice. Existing versions and chapter snapshots
	// are never modified, including unlist/relist transitions.
	p.Versions = append(p.Versions, v)
	p.Current = v.ID
	st.Publications[p.BookID] = *p
	st.Audit = append(st.Audit, Audit{v.AuditReference, p.BookID, v.ID, a.ID, action, v.CreatedAt})
}
func (s *Service) mutate(ctx context.Context, a application.Actor, id, key, action string, input any, build func(*state, Publication, Book) (Version, error)) (Version, error) {
	var out Version
	b, err := s.authorize(a, id)
	if err != nil {
		return out, err
	}
	if !application.SafeKey(key) || len(key) > 128 {
		return out, fail(422, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key of at most 128 characters is required.")
	}
	requestKey := fingerprint([]string{a.ID, id, key})
	hash := fingerprint([]any{action, input})
	err = s.transaction(ctx, func(st *state) (bool, error) {
		if _, err := s.authorize(a, id); err != nil {
			return false, err
		}
		if prior, ok := st.Requests[requestKey]; ok {
			if prior.Fingerprint != hash {
				return false, fail(422, "IDEMPOTENCY_KEY_REUSED", "The key was used for another publication request.")
			}
			out = prior.Version
			return false, nil
		}
		p := st.Publications[id]
		if p.OwnerID != "" && p.OwnerID != a.ID {
			return false, fail(404, "NOT_FOUND", "Book not found.")
		}
		if p.ID == "" {
			authorSlug := st.AuthorSlugs[a.ID]
			if authorSlug == "" {
				authorSlug = "author-" + compat.UUID()
				st.AuthorSlugs[a.ID] = authorSlug
			}
			p = Publication{ID: compat.UUID(), BookID: id, OwnerID: a.ID, AuthorSlug: authorSlug, Versions: []Version{}, ChapterSlugs: map[string]string{}}
		}
		v, err := build(st, p, b)
		if err != nil {
			return false, err
		}
		appendVersion(st, &p, a, action, v)
		out = current(p)
		st.Requests[requestKey] = requestRecord{hash, out}
		return true, nil
	})
	return out, err
}
func (s *Service) Publish(ctx context.Context, a application.Actor, id, key string, input CommitInput) (Version, error) {
	// Keep the chapter locks until the single state write (the visibility commit),
	// not merely until validation. Implement the transaction explicitly here.
	var out Version
	b, err := s.authorize(a, id)
	if err != nil {
		return out, err
	}
	if !application.SafeKey(key) || len(key) > 128 {
		return out, fail(422, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key is required.")
	}
	if !bounded(input.Note, 2000, false) {
		return out, fail(422, "VALIDATION_FAILED", "Publication note is too long.")
	}
	requestKey := fingerprint([]string{a.ID, id, key})
	hash := fingerprint([]any{"publish", input})
	// transaction cannot own the write here because it would release chapter locks
	// first. The outer publication lock and inner ordered revision locks share one
	// commit point, including audit and idempotency.
	err = storageTransaction(ctx, s, func(st *state) error {
		if _, err := s.authorize(a, id); err != nil {
			return err
		}
		if prior, ok := st.Requests[requestKey]; ok {
			if prior.Fingerprint != hash {
				return fail(422, "IDEMPOTENCY_KEY_REUSED", "The key was used for another request.")
			}
			out = prior.Version
			return nil
		}
		p := st.Publications[id]
		if !sameBase(input.BaseVersionID, p) {
			return versionConflict()
		}
		preview, ok := st.Previews[input.PreviewID]
		if !ok || preview.BookID != id || preview.CreatedBy != a.ID {
			return fail(404, "PREVIEW_NOT_FOUND", "Preview not found or expired.")
		}
		expiry, e := time.Parse(time.RFC3339Nano, preview.ExpiresAt)
		if e != nil || time.Now().After(expiry) {
			return fail(409, "PREVIEW_EXPIRED", "Preview expired. Preview and confirm again.")
		}
		if !sameBase(preview.BaseVersionID, p) {
			return versionConflict()
		}
		if p.OwnerID != "" && p.OwnerID != a.ID {
			return fail(404, "NOT_FOUND", "Book not found.")
		}
		for bid, other := range st.Publications {
			for _, v := range other.Versions {
				if bid != id && v.Metadata.Slug == preview.Metadata.Slug {
					return fail(409, "PUBLIC_SLUG_TAKEN", "The public slug is already reserved.")
				}
			}
		}
		choices := []Selection{}
		for _, c := range preview.Chapters {
			choices = append(choices, c.Selection)
		}
		return s.snapshots(ctx, b, choices, func(chapters []Snapshot) error {
			// Title and global ordering are previewed public data too. A Harness metadata
			// edit must invalidate the preview even if prose and revision stayed equal.
			if fingerprint(chapters) != fingerprint(preview.Chapters) {
				return fail(409, "PUBLICATION_REVISION_CONFLICT", "Chapter metadata changed. Preview again.")
			}
			if p.ID == "" {
				authorSlug := st.AuthorSlugs[a.ID]
				if authorSlug == "" {
					authorSlug = "author-" + compat.UUID()
					st.AuthorSlugs[a.ID] = authorSlug
				}
				p = Publication{ID: compat.UUID(), BookID: id, OwnerID: a.ID, AuthorSlug: authorSlug, Versions: []Version{}, ChapterSlugs: map[string]string{}}
			}
			for i := range chapters {
				slug := p.ChapterSlugs[chapters[i].ChapterID]
				if slug == "" {
					slug = "chapter-" + compat.UUID()
					p.ChapterSlugs[chapters[i].ChapterID] = slug
				}
				chapters[i].Slug = slug
			}
			publicationState := "listed"
			if len(chapters) == 0 {
				publicationState = "unlisted"
			}
			appendVersion(st, &p, a, "publication.published", Version{Note: input.Note, State: publicationState, Metadata: preview.Metadata, Chapters: chapters})
			out = current(p)
			st.Requests[requestKey] = requestRecord{hash, out}
			if err := s.write(ctx, s.path(), st); err != nil {
				return storageFailure()
			}
			return nil
		})
	})
	return out, err
}
func (s *Service) Transition(ctx context.Context, a application.Actor, id, key, action string, input TransitionInput) (Version, error) {
	if action != "unlist" && action != "relist" {
		return Version{}, fail(422, "VALIDATION_FAILED", "Invalid publication transition.")
	}
	return s.mutate(ctx, a, id, key, action, input, func(st *state, p Publication, b Book) (Version, error) {
		if p.Current == "" {
			return Version{}, fail(404, "NOT_FOUND", "Publication not found.")
		}
		if !sameBase(input.BaseVersionID, p) {
			return Version{}, versionConflict()
		}
		v := current(p)
		if action == "relist" && len(v.Chapters) == 0 {
			return Version{}, fail(422, "EMPTY_PUBLICATION", "Publish at least one chapter before relisting.")
		}
		v.ID = ""
		v.State = "unlisted"
		if action == "relist" {
			v.State = "listed"
		}
		return v, nil
	})
}
func (s *Service) Manage(ctx context.Context, a application.Actor, id string) (Management, error) {
	out := Management{ChangedChapterIDs: []string{}, Drafts: []DraftSummary{}}
	b, err := s.authorize(a, id)
	if err != nil {
		return out, err
	}
	err = s.transaction(ctx, func(st *state) (bool, error) {
		if _, err := s.authorize(a, id); err != nil {
			return false, err
		}
		p, exists := st.Publications[id]
		if exists && p.OwnerID != a.ID {
			return false, fail(404, "NOT_FOUND", "Book not found.")
		}
		projection, e := b.App.Projection()
		if e != nil {
			return false, e
		}
		sources, e := application.Sources(projection)
		if e != nil {
			return false, e
		}
		drafts := map[string]DraftSummary{}
		for _, c := range application.OrderedChapters(sources) {
			h, e := b.App.ReviewRevision(ctx, c)
			if e != nil {
				return false, e
			}
			order := int64(0)
			if c.Order != nil {
				order = *c.Order
			}
			d := DraftSummary{Selection: Selection{c.ID, h.ID, h.Hash, c.VolumeID, order}, Title: c.Title, VolumeTitle: c.VolumeTitle, Words: compat.Words(h.Markdown), IsEmpty: strings.TrimSpace(h.Markdown) == ""}
			out.Drafts = append(out.Drafts, d)
			drafts[c.ID] = d
		}
		if !exists {
			return false, nil
		}
		summary := PublicationSummary{Publication: p, Versions: []VersionSummary{}}
		for _, v := range p.Versions {
			sv := VersionSummary{Version: v, Chapters: []SnapshotSummary{}}
			for _, c := range v.Chapters {
				sv.Chapters = append(sv.Chapters, SnapshotSummary{Selection: c.Selection, Slug: c.Slug, Title: c.Title, VolumeTitle: c.VolumeTitle, VolumeOrder: c.VolumeOrder})
			}
			summary.Versions = append(summary.Versions, sv)
		}
		out.Publication = &summary
		for _, c := range current(p).Chapters {
			d, ok := drafts[c.ChapterID]
			if !ok || d.ContentHash != c.ContentHash || d.RevisionID != c.RevisionID || d.Title != c.Title || fingerprint(d.VolumeTitle) != fingerprint(c.VolumeTitle) || d.VolumeID != c.VolumeID || d.ChapterOrder != c.ChapterOrder {
				out.ChangedChapterIDs = append(out.ChangedChapterIDs, c.ChapterID)
			}
		}
		return false, nil
	})
	return out, err
}

// Full immutable history is fetched only on an explicit author request.
func (s *Service) History(ctx context.Context, a application.Actor, id string) ([]Version, error) {
	out := []Version{}
	if _, err := s.authorize(a, id); err != nil {
		return out, err
	}
	err := s.transaction(ctx, func(st *state) (bool, error) {
		if _, err := s.authorize(a, id); err != nil {
			return false, err
		}
		p, ok := st.Publications[id]
		if !ok {
			return false, nil
		}
		if p.OwnerID != a.ID {
			return false, fail(404, "NOT_FOUND", "Book not found.")
		}
		out = p.Versions
		return false, nil
	})
	return out, err
}
