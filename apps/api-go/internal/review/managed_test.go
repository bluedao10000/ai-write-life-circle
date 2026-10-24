package review

import (
	"context"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"os"
	"strings"
	"testing"
)

func TestManagedMetadataChangesStaleEvidenceWithoutChangingProse(t *testing.T) {
	ctx := context.Background()
	a := application.Actor{ID: "synthetic-author", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, a.ID)
	b, e := m.Mutate(ctx, a, "", "create", application.StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	app, _ := m.Resolve(a, b.ID)
	c, _ := app.Source(b.Chapters[0].ID)
	h, _ := app.Head(ctx, c)
	s := &Service{App: app}
	run := Run{Sources: []Source{source(b.ID, c, h, "target")}}
	if s.freshen(ctx, run).Stale {
		t.Fatal("new source stale")
	}
	b, e = m.Mutate(ctx, a, b.ID, "rename", application.StructureInput{Operation: "rename", BaseVersion: b.Version, Title: "New title"})
	if e != nil {
		t.Fatal(e)
	}
	fresh := s.freshen(ctx, run)
	if !fresh.Stale || fresh.Sources[0].Freshness != "changed" {
		t.Fatal(fresh)
	}
	next, _ := app.Source(c.ID)
	head, e := app.Head(ctx, next)
	if e != nil || head.ID != h.ID {
		t.Fatal("false prose conflict", e)
	}
}

func TestManagedHistoricalRankingUsesSavedRevisionBodies(t *testing.T) {
	ctx := context.Background()
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, testAuthor.ID)
	b, err := m.Mutate(ctx, testAuthor, "", "bootstrap", application.StructureInput{Operation: "create"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 2; i <= 22; i++ {
		b, err = m.Mutate(ctx, testAuthor, b.ID, fmt.Sprintf("chapter-%d", i), application.StructureInput{Operation: "chapter", BaseVersion: b.Version, Title: fmt.Sprintf("章节%02d", i)})
		if err != nil {
			t.Fatal(err)
		}
	}
	app, err := m.Resolve(testAuthor, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	targetText := "林舟三月三日在北港寻找失踪的父亲。"
	heads := map[string]application.StoredRevision{}
	for i, chapter := range b.Chapters {
		c, err := app.Source(chapter.ID)
		if err != nil {
			t.Fatal(err)
		}
		if c.Markdown != "" {
			t.Fatal("test requires empty managed source envelopes")
		}
		h, err := app.Head(ctx, c)
		if err != nil {
			t.Fatal(err)
		}
		body := "石头静静躺在远方荒野。"
		if i+1 == 3 {
			body = "林舟出生于北港，父亲在三月三日失踪。"
		}
		if i+1 >= 20 {
			body = targetText
		}
		key := fmt.Sprintf("saved-%d", i)
		if _, err = app.Save(ctx, testAuthor, c.ID, "fixture", map[string]any{"baseRevisionId": h.ID, "markdown": body}, &key); err != nil {
			t.Fatal(err)
		}
		heads[c.ID], err = app.ReviewRevision(ctx, c)
		if err != nil {
			t.Fatal(err)
		}
	}
	service, model := testService(t, nil)
	service.App = app
	target := heads["CH-000021"]
	plan, err := service.BuildPlan(ctx, "CH-000021", Input{target.ID, target.Hash, []string{"character_consistency"}})
	if err != nil {
		t.Fatal(err)
	}
	historical := []Source{}
	for _, src := range plan.Sources {
		if src.Kind == "historical_chapter" {
			historical = append(historical, src)
		}
	}
	if len(historical) != 4 || historical[0].SourceID != "chapter:CH-000020" {
		t.Fatal(historical)
	}
	found := false
	for _, src := range historical {
		if src.SourceID == "chapter:CH-000022" {
			t.Fatal("future chapter selected")
		}
		if src.SourceID == "chapter:CH-000003" {
			found = true
			if src.RevisionID == nil || *src.RevisionID != heads["CH-000003"].ID || !strings.Contains(src.Excerpt, "父亲") {
				t.Fatal(src)
			}
		}
	}
	if !found {
		t.Fatal("saved evidence in chapter 3 lost behind recent generic headings")
	}
	if model.calls.Load() != 0 {
		t.Fatal("context selection invoked a model")
	}
}

func TestHistoricalCandidateBudgetRetainsRecentAndOlderCoverage(t *testing.T) {
	chapters := make([]application.Chapter, 1000)
	for i := range chapters {
		chapters[i].ID = fmt.Sprint(i)
	}
	selected := historicalCandidates(chapters)
	if len(selected) != maxHistoricalCandidates || selected[0].ID != "0" || selected[len(selected)-1].ID != "999" {
		t.Fatal(selected)
	}
	seen := map[string]bool{}
	for _, c := range selected {
		if seen[c.ID] {
			t.Fatal("repeated candidate")
		}
		seen[c.ID] = true
	}
	for i := 968; i < 1000; i++ {
		if !seen[fmt.Sprint(i)] {
			t.Fatal("recent chapter omitted", i)
		}
	}
	if len(historicalCandidates(chapters[:22])) != 22 {
		t.Fatal("small book should use every preceding chapter")
	}
}

func TestDeletedManagedBookRejectsLateReviewCommit(t *testing.T) {
	ctx := context.Background()
	actor := application.Actor{ID: "author", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, actor.ID)
	b, err := m.Mutate(ctx, actor, "", "create", application.StructureInput{Operation: "create"})
	if err != nil {
		t.Fatal(err)
	}
	app, err := m.Resolve(actor, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	service := New(app, llm.Config{}, nil)
	defer service.Close()
	if _, err := m.Delete(ctx, actor, b.ID, "delete", application.DeleteBookInput{BaseVersion: b.Version}); err != nil {
		t.Fatal(err)
	}
	if err := service.transaction(ctx, func(st *state) (bool, error) { return true, nil }); err == nil {
		t.Fatal("late review commit accepted")
	}
	if _, err := os.Stat(service.path()); !os.IsNotExist(err) {
		t.Fatal("review state recreated", err)
	}
}
