package publication

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

// Availability transitions and private notes are not reader-visible updates.
// Derive from existing immutable history, so old persisted versions need no migration.
func contentUpdatedAt(p Publication) string {
	updated, prior := "", ""
	for _, v := range p.Versions {
		chapters := []any{}
		for _, c := range v.Chapters {
			chapters = append(chapters, []any{c.Slug, c.Title, c.ContentHash, c.VolumeTitle, c.VolumeOrder, c.ChapterOrder})
		}
		hash := fingerprint([]any{v.Metadata, chapters})
		if hash != prior {
			updated = v.CreatedAt
			prior = hash
		}
	}
	return updated
}
func publicBook(p Publication) PublicBook {
	v := current(p)
	m := v.Metadata
	updated := contentUpdatedAt(p)
	out := PublicBook{ContentUpdatedAt: updated, PublicationUpdatedAt: v.CreatedAt, FirstPublishedAt: p.Versions[0].CreatedAt, Slug: m.Slug, Title: m.Title, PenName: m.PenName, AuthorSlug: p.AuthorSlug, Tagline: m.Tagline, Description: m.Description, Category: m.Category, Categories: m.Categories, SerialStatus: m.SerialStatus, CoverURL: m.CoverURL, Cover: m.Cover, UpdatedAt: updated, ChapterCount: len(v.Chapters), Chapters: []PublicChapterRef{}}
	for _, c := range v.Chapters {
		out.Chapters = append(out.Chapters, publicRef(p, c))
	}
	return out
}
func publicRef(p Publication, c Snapshot) PublicChapterRef {
	first, updated, prior := "", "", ""
	for _, v := range p.Versions {
		for _, candidate := range v.Chapters {
			if candidate.ChapterID == c.ChapterID {
				if first == "" {
					first = v.CreatedAt
				}
				hash := fingerprint([]any{candidate.ContentHash, candidate.Title, candidate.VolumeTitle, candidate.VolumeOrder, candidate.ChapterOrder})
				if hash != prior {
					updated = v.CreatedAt
					prior = hash
				}
				break
			}
		}
	}
	return PublicChapterRef{Slug: c.Slug, Title: c.Title, VolumeTitle: c.VolumeTitle, VolumeOrder: c.VolumeOrder, ChapterOrder: c.ChapterOrder, PublishedAt: first, UpdatedAt: updated}
}
func (s *Service) publicState(ctx context.Context, fn func(state) error) error {
	return s.transaction(ctx, func(st *state) (bool, error) { return false, fn(*st) })
}
func publicBooks(st state) []PublicBook {
	out := []PublicBook{}
	for _, p := range st.Publications {
		if current(p).State == "listed" {
			out = append(out, publicBook(p))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt != out[j].UpdatedAt {
			return out[i].UpdatedAt > out[j].UpdatedAt
		}
		return out[i].Slug < out[j].Slug
	})
	return out
}
func findPublic(st state, slug string) (Publication, error) {
	for _, p := range st.Publications {
		if current(p).State == "listed" && current(p).Metadata.Slug == slug {
			return p, nil
		}
	}
	return Publication{}, fail(404, "NOT_FOUND", "Public book not found.")
}
func (s *Service) Catalog(ctx context.Context, q Query) (Catalog, error) {
	out := Catalog{Items: []PublicBook{}}
	if q.Limit < 1 || q.Limit > 100 || q.Offset < 0 || len(q.Search) > 500 || len(q.Category) > 320 || (q.Sort != "" && q.Sort != "recent" && q.Sort != "title") || (q.Status != "" && q.Status != "ongoing" && q.Status != "completed" && q.Status != "paused") {
		return out, fail(422, "VALIDATION_FAILED", "Invalid catalog query.")
	}
	err := s.publicState(ctx, func(st state) error {
		items := []PublicBook{}
		for _, b := range publicBooks(st) {
			if (q.Category == "" || hasCategory(b, q.Category)) && (q.Status == "" || b.SerialStatus == q.Status) && strings.Contains(strings.ToLower(b.Title+"\n"+b.Tagline+"\n"+b.Description+"\n"+b.PenName), strings.ToLower(q.Search)) {
				items = append(items, b)
			}
		}
		if q.Sort == "title" {
			sort.SliceStable(items, func(i, j int) bool {
				if items[i].Title != items[j].Title {
					return items[i].Title < items[j].Title
				}
				return items[i].Slug < items[j].Slug
			})
		}
		out.Total = len(items)
		start := min(q.Offset, len(items))
		end := min(start+q.Limit, len(items))
		out.Items = items[start:end]
		if end < len(items) {
			next := strconv.Itoa(end)
			out.NextCursor = &next
		}
		return nil
	})
	return out, err
}
func (s *Service) Home(ctx context.Context) (Home, error) {
	out := Home{Items: []PublicBook{}, Categories: []string{}}
	err := s.publicState(ctx, func(st state) error {
		all := publicBooks(st)
		out.Total = len(all)
		out.Items = all[:min(30, len(all))]
		seen := map[string]bool{}
		for _, b := range all {
			for _, category := range categories(b) {
				if !seen[category] {
					seen[category] = true
					out.Categories = append(out.Categories, category)
				}
			}
		}
		sort.Strings(out.Categories)
		if len(all) > 0 {
			b := all[0]
			out.Featured = &b
			p, _ := findPublic(st, b.Slug)
			chapters := current(p).Chapters
			if len(chapters) > 0 {
				runes := []rune(chapters[0].Markdown)
				opening := string(runes[:min(500, len(runes))])
				out.Opening = &opening
			}
		}
		return nil
	})
	return out, err
}
func (s *Service) PublicBook(ctx context.Context, slug string) (PublicBook, error) {
	var out PublicBook
	err := s.publicState(ctx, func(st state) error {
		p, err := findPublic(st, slug)
		if err == nil {
			out = publicBook(p)
		}
		return err
	})
	return out, err
}
func (s *Service) Chapter(ctx context.Context, bookSlug, chapterSlug string) (PublicChapter, error) {
	var out PublicChapter
	err := s.publicState(ctx, func(st state) error {
		p, err := findPublic(st, bookSlug)
		if err != nil {
			return err
		}
		chapters := current(p).Chapters
		for i, c := range chapters {
			if c.Slug == chapterSlug {
				out = PublicChapter{PublicChapterRef: publicRef(p, c), BookSlug: bookSlug, Markdown: c.Markdown}
				if i > 0 {
					slug := chapters[i-1].Slug
					out.Previous = &slug
				}
				if i+1 < len(chapters) {
					slug := chapters[i+1].Slug
					out.Next = &slug
				}
				return nil
			}
		}
		return fail(404, "NOT_FOUND", "Public chapter not found.")
	})
	return out, err
}
func (s *Service) Author(ctx context.Context, slug string) (PublicAuthor, error) {
	out := PublicAuthor{Books: []PublicBook{}}
	err := s.publicState(ctx, func(st state) error {
		for _, b := range publicBooks(st) {
			if b.AuthorSlug == slug {
				if len(out.Books) == 0 {
					p, _ := findPublic(st, b.Slug)
					out.Slug = slug
					out.PenName = b.PenName
					out.Bio = current(p).Metadata.AuthorBio
				}
				out.Books = append(out.Books, b)
			}
		}
		if len(out.Books) == 0 {
			return fail(404, "NOT_FOUND", "Public author not found.")
		}
		return nil
	})
	return out, err
}
func (s *Service) Categories(ctx context.Context) ([]string, error) {
	home, err := s.Home(ctx)
	return home.Categories, err
}

func categories(b PublicBook) []string {
	if len(b.Categories) > 0 {
		return b.Categories
	}
	return []string{b.Category}
}
func hasCategory(b PublicBook, category string) bool {
	for _, c := range categories(b) {
		if c == category {
			return true
		}
	}
	return false
}
