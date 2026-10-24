package publication

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

var author = application.Actor{ID: "writer-a", Role: "author"}

func fixture(t *testing.T) (*Service, *application.Service) {
	t.Helper()
	root := t.TempDir()
	if e := os.MkdirAll(filepath.Join(root, "manuscript"), 0700); e != nil {
		t.Fatal(e)
	}
	for i := 1; i <= 3; i++ {
		volume, order := "vol-one", i
		if i == 3 {
			volume = "vol-two"
			order = 1
		}
		text := fmt.Sprintf("# Chapter %d\nID: CH-%03d\nvolumeId: %s\norder: %d\n\nSaved prose %d.\n", i, i, volume, order, i)
		if e := os.WriteFile(filepath.Join(root, fmt.Sprintf("manuscript/CH-%03d.md", i)), []byte(text), 0600); e != nil {
			t.Fatal(e)
		}
	}
	app := &application.Service{Root: root, State: t.TempDir(), Project: "book-a"}
	s := New(t.TempDir(), map[string]Book{"book-a": {app, author.ID}})
	return s, app
}
func input(t *testing.T, app *application.Service, ids ...string) PreviewInput {
	t.Helper()
	in := PreviewInput{Metadata: Metadata{Slug: "book-a", Title: "Public title", PenName: "Pen", Tagline: "Public tagline", Description: "Public description", Category: "科幻", SerialStatus: "ongoing"}, Chapters: []Selection{}}
	for _, id := range ids {
		c, e := app.Source(id)
		if e != nil {
			t.Fatal(e)
		}
		h, e := app.Head(context.Background(), c)
		if e != nil {
			t.Fatal(e)
		}
		order := int64(0)
		if c.Order != nil {
			order = *c.Order
		}
		in.Chapters = append(in.Chapters, Selection{id, h.ID, h.Hash, c.VolumeID, order})
	}
	return in
}
func publish(t *testing.T, s *Service, in PreviewInput, key string) Version {
	t.Helper()
	p, e := s.Preview(context.Background(), author, "book-a", in)
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.Publish(context.Background(), author, "book-a", key, CommitInput{BaseVersionID: in.BaseVersionID, PreviewID: p.ID})
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func expectCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || application.AsError(err).Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func TestPublicationLifecycleAndPrivateIsolation(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	home, e := s.Home(ctx)
	if e != nil || home.Total != 0 || home.Featured != nil || len(home.Items) != 0 {
		t.Fatal(home, e)
	}
	in := input(t, app, "CH-001")
	v1 := publish(t, s, in, "first")
	book, e := s.PublicBook(ctx, "book-a")
	if e != nil || len(book.Chapters) != 1 {
		t.Fatal(book, e)
	}
	slug := book.Chapters[0].Slug
	public, e := s.Chapter(ctx, "book-a", slug)
	if e != nil || public.Markdown != "Saved prose 1.\n" {
		t.Fatal(public, e)
	}
	for _, secretSlug := range []string{"CH-002", "CH-003", "chapter-2"} {
		_, e = s.Chapter(ctx, "book-a", secretSlug)
		expectCode(t, e, "NOT_FOUND")
	}
	c, _ := app.Source("CH-001")
	head, _ := app.Head(ctx, c)
	_, e = app.Save(ctx, author, c.ID, "save", map[string]any{"baseRevisionId": head.ID, "markdown": "New private draft"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	old, _ := s.Chapter(ctx, "book-a", slug)
	if old.Markdown != public.Markdown {
		t.Fatal("draft leaked")
	}
	management, e := s.Manage(ctx, author, "book-a")
	if e != nil || !reflect.DeepEqual(management.ChangedChapterIDs, []string{"CH-001"}) {
		t.Fatal(management, e)
	}
	updated := input(t, app, "CH-001", "CH-002")
	updated.BaseVersionID = &v1.ID
	v2 := publish(t, s, updated, "update")
	if v2.Number != 2 || v2.ID == v1.ID {
		t.Fatal(v2)
	}
	fresh, _ := s.Chapter(ctx, "book-a", slug)
	if fresh.Markdown != "New private draft" || fresh.Next == nil {
		t.Fatal(fresh)
	}
	management, _ = s.Manage(ctx, author, "book-a")
	history, err := s.History(ctx, author, "book-a")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(history[0], v1) {
		t.Fatal("immutable history changed")
	}
	// Remove chapter 1 by committing a newly previewed exact set.
	withdrawn := input(t, app, "CH-002")
	withdrawn.BaseVersionID = &v2.ID
	v3 := publish(t, s, withdrawn, "withdraw")
	_, e = s.Chapter(ctx, "book-a", slug)
	expectCode(t, e, "NOT_FOUND")
	v4, e := s.Transition(ctx, author, "book-a", "unlist", "unlist", TransitionInput{&v3.ID})
	if e != nil {
		t.Fatal(e)
	}
	home, _ = s.Home(ctx)
	if home.Total != 0 {
		t.Fatal("unlisted in home")
	}
	_, e = s.PublicBook(ctx, "book-a")
	expectCode(t, e, "NOT_FOUND")
	_, e = s.Author(ctx, book.AuthorSlug)
	expectCode(t, e, "NOT_FOUND")
	_, e = s.Transition(ctx, author, "book-a", "relist", "relist", TransitionInput{&v4.ID})
	if e != nil {
		t.Fatal(e)
	}
	home, _ = s.Home(ctx)
	if home.Total != 1 {
		t.Fatal(home)
	}
	// Public JSON uses only public DTOs, including author and reading navigation.
	outputs := []any{home}
	catalog, _ := s.Catalog(ctx, Query{Limit: 24})
	outputs = append(outputs, catalog)
	authorPage, _ := s.Author(ctx, book.AuthorSlug)
	outputs = append(outputs, authorPage)
	book, _ = s.PublicBook(ctx, "book-a")
	chapter, _ := s.Chapter(ctx, "book-a", book.Chapters[0].Slug)
	outputs = append(outputs, book, chapter)
	data, _ := json.Marshal(outputs)
	for _, private := range []string{"sourceRevisionId", "revisionId", "contentHash", "ownerUserId", "createdBy", "auditReference", "writer-a", "CH-001", "CH-002", "CH-003", "New private draft"} {
		if strings.Contains(string(data), private) {
			t.Fatalf("public response leaked %q", private)
		}
	}
}
func TestPreviewConflictIdempotencyAndAtomicFailure(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	in := input(t, app, "CH-001")
	p, e := s.Preview(ctx, author, "book-a", in)
	if e != nil {
		t.Fatal(e)
	}
	c, _ := app.Source("CH-001")
	h, _ := app.Head(ctx, c)
	_, e = app.Save(ctx, author, c.ID, "save", map[string]any{"baseRevisionId": h.ID, "markdown": "Edited after preview"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.Publish(ctx, author, "book-a", "stale", CommitInput{BaseVersionID: nil, PreviewID: p.ID})
	expectCode(t, e, "PUBLICATION_REVISION_CONFLICT")
	home, _ := s.Home(ctx)
	if home.Total != 0 {
		t.Fatal(home)
	}
	p, e = s.Preview(ctx, author, "book-a", input(t, app, "CH-001"))
	if e != nil {
		t.Fatal(e)
	}
	commit := CommitInput{BaseVersionID: nil, PreviewID: p.ID}
	before, _ := os.ReadFile(s.path())
	write := s.write
	s.write = func(context.Context, string, any) error { return errors.New("disk full") }
	_, e = s.Publish(ctx, author, "book-a", "retry", commit)
	expectCode(t, e, "PUBLICATION_STORAGE_FAILED")
	after, _ := os.ReadFile(s.path())
	if string(before) != string(after) {
		t.Fatal("partial commit")
	}
	s.write = write
	v, e := s.Publish(ctx, author, "book-a", "retry", commit)
	if e != nil {
		t.Fatal(e)
	}
	// Restart and same-key replay survive changed current state/preview expiry.
	restarted := New(s.StateDir, s.Books)
	replay, e := restarted.Publish(ctx, author, "book-a", "retry", commit)
	if e != nil || !reflect.DeepEqual(v, replay) {
		t.Fatal(replay, e)
	}
	_, e = s.Publish(ctx, author, "book-a", "retry", CommitInput{BaseVersionID: &v.ID, PreviewID: p.ID})
	expectCode(t, e, "IDEMPOTENCY_KEY_REUSED")
	second := input(t, app, "CH-001")
	second.BaseVersionID = &v.ID
	p2, e := s.Preview(ctx, author, "book-a", second)
	if e != nil {
		t.Fatal(e)
	}
	s.write = func(context.Context, string, any) error { return errors.New("disk full") }
	_, e = s.Publish(ctx, author, "book-a", "failure-two", CommitInput{BaseVersionID: &v.ID, PreviewID: p2.ID})
	expectCode(t, e, "PUBLICATION_STORAGE_FAILED")
	still, _ := s.Manage(ctx, author, "book-a")
	if still.Publication.Current != v.ID || len(still.Publication.Versions) != 1 {
		t.Fatal("old version changed")
	}
	s.write = write
	_, e = s.Publish(ctx, author, "book-a", "retry", commit)
	if e != nil {
		t.Fatal(e)
	}
	st, _ := s.load()
	if len(st.Audit) != 1 || len(st.Requests) != 1 {
		t.Fatal("duplicate commit/audit")
	}
}
func TestOwnershipMultiBookSlugAndVolumeOrder(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	s.Books["book-b"] = Book{app, "writer-b"}
	s.Books["book-c"] = Book{app, author.ID}
	for _, a := range []application.Actor{{ID: author.ID, Role: "agent"}, {ID: "writer-b", Role: "author"}, {ID: "", Role: "author"}} {
		_, e := s.Preview(ctx, a, "book-a", input(t, app, "CH-001"))
		if e == nil {
			t.Fatal("unauthorized preview")
		}
		_, e = s.Publish(ctx, a, "book-a", "forbidden", CommitInput{})
		if e == nil {
			t.Fatal("unauthorized publish")
		}
		_, e = s.Manage(ctx, a, "book-a")
		if e == nil {
			t.Fatal("unauthorized history")
		}
	}
	v := publish(t, s, input(t, app, "CH-003", "CH-001", "CH-002"), "ordered")
	ids := []string{}
	for _, c := range v.Chapters {
		ids = append(ids, c.ChapterID)
	}
	if !reflect.DeepEqual(ids, []string{"CH-001", "CH-002", "CH-003"}) || v.Chapters[2].VolumeOrder != 2 || v.Chapters[2].ChapterOrder != 1 {
		t.Fatal(v.Chapters)
	}
	book, _ := s.PublicBook(ctx, "book-a")
	first, _ := s.Chapter(ctx, book.Slug, book.Chapters[1].Slug)
	if first.Next == nil || *first.Next != book.Chapters[2].Slug {
		t.Fatal("wrong cross-volume next")
	}
	in := input(t, app, "CH-001")
	_, e := s.Preview(ctx, application.Actor{ID: "writer-b", Role: "author"}, "book-b", in)
	expectCode(t, e, "PUBLIC_SLUG_TAKEN")
	in.Metadata.Slug = "book-c"
	p, e := s.Preview(ctx, author, "book-c", in)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.Publish(ctx, author, "book-c", "book-c", CommitInput{BaseVersionID: nil, PreviewID: p.ID})
	if e != nil {
		t.Fatal(e)
	}
	home, _ := s.Home(ctx)
	if home.Total != 2 {
		t.Fatal(home)
	}
	management, _ := s.Manage(ctx, author, "book-c")
	if len(management.Publication.Versions) != 1 || management.Publication.ID == v.PublicationID {
		t.Fatal("shared publication")
	}
	authorPage, _ := s.Author(ctx, book.AuthorSlug)
	if len(authorPage.Books) != 2 {
		t.Fatal(authorPage)
	}
	catalog, e := s.Catalog(ctx, Query{Limit: 1})
	if e != nil || catalog.Total != 2 || catalog.NextCursor == nil {
		t.Fatal(catalog, e)
	}
	catalog, e = s.Catalog(ctx, Query{Limit: 20, Search: "no-matching-public-title"})
	if e != nil || catalog.Total != 0 {
		t.Fatal(catalog, e)
	}
}
func TestPublishHoldsDraftLocksThroughCommit(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	p, e := s.Preview(ctx, author, "book-a", input(t, app, "CH-001"))
	if e != nil {
		t.Fatal(e)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	s.write = func(ctx context.Context, path string, v any) error {
		close(entered)
		<-release
		return storage.Write(ctx, path, v)
	}
	published := make(chan error, 1)
	go func() {
		_, e := s.Publish(ctx, author, "book-a", "locked", CommitInput{BaseVersionID: nil, PreviewID: p.ID})
		published <- e
	}()
	<-entered
	c, _ := app.Source("CH-001")
	saved := make(chan error, 1)
	go func() {
		_, e := app.Save(ctx, author, c.ID, "parallel-save", map[string]any{"baseRevisionId": p.Chapters[0].RevisionID, "markdown": "Later draft"}, nil)
		saved <- e
	}()
	select {
	case err := <-saved:
		close(release)
		t.Fatalf("save raced publication commit: %v", err)
	case <-time.After(80 * time.Millisecond):
	}
	close(release)
	if e := <-published; e != nil {
		t.Fatal(e)
	}
	if e := <-saved; e != nil {
		t.Fatal(e)
	}
	book, _ := s.PublicBook(ctx, "book-a")
	chapter, _ := s.Chapter(ctx, book.Slug, book.Chapters[0].Slug)
	if chapter.Markdown != "Saved prose 1.\n" {
		t.Fatal(chapter)
	}
}
func TestConcurrentPublishingAndNoEmptySnapshots(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	in := input(t, app, "CH-001")
	p, e := s.Preview(ctx, author, "book-a", in)
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, key := range []string{"one", "two"} {
		wg.Add(1)
		go func(k string) {
			defer wg.Done()
			_, e := s.Publish(ctx, author, "book-a", k, CommitInput{BaseVersionID: nil, PreviewID: p.ID})
			results <- e
		}(key)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if application.AsError(e).Code == "PUBLICATION_VERSION_CONFLICT" {
			conflict++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal(success, conflict)
	}
	s2, app2 := fixture(t)
	bad := input(t, app2, "CH-001")
	bad.Chapters = append(bad.Chapters, bad.Chapters[0])
	_, e = s2.Preview(ctx, author, "book-a", bad)
	expectCode(t, e, "VALIDATION_FAILED")
	c, _ := app2.Source("CH-001")
	h, _ := app2.Head(ctx, c)
	_, e = app2.Save(ctx, author, c.ID, "empty", map[string]any{"baseRevisionId": h.ID, "markdown": "   \n"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s2.Preview(ctx, author, "book-a", input(t, app2, "CH-001"))
	expectCode(t, e, "EMPTY_CHAPTER")
}

func TestHarnessMetadataAndOrderingInvalidatePreview(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	in := input(t, app, "CH-001", "CH-003")
	p, e := s.Preview(ctx, author, "book-a", in)
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(app.Root, "manuscript/CH-001.md")
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(path, []byte(strings.Replace(string(b), "# Chapter 1", "# Changed title", 1)), 0600); e != nil {
		t.Fatal(e)
	}
	_, e = s.Publish(ctx, author, "book-a", "metadata-conflict", CommitInput{BaseVersionID: nil, PreviewID: p.ID})
	expectCode(t, e, "PUBLICATION_REVISION_CONFLICT")
}
func TestExpiredPreviewAndStrictInput(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	p, e := s.Preview(ctx, author, "book-a", input(t, app, "CH-001"))
	if e != nil {
		t.Fatal(e)
	}
	if e = s.transaction(ctx, func(st *state) (bool, error) {
		preview := st.Previews[p.ID]
		preview.ExpiresAt = time.Now().Add(-time.Minute).Format(time.RFC3339Nano)
		st.Previews[p.ID] = preview
		return true, nil
	}); e != nil {
		t.Fatal(e)
	}
	_, e = s.Publish(ctx, author, "book-a", "expired", CommitInput{BaseVersionID: nil, PreviewID: p.ID})
	expectCode(t, e, "PREVIEW_EXPIRED")
	for _, data := range []string{`null`, `{"previewId":"x","markdown":"untrusted"}`, `{"previewId":"x"} {}`, `[]`, `{"previewId":1}`} {
		var v CommitInput
		if DecodeInput([]byte(data), &v) == nil {
			t.Fatal("invalid payload accepted", data)
		}
	}
	in := input(t, app, "CH-001")
	in.Metadata.CoverURL = "javascript:alert(1)"
	_, e = s.Preview(ctx, author, "book-a", in)
	expectCode(t, e, "VALIDATION_FAILED")
	in = input(t, app, "CH-001")
	in.Metadata.Slug = "../private"
	_, e = s.Preview(ctx, author, "book-a", in)
	expectCode(t, e, "VALIDATION_FAILED")
}

func TestWithdrawLastChapterIsAtomicNewVersion(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	empty := input(t, app)
	_, e := s.Preview(ctx, author, "book-a", empty)
	expectCode(t, e, "EMPTY_PUBLICATION")
	first := publish(t, s, input(t, app, "CH-001"), "first")
	empty.BaseVersionID = &first.ID
	p, e := s.Preview(ctx, author, "book-a", empty)
	if e != nil {
		t.Fatal(e)
	}
	withdrawn, e := s.Publish(ctx, author, "book-a", "withdraw-last", CommitInput{BaseVersionID: &first.ID, PreviewID: p.ID})
	if e != nil || withdrawn.State != "unlisted" || len(withdrawn.Chapters) != 0 {
		t.Fatal(withdrawn, e)
	}
	_, e = s.PublicBook(ctx, "book-a")
	expectCode(t, e, "NOT_FOUND")
	_, e = s.Transition(ctx, author, "book-a", "relist-empty", "relist", TransitionInput{&withdrawn.ID})
	expectCode(t, e, "EMPTY_PUBLICATION")
	management, e := s.Manage(ctx, author, "book-a")
	if e != nil || len(management.Publication.Versions) != 2 || len(management.Publication.Versions[0].Chapters) != 1 {
		t.Fatal(management, e)
	}
}

func TestManagementSummariesExcludeAllProse(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	for i := 4; i <= 300; i++ {
		text := fmt.Sprintf("# Long novel %d\nID: CH-%03d\nvolumeId: vol-two\norder: %d\n\nDO_NOT_TRANSFER_DRAFT_%d\n", i, i, i, i)
		if err := os.WriteFile(filepath.Join(app.Root, "manuscript", fmt.Sprintf("CH-%03d.md", i)), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	initial, e := s.Manage(ctx, author, "book-a")
	if e != nil || len(initial.Drafts) != 300 {
		t.Fatal(len(initial.Drafts), e)
	}
	if initial.Drafts[0].IsEmpty || initial.Drafts[0].Words == 0 || initial.Drafts[0].RevisionID == "" {
		t.Fatal(initial.Drafts[0])
	}
	v := publish(t, s, input(t, app, "CH-001"), "first")
	in := input(t, app, "CH-001", "CH-002")
	in.BaseVersionID = &v.ID
	preview, e := s.Preview(ctx, author, "book-a", in)
	if e != nil || len(preview.PreviousChapters) != 1 || preview.PreviousChapters[0].Markdown != "Saved prose 1.\n" {
		t.Fatal(preview, e)
	}
	frozen, e := s.load()
	if e != nil || len(frozen.Previews[preview.ID].PreviousChapters) != 0 {
		t.Fatal("comparison prose must not enlarge stored previews", e)
	}
	managed, e := s.Manage(ctx, author, "book-a")
	if e != nil {
		t.Fatal(e)
	}
	data, e := json.Marshal(managed)
	if e != nil {
		t.Fatal(e)
	}
	for _, secret := range []string{"markdown", "Saved prose", "DO_NOT_TRANSFER"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("management included prose: %s", secret)
		}
	}
	if len(data) > 300*1200 {
		t.Fatalf("summary response grew unexpectedly: %d", len(data))
	}
	history, e := s.History(ctx, author, "book-a")
	if e != nil || history[0].Chapters[0].Markdown != "Saved prose 1.\n" {
		t.Fatal(history, e)
	}
}

func TestRelistDoesNotPromoteUnchangedContent(t *testing.T) {
	s, app := fixture(t)
	ctx := context.Background()
	v := publish(t, s, input(t, app, "CH-001"), "first")
	before, e := s.PublicBook(ctx, "book-a")
	if e != nil {
		t.Fatal(e)
	}
	down, e := s.Transition(ctx, author, "book-a", "down", "unlist", TransitionInput{BaseVersionID: &v.ID})
	if e != nil {
		t.Fatal(e)
	}
	up, e := s.Transition(ctx, author, "book-a", "up", "relist", TransitionInput{BaseVersionID: &down.ID})
	if e != nil {
		t.Fatal(e)
	}
	after, e := s.PublicBook(ctx, "book-a")
	if e != nil {
		t.Fatal(e)
	}
	if after.UpdatedAt != before.UpdatedAt || after.ContentUpdatedAt != before.ContentUpdatedAt || after.PublicationUpdatedAt != up.CreatedAt {
		t.Fatal(before, after)
	}
	other := Publication{AuthorSlug: "other", Versions: []Version{v}}
	other.Versions[0].Metadata.Slug = "newer-book"
	other.Versions[0].CreatedAt = up.CreatedAt
	st, e := s.load()
	if e != nil {
		t.Fatal(e)
	}
	st.Publications["newer-book"] = other
	books := publicBooks(st)
	if len(books) != 2 || books[0].Slug != "newer-book" {
		t.Fatal(books)
	}
	same := input(t, app, "CH-001")
	same.BaseVersionID = &up.ID
	preview, e := s.Preview(ctx, author, "book-a", same)
	if e != nil {
		t.Fatal(e)
	}
	noteVersion, e := s.Publish(ctx, author, "book-a", "note-only", CommitInput{BaseVersionID: &up.ID, PreviewID: preview.ID, Note: "private note only"})
	if e != nil {
		t.Fatal(e)
	}
	unchanged, e := s.PublicBook(ctx, "book-a")
	if e != nil || unchanged.UpdatedAt != before.UpdatedAt || unchanged.PublicationUpdatedAt != noteVersion.CreatedAt {
		t.Fatal(unchanged, e)
	}
	in := input(t, app, "CH-001")
	in.BaseVersionID = &noteVersion.ID
	in.Metadata.Tagline = "Actually changed public information"
	updated := publish(t, s, in, "metadata-change")
	book, e := s.PublicBook(ctx, "book-a")
	if e != nil || book.ContentUpdatedAt != updated.CreatedAt || book.UpdatedAt == before.UpdatedAt {
		t.Fatal(book, e)
	}
}

func TestManagedArchivePreservesPublishedSnapshot(t *testing.T) {
	ctx := context.Background()
	legacy := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	manager := application.NewManagement(legacy, author.ID)
	book, err := manager.Mutate(ctx, author, "", "bootstrap", application.StructureInput{Operation: "create"})
	if err != nil {
		t.Fatal(err)
	}
	app, err := manager.Resolve(author, book.ID)
	if err != nil {
		t.Fatal(err)
	}
	c, err := app.Source(book.Chapters[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	h, err := app.Head(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	key := "prose"
	_, err = app.Save(ctx, author, c.ID, "synthetic", map[string]any{"baseRevisionId": h.ID, "markdown": "Synthetic published prose retained after archive."}, &key)
	if err != nil {
		t.Fatal(err)
	}
	service := New(legacy.State, nil)
	service.ResolveBook = func(a application.Actor, id string) (Book, error) {
		s, e := manager.Resolve(a, id)
		return Book{App: s, OwnerID: a.ID}, e
	}
	in := input(t, app, c.ID)
	in.Metadata.Slug = "managed-synthetic"
	preview, err := service.Preview(ctx, author, book.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	version, err := service.Publish(ctx, author, book.ID, "publish", CommitInput{PreviewID: preview.ID})
	if err != nil {
		t.Fatal(err)
	}
	chapters := append([]application.ManagedChapter{}, book.Chapters...)
	chapters[0].Archived = true
	_, err = manager.Mutate(ctx, author, book.ID, "archive", application.StructureInput{Operation: "structure", BaseVersion: book.Version, Volumes: book.Volumes, Chapters: chapters})
	if err != nil {
		t.Fatal(err)
	}
	public, err := service.Chapter(ctx, "managed-synthetic", version.Chapters[0].Slug)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(public)
	if !strings.Contains(string(raw), "Synthetic published prose retained after archive.") {
		t.Fatal(string(raw))
	}
	history, err := service.History(ctx, author, book.ID)
	if err != nil || len(history) != 1 || history[0].ID != version.ID {
		t.Fatal(history, err)
	}
}

func TestManagedVolumeTitlesAreFrozenPublicMetadata(t *testing.T) {
	ctx := context.Background()
	legacy := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	manager := application.NewManagement(legacy, author.ID)
	book, err := manager.Mutate(ctx, author, "", "create-volume-book", application.StructureInput{Operation: "create"})
	if err != nil {
		t.Fatal(err)
	}
	book, err = manager.Mutate(ctx, author, book.ID, "create-volume", application.StructureInput{Operation: "volume", BaseVersion: book.Version, Title: "第一卷 · 江宁往事"})
	if err != nil {
		t.Fatal(err)
	}
	book.Chapters[0].VolumeID = book.Volumes[0].ID
	book, err = manager.Mutate(ctx, author, book.ID, "move-chapter", application.StructureInput{Operation: "structure", BaseVersion: book.Version, Volumes: book.Volumes, Chapters: book.Chapters})
	if err != nil {
		t.Fatal(err)
	}
	app, err := manager.Resolve(author, book.ID)
	if err != nil {
		t.Fatal(err)
	}
	chapter, err := app.Source(book.Chapters[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	head, err := app.Head(ctx, chapter)
	if err != nil {
		t.Fatal(err)
	}
	key := "volume-prose"
	if _, err = app.Save(ctx, author, chapter.ID, "fixture", map[string]any{"baseRevisionId": head.ID, "markdown": "Synthetic public prose with author-confirmed volume title."}, &key); err != nil {
		t.Fatal(err)
	}
	service := New(legacy.State, nil)
	service.ResolveBook = func(a application.Actor, id string) (Book, error) {
		s, e := manager.Resolve(a, id)
		return Book{App: s, OwnerID: a.ID}, e
	}
	in := input(t, app, chapter.ID)
	preview, err := service.Preview(ctx, author, book.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Chapters[0].VolumeTitle == nil || *preview.Chapters[0].VolumeTitle != "第一卷 · 江宁往事" {
		t.Fatal(preview)
	}
	rename := func(title string) {
		t.Helper()
		book.Volumes[0].Title = title
		book, err = manager.Mutate(ctx, author, book.ID, fmt.Sprintf("rename-volume-%d", book.Version), application.StructureInput{Operation: "structure", BaseVersion: book.Version, Volumes: book.Volumes, Chapters: book.Chapters})
		if err != nil {
			t.Fatal(err)
		}
	}
	rename("第一卷 · 江宁新事")
	_, err = service.Publish(ctx, author, book.ID, "stale-volume-preview", CommitInput{PreviewID: preview.ID})
	expectCode(t, err, "PUBLICATION_REVISION_CONFLICT")
	preview, err = service.Preview(ctx, author, book.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.Publish(ctx, author, book.ID, "initial-volume-publication", CommitInput{PreviewID: preview.ID})
	if err != nil {
		t.Fatal(err)
	}
	before, err := service.Chapter(ctx, in.Metadata.Slug, first.Chapters[0].Slug)
	if err != nil {
		t.Fatal(err)
	}
	if before.VolumeTitle == nil || *before.VolumeTitle != "第一卷 · 江宁新事" {
		t.Fatal(before)
	}
	rename("第一卷 · 后来的卷名")
	after, err := service.Chapter(ctx, in.Metadata.Slug, first.Chapters[0].Slug)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("draft rename leaked into public snapshot", after, err)
	}
	management, err := service.Manage(ctx, author, book.ID)
	if err != nil || len(management.ChangedChapterIDs) != 1 || management.Drafts[0].VolumeTitle == nil || *management.Drafts[0].VolumeTitle != "第一卷 · 后来的卷名" {
		t.Fatal(management, err)
	}
	in.BaseVersionID = &first.ID
	preview, err = service.Preview(ctx, author, book.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Publish(ctx, author, book.ID, "confirmed-new-volume", CommitInput{BaseVersionID: &first.ID, PreviewID: preview.ID})
	if err != nil {
		t.Fatal(err)
	}
	public, err := service.PublicBook(ctx, in.Metadata.Slug)
	if err != nil || public.Chapters[0].VolumeTitle == nil || *public.Chapters[0].VolumeTitle != "第一卷 · 后来的卷名" || public.ContentUpdatedAt != second.CreatedAt {
		t.Fatal(public, err)
	}
	history, err := service.History(ctx, author, book.ID)
	if err != nil || len(history) != 2 || *history[0].Chapters[0].VolumeTitle != "第一卷 · 江宁新事" {
		t.Fatal("immutable old title changed", history, err)
	}
	book.Chapters[0].VolumeID = ""
	book, err = manager.Mutate(ctx, author, book.ID, "ungroup", application.StructureInput{Operation: "structure", BaseVersion: book.Version, Volumes: book.Volumes, Chapters: book.Chapters})
	if err != nil {
		t.Fatal(err)
	}
	in = input(t, app, chapter.ID)
	in.BaseVersionID = &second.ID
	preview, err = service.Preview(ctx, author, book.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	third, err := service.Publish(ctx, author, book.ID, "confirm-ungrouped", CommitInput{BaseVersionID: &second.ID, PreviewID: preview.ID})
	if err != nil {
		t.Fatal(err)
	}
	ungrouped, err := service.Chapter(ctx, in.Metadata.Slug, third.Chapters[0].Slug)
	if err != nil || ungrouped.VolumeTitle == nil || *ungrouped.VolumeTitle != "" {
		t.Fatal("ungrouped must be explicit empty title", ungrouped, err)
	}
	encoded, _ := json.Marshal(ungrouped)
	for _, private := range []string{"volumeId", "chapterId", "revisionId", "ownerUserId"} {
		if strings.Contains(string(encoded), `"`+private+`"`) {
			t.Fatal("private field in public DTO", private)
		}
	}
}

func TestLegacyPublishedVolumesRemainReadableWithoutNewField(t *testing.T) {
	s, app := fixture(t)
	version := publish(t, s, input(t, app, "CH-001"), "legacy-volume")
	encoded, _ := json.Marshal(version)
	if strings.Contains(string(encoded), "volumeTitle") {
		t.Fatal("legacy unknown title must remain absent")
	}
	reopened := New(s.StateDir, map[string]Book{"book-a": {app, author.ID}})
	chapter, err := reopened.Chapter(context.Background(), "book-a", version.Chapters[0].Slug)
	if err != nil || chapter.VolumeTitle != nil {
		t.Fatal(chapter, err)
	}
}

func TestDeleteOwnedPurgesOnlyUnlistedPublicationState(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	stateDir := t.TempDir()
	app := &application.Service{Root: root, State: stateDir, Project: "book-a"}
	author := application.Actor{ID: "writer-a", Role: "author"}
	service := New(stateDir, map[string]Book{"book-a": {App: app, OwnerID: author.ID}})
	seed := state{}
	seed.Schema = 1
	seed.Publications = map[string]Publication{
		"book-a": {
			ID: "publication-a", BookID: "book-a", OwnerID: author.ID, AuthorSlug: "writer-a",
			Current: "version-a", ChapterSlugs: map[string]string{},
			Versions: []Version{{ID: "version-a", PublicationID: "publication-a", Number: 1, State: "unlisted", PublicURL: "/books/a", CreatedAt: compat.Now(), CreatedBy: author.ID, AuditReference: "audit-a", Metadata: Metadata{Slug: "a", Title: "合成作品", PenName: "作者", Tagline: "简介", Description: "简介", Category: "小说", SerialStatus: "ongoing"}}},
		},
		"book-b": {
			ID: "publication-b", BookID: "book-b", OwnerID: author.ID, AuthorSlug: "writer-a",
			Current: "version-b", ChapterSlugs: map[string]string{},
			Versions: []Version{{ID: "version-b", PublicationID: "publication-b", Number: 1, State: "listed", PublicURL: "/books/b", CreatedAt: compat.Now(), CreatedBy: author.ID, AuditReference: "audit-b", Metadata: Metadata{Slug: "b", Title: "仍在公开", PenName: "作者", Tagline: "简介", Description: "简介", Category: "小说", SerialStatus: "ongoing"}, Chapters: []Snapshot{{Selection: Selection{ChapterID: "CH-001", RevisionID: "revision-b", ContentHash: compat.Hash("正文")}, Slug: "chapter-b", Title: "第一章", VolumeOrder: 1, Markdown: "正文"}}}},
		},
	}
	seed.Previews = map[string]Preview{"preview-a": {BookID: "book-a"}, "preview-b": {BookID: "book-b"}}
	seed.Requests = map[string]requestRecord{
		"a": {Version: Version{ID: "version-a", PublicationID: "publication-a"}},
		"b": {Version: Version{ID: "version-b", PublicationID: "publication-b"}},
	}
	seed.AuthorSlugs = map[string]string{author.ID: "writer-a"}
	seed.Audit = []Audit{{BookID: "book-a"}, {BookID: "book-b"}}
	if err := storage.Write(ctx, service.path(), seed); err != nil {
		t.Fatal(err)
	}
	if err := service.CheckDelete(ctx, author, "book-a"); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteOwned(ctx, author, "book-a"); err != nil {
		t.Fatal(err)
	}
	after, err := service.load()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := after.Publications["book-a"]; ok {
		t.Fatal("owned unlisted publication survived")
	}
	if _, ok := after.Previews["preview-a"]; ok {
		t.Fatal("owned preview survived")
	}
	if _, ok := after.Requests["a"]; ok {
		t.Fatal("deleted publication prose retained in receipt")
	}
	if _, ok := after.Requests["b"]; !ok {
		t.Fatal("unrelated publication receipt removed")
	}
	if _, ok := after.Publications["book-b"]; !ok {
		t.Fatal("unrelated publication removed")
	}
	if after.AuthorSlugs[author.ID] != "writer-a" {
		t.Fatal("author slug removed while still in use")
	}
	if err := service.CheckDelete(ctx, author, "book-b"); err == nil || application.AsError(err).Code != "PUBLICATION_LISTED" {
		t.Fatal("listed publication passed preflight", err)
	}
	if err := service.DeleteOwned(ctx, author, "book-b"); err != nil {
		t.Fatal("concurrent listing survived catalog deletion", err)
	}
}
