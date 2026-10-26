package application

import (
	"context"
	"testing"
)

type limitMeter struct{ plan Entitlements }

func (limitMeter) Allow(context.Context, string, string) error                { return nil }
func (limitMeter) Reserve(context.Context, string, string, string, int) error { return nil }
func (limitMeter) Authorize(context.Context, string, string, string) error    { return nil }
func (limitMeter) Settle(context.Context, string, string, int) error          { return nil }
func (m limitMeter) Entitlements(context.Context, string) (Entitlements, error) {
	return m.plan, nil
}

func limitCode(e error) string {
	if e == nil {
		return ""
	}
	return AsError(e).Code
}

func TestPlanBookLimitBlocksOnlyNewBooks(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	m.UseMeter(limitMeter{Entitlements{Books: 2}})
	first, e := m.Mutate(ctx, managedAuthor, "", "create-1", StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e := m.Mutate(ctx, managedAuthor, "", "create-2", StructureInput{Operation: "create"}); e != nil {
		t.Fatal(e)
	}
	_, e = m.Mutate(ctx, managedAuthor, "", "create-3", StructureInput{Operation: "create"})
	if limitCode(e) != "PLAN_LIMIT_REACHED" || AsError(e).Status != 402 {
		t.Fatal("third book allowed on a two-book plan", e)
	}
	// Replays and edits of existing books still work at the limit.
	if again, e := m.Mutate(ctx, managedAuthor, "", "create-1", StructureInput{Operation: "create"}); e != nil || again.ID != first.ID {
		t.Fatal("replay blocked", e)
	}
	if _, e := m.Mutate(ctx, managedAuthor, first.ID, "rename", StructureInput{Operation: "rename", BaseVersion: first.Version, Title: "新名"}); e != nil {
		t.Fatal("editing blocked at the limit", e)
	}
	// Another author has their own count.
	other := Actor{ID: "other-author", Role: "author"}
	if _, e := m.Mutate(ctx, other, "", "create-1", StructureInput{Operation: "create"}); e != nil {
		t.Fatal(e)
	}
	if books, imports, e := m.Counts(managedAuthor); e != nil || books != 2 || imports != 0 {
		t.Fatal(books, imports, e)
	}
}

func commitInput(p ImportPreview) ImportCommitInput {
	in := ImportCommitInput{Fingerprint: p.Fingerprint, Title: p.Title, Volumes: p.Volumes}
	for _, c := range p.Chapters {
		in.Chapters = append(in.Chapters, ImportChapterRef{ChapterID: c.ChapterID, Title: c.Title, VolumeID: c.VolumeID})
	}
	return in
}

func TestPlanImportLimitIsEnforcedAtCommit(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	m.UseMeter(limitMeter{Entitlements{Books: 10, ImportsPerMonth: 1}})
	imports := NewImportService(m)
	a, e := imports.Stage(ctx, managedAuthor, "upload-a", "a.epub", importEPUBFixture(t))
	if e != nil {
		t.Fatal(e)
	}
	b, e := imports.Stage(ctx, managedAuthor, "upload-b", "b.epub", importEPUBWithChapters(t, 3))
	if e != nil {
		t.Fatal(e)
	}
	if _, e := imports.Commit(ctx, managedAuthor, a.Preview.ImportID, "commit-a", commitInput(a.Preview)); e != nil {
		t.Fatal(e)
	}
	// Both were staged before the first commit; the second commit is refused.
	_, e = imports.Commit(ctx, managedAuthor, b.Preview.ImportID, "commit-b", commitInput(b.Preview))
	if limitCode(e) != "PLAN_LIMIT_REACHED" {
		t.Fatal("second import committed on a one-import plan", e)
	}
	if books, _ := m.List(managedAuthor); len(books) != 1 {
		t.Fatal("refused import left a book", len(books))
	}
	// The committed import replays; a new upload is refused up front.
	if _, e := imports.Commit(ctx, managedAuthor, a.Preview.ImportID, "commit-a", commitInput(a.Preview)); e != nil {
		t.Fatal("replay blocked", e)
	}
	if _, e := imports.Stage(ctx, managedAuthor, "upload-c", "c.epub", importEPUBFixture(t)); limitCode(e) != "PLAN_LIMIT_REACHED" {
		t.Fatal("stage not refused", e)
	}
	if _, n, _ := m.Counts(managedAuthor); n != 1 {
		t.Fatal("imports this month", n)
	}
}
