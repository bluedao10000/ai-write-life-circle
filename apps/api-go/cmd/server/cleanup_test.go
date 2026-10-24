package main

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/publication"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/thinking"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPublicationPurgeSurvivesThinkingCleanupFailure(t *testing.T) {
	for _, mode := range []string{"corrupt", "locked"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			a := application.Actor{ID: "author-a", Role: "author"}
			p := publication.New(dir, nil)
			// This listed snapshot represents the relist that passed the deletion guard
			// just before managed visibility committed its tombstone.
			pub := publication.Publication{ID: "pub-a", BookID: "book-a", OwnerID: a.ID, AuthorSlug: "author-a", Current: "version-a", ChapterSlugs: map[string]string{}, Versions: []publication.Version{{ID: "version-a", PublicationID: "pub-a", Number: 1, State: "listed", CreatedAt: compat.Now(), Metadata: publication.Metadata{Slug: "cleanup-fixture", Title: "合成作品", PenName: "作者", Tagline: "简介", Description: "简介", Category: "小说", SerialStatus: "ongoing"}, Chapters: []publication.Snapshot{{Selection: publication.Selection{ChapterID: "CH-001", RevisionID: "rev-a", ContentHash: compat.Hash("正文")}, Slug: "first", Title: "第一章", VolumeOrder: 1, Markdown: "正文"}}}}}
			if e := storage.Write(context.Background(), filepath.Join(dir, "publications/state-v1.json"), map[string]any{"schema": 1, "publications": map[string]publication.Publication{"book-a": pub}, "previews": map[string]any{}, "requests": map[string]any{}, "authorSlugs": map[string]string{a.ID: "author-a"}, "audit": []any{}}); e != nil {
				t.Fatal(e)
			}
			if _, e := p.PublicBook(context.Background(), "cleanup-fixture"); e != nil {
				t.Fatal(e)
			}
			if e := os.MkdirAll(filepath.Join(dir, "thinking"), 0700); e != nil {
				t.Fatal(e)
			}
			path := filepath.Join(dir, "thinking/sessions-v1.json")
			data := []byte("corrupt")
			if mode == "locked" {
				path += ".lock"
				data = []byte("held")
			}
			if e := os.WriteFile(path, data, 0600); e != nil {
				t.Fatal(e)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer cancel()
			if e := cleanupOwnedBook(ctx, a, "book-a", p, &thinking.Service{State: dir}); e == nil {
				t.Fatal("Thinking error must retain managed cleanup retry marker")
			}
			if _, e := p.PublicBook(context.Background(), "cleanup-fixture"); application.AsError(e).Status != 404 {
				t.Fatal("publication survived private cleanup failure", e)
			}
		})
	}
}
