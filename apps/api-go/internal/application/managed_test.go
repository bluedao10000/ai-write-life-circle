package application

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/harness"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func managedFixture(t *testing.T) *Management {
	t.Helper()
	return NewManagement(&Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, "author-one")
}

var managedAuthor = Actor{ID: "author-one", Role: "author"}

func createWork(t *testing.T, m *Management, key string) ManagedBook {
	t.Helper()
	b, e := m.Mutate(context.Background(), managedAuthor, "", key, StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestManagedBootstrapAndRevisionCompatibility(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	items, e := m.List(managedAuthor)
	if e != nil || len(items) != 0 {
		t.Fatal(items, e)
	}
	b := createWork(t, m, "bootstrap")
	if b.Title != "未命名作品" || len(b.Chapters) != 1 || len(b.Volumes) != 0 {
		t.Fatal(b)
	}
	if createWork(t, m, "bootstrap").ID != b.ID {
		t.Fatal("duplicate work")
	}
	app, e := m.Resolve(managedAuthor, b.ID)
	if e != nil {
		t.Fatal(e)
	}
	c, e := app.Source(b.Chapters[0].ID)
	if e != nil {
		t.Fatal(e)
	}
	if c.Markdown != "" {
		t.Fatalf("metadata leaked: %q", c.Markdown)
	}
	h, e := app.Head(ctx, c)
	if e != nil {
		t.Fatal(e)
	}
	key := "save-body"
	saved, e := app.Save(ctx, managedAuthor, c.ID, "request", map[string]any{"baseRevisionId": h.ID, "markdown": "雨落在窗前。\n\n这是合成测试正文。"}, &key)
	if e != nil {
		t.Fatal(e)
	}
	chapters := append([]ManagedChapter{}, b.Chapters...)
	chapters[0].Title = "起点"
	next, e := m.Mutate(ctx, managedAuthor, b.ID, "rename-chapter", StructureInput{Operation: "structure", BaseVersion: b.Version, Volumes: b.Volumes, Chapters: chapters})
	if e != nil {
		t.Fatal(e)
	}
	after, e := app.Source(c.ID)
	if e != nil {
		t.Fatal(e)
	}
	if after.SourceHash != c.SourceHash || after.SourceRevisionID != c.SourceRevisionID || after.StructureHash == c.StructureHash {
		t.Fatal("body lineage changed or structure fingerprint unchanged")
	}
	head, e := app.Head(ctx, after)
	if e != nil || head.ID != saved.Revision.ID {
		t.Fatal(head, e)
	}
	history, e := app.History(ctx, c.ID)
	if e != nil || len(history) < 2 {
		t.Fatal(history, e)
	}
	next, e = m.Mutate(ctx, managedAuthor, b.ID, "rename-book", StructureInput{Operation: "rename", BaseVersion: next.Version, Title: "合成故事"})
	if e != nil {
		t.Fatal(e)
	}
	found, e := NewManagement(m.Legacy, m.OwnerID).Get(managedAuthor, b.ID)
	if e != nil || found.Title != next.Title {
		t.Fatal(found, e)
	}
	second := createWork(t, m, "second")
	other, _ := m.Resolve(managedAuthor, second.ID)
	otherSource, _ := other.Source(second.Chapters[0].ID)
	empty, e := other.Head(ctx, otherSource)
	if e != nil || empty.ID == head.ID {
		t.Fatal("works share drafts", e)
	}
}
func TestManagedOrganizationCASAndOwnership(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	b := createWork(t, m, "first")
	for _, a := range []Actor{{ID: "other", Role: "author"}, {ID: "author-one", Role: "agent"}} {
		if _, e := m.Resolve(a, b.ID); e == nil {
			t.Fatal("unauthorized lookup")
		}
		if _, e := m.Mutate(ctx, a, b.ID, "attack", StructureInput{Operation: "rename", BaseVersion: 1, Title: "bad"}); e == nil {
			t.Fatal("unauthorized mutation")
		}
	}
	if _, e := m.Resolve(managedAuthor, "../../etc"); e == nil {
		t.Fatal("path traversal")
	}
	v, e := m.Mutate(ctx, managedAuthor, b.ID, "v1", StructureInput{Operation: "volume", BaseVersion: 1, Title: "第一卷"})
	if e != nil {
		t.Fatal(e)
	}
	v, e = m.Mutate(ctx, managedAuthor, b.ID, "v2", StructureInput{Operation: "volume", BaseVersion: v.Version, Title: "第二卷"})
	if e != nil || len(v.Volumes) != 2 {
		t.Fatal(v, e)
	}
	v, e = m.Mutate(ctx, managedAuthor, b.ID, "ch2", StructureInput{Operation: "chapter", BaseVersion: v.Version, VolumeID: v.Volumes[0].ID})
	if e != nil {
		t.Fatal(e)
	}
	chapters := append([]ManagedChapter{}, v.Chapters...)
	chapters[0].VolumeID = v.Volumes[1].ID
	chapters[1].VolumeID = v.Volumes[1].ID
	chapters[0], chapters[1] = chapters[1], chapters[0]
	volumes := append([]ManagedVolume{}, v.Volumes...)
	volumes[0], volumes[1] = volumes[1], volumes[0]
	volumes[0].Title = "重命名卷"
	ordered, e := m.Mutate(ctx, managedAuthor, b.ID, "organize", StructureInput{Operation: "structure", BaseVersion: v.Version, Chapters: chapters, Volumes: volumes})
	if e != nil {
		t.Fatal(e)
	}
	app, _ := m.Resolve(managedAuthor, b.ID)
	p, _ := app.Projection()
	all, _ := Sources(p)
	if len(all) != 2 || all[0].ID != chapters[0].ID {
		t.Fatal(all)
	}
	archived := append([]ManagedChapter{}, ordered.Chapters...)
	archived[0].Archived = true
	archivedBook, e := m.Mutate(ctx, managedAuthor, b.ID, "archive", StructureInput{Operation: "structure", BaseVersion: ordered.Version, Chapters: archived, Volumes: ordered.Volumes})
	if e != nil {
		t.Fatal(e)
	}
	p, _ = app.Projection()
	if len(p.Chapters) != 1 {
		t.Fatal(p)
	}
	restored, e := m.Mutate(ctx, managedAuthor, b.ID, "restore", StructureInput{Operation: "structure", BaseVersion: archivedBook.Version, Chapters: ordered.Chapters, Volumes: ordered.Volumes})
	if e != nil {
		t.Fatal(e)
	}
	_, e = m.Mutate(ctx, managedAuthor, b.ID, "drop-volume", StructureInput{Operation: "structure", BaseVersion: restored.Version, Chapters: restored.Chapters, Volumes: []ManagedVolume{}})
	if e == nil {
		t.Fatal("removed nonempty volume")
	}
	_, e = m.Mutate(ctx, managedAuthor, b.ID, "drop-chapter", StructureInput{Operation: "structure", BaseVersion: restored.Version, Chapters: restored.Chapters[:1], Volumes: restored.Volumes})
	if e == nil {
		t.Fatal("lost chapter")
	}
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, key := range []string{"race-1", "race-2"} {
		wg.Add(1)
		go func(key string) {
			defer wg.Done()
			_, e := m.Mutate(ctx, managedAuthor, b.ID, key, StructureInput{Operation: "rename", BaseVersion: restored.Version, Title: key})
			if e == nil {
				codes <- 200
			} else {
				codes <- AsError(e).Status
			}
		}(key)
	}
	wg.Wait()
	close(codes)
	sum := 0
	for c := range codes {
		sum += c
	}
	if sum != 609 {
		t.Fatal(sum)
	}
}
func TestManagedAtomicFailureAndSymlink(t *testing.T) {
	m := managedFixture(t)
	m.write = func(context.Context, string, any) error { return errors.New("disk full") }
	if _, e := m.Mutate(context.Background(), managedAuthor, "", "fail", StructureInput{Operation: "create"}); e == nil {
		t.Fatal("failed write succeeded")
	}
	items, e := m.List(managedAuthor)
	if e != nil || len(items) != 0 {
		t.Fatal(items, e)
	}
	m = managedFixture(t)
	outside := t.TempDir()
	if e := os.Symlink(outside, filepath.Join(m.Legacy.State, "works")); e != nil {
		t.Fatal(e)
	}
	if _, e := m.Mutate(context.Background(), managedAuthor, "", "escape", StructureInput{Operation: "create"}); e == nil {
		t.Fatal("followed symlink")
	}
	files, _ := os.ReadDir(outside)
	if len(files) != 0 {
		t.Fatal("escaped state")
	}
}

func TestManagedEmptyVolumeArchiveAndAtomicUpdateFailure(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	b := createWork(t, m, "create")
	b, e := m.Mutate(ctx, managedAuthor, b.ID, "volume", StructureInput{Operation: "volume", BaseVersion: b.Version})
	if e != nil {
		t.Fatal(e)
	}
	volumes := append([]ManagedVolume{}, b.Volumes...)
	volumes[0].Archived = true
	archived, e := m.Mutate(ctx, managedAuthor, b.ID, "archive-volume", StructureInput{Operation: "structure", BaseVersion: b.Version, Volumes: volumes, Chapters: b.Chapters})
	if e != nil {
		t.Fatal(e)
	}
	_, e = m.Mutate(ctx, managedAuthor, b.ID, "bad-move", StructureInput{Operation: "chapter", BaseVersion: archived.Version, VolumeID: volumes[0].ID})
	if e == nil {
		t.Fatal("moved into archived volume")
	}
	m.write = func(context.Context, string, any) error { return errors.New("disk failure") }
	_, e = m.Mutate(ctx, managedAuthor, b.ID, "fail-update", StructureInput{Operation: "rename", BaseVersion: archived.Version, Title: "must not persist"})
	if e == nil {
		t.Fatal("write failure ignored")
	}
	after, e := m.Get(managedAuthor, b.ID)
	if e != nil || after.Title != b.Title || after.Version != archived.Version {
		t.Fatal(after, e)
	}
	_, e = m.Mutate(ctx, managedAuthor, "", "create", StructureInput{Operation: "create", Title: "different"})
	if e == nil || AsError(e).Status != 422 {
		t.Fatal("idempotency reuse accepted", e)
	}
}

func TestManagedMigratesLegacyIdempotencyReceipt(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	input := StructureInput{Operation: "create", Title: "升级前请求"}
	payload, err := json.Marshal(struct {
		ID    string
		Input StructureInput
	}{"", input})
	if err != nil {
		t.Fatal(err)
	}
	book := ManagedBook{
		ID: "book-11111111-1111-4111-8111-111111111111", Title: input.Title, Version: 1,
		Volumes: []ManagedVolume{}, Chapters: []ManagedChapter{{ID: "CH-000001", Title: "第一章"}},
	}
	legacyKey := compat.Key(managedAuthor.ID) + ":create-before-upgrade"
	st := managedState{
		Schema: 1,
		Books:  []storedBook{{ManagedBook: book, Owner: managedAuthor.ID}},
		Requests: map[string]managedRequest{
			legacyKey: {Hash: compat.Hash(string(payload)), Result: book},
		},
		Audit: []any{},
	}
	if err := storage.Write(ctx, m.path(), st); err != nil {
		t.Fatal(err)
	}
	replayed, err := m.Mutate(ctx, managedAuthor, "", "create-before-upgrade", input)
	if err != nil || replayed.ID != book.ID {
		t.Fatalf("legacy replay: %+v %v", replayed, err)
	}
	after, err := m.load()
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := after.Requests[legacyKey]; exists {
		t.Fatal("legacy receipt was not migrated")
	}
	if receipt, exists := after.Requests["structure:"+legacyKey]; !exists || receipt.Result.ID != book.ID {
		t.Fatalf("namespaced receipt missing: %+v", after.Requests)
	}
}

func TestManagedLegacyHarnessAndDraftSymlink(t *testing.T) {
	m := managedFixture(t)
	if e := os.MkdirAll(filepath.Join(m.Legacy.Root, "manuscript"), 0700); e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(m.Legacy.Root, "manuscript", "CH-001.md")
	title := strings.Repeat("旧章", 150)
	raw := "# " + title + "\nID: CH-001\n\nLegacy prose unchanged.\n"
	if e := os.WriteFile(file, []byte(raw), 0400); e != nil {
		t.Fatal(e)
	}
	list, e := m.List(managedAuthor)
	if e != nil || len(list) != 1 || !list[0].ReadOnly {
		t.Fatal(list, e)
	}
	if list[0].Chapters[0].Title != title {
		t.Fatal("legacy title was truncated")
	}
	if _, e := m.Mutate(context.Background(), managedAuthor, m.Legacy.Project, "legacy-write", StructureInput{Operation: "chapter", BaseVersion: 1}); e == nil {
		t.Fatal("legacy structure changed")
	}
	after, _ := os.ReadFile(file)
	if string(after) != raw {
		t.Fatal("source changed")
	}
	b := createWork(t, m, "managed")
	app, _ := m.Resolve(managedAuthor, b.ID)
	outside := t.TempDir()
	if e := os.Symlink(outside, filepath.Join(m.Legacy.State, "chapter-drafts")); e != nil {
		t.Fatal(e)
	}
	if _, e := app.Source(b.Chapters[0].ID); e == nil {
		t.Fatal("draft symlink accepted")
	}
}

func TestManagedTitleUsesContractUTF16Limit(t *testing.T) {
	m := managedFixture(t)
	for _, title := range []string{strings.Repeat("😀", 101), "\ufeff"} {
		_, err := m.Mutate(context.Background(), managedAuthor, "", "invalid-"+fmt.Sprint(len(title)), StructureInput{Operation: "create", Title: title})
		if err == nil || AsError(err).Status != 422 {
			t.Fatal("invalid title accepted", err)
		}
	}
	books, err := m.List(managedAuthor)
	if err != nil || len(books) != 0 {
		t.Fatal("invalid title poisoned registry", books, err)
	}
	b, err := m.Mutate(context.Background(), managedAuthor, "", "emoji-boundary", StructureInput{Operation: "create", Title: strings.Repeat("😀", 100)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Get(managedAuthor, b.ID); err != nil {
		t.Fatal(err)
	}
}

func TestManagedDeleteIsOwnerScopedVersionedAndIdempotent(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	b := createWork(t, m, "create")
	keep := createWork(t, m, "keep")
	app, err := m.Resolve(managedAuthor, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	c, err := app.Source(b.Chapters[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	head, err := app.Head(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	key := "delete-key"
	if _, err = app.Save(ctx, managedAuthor, c.ID, "save", map[string]any{"baseRevisionId": head.ID, "markdown": "待删除作品正文。"}, &key); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Delete(ctx, Actor{ID: "other", Role: "author"}, b.ID, "other", DeleteBookInput{BaseVersion: b.Version}); err == nil {
		t.Fatal("another author deleted the book")
	}
	if _, err = m.Delete(ctx, managedAuthor, b.ID, "stale", DeleteBookInput{BaseVersion: b.Version + 1}); err == nil || AsError(err).Status != 409 {
		t.Fatal("stale delete accepted", err)
	}
	if _, err = m.Delete(ctx, managedAuthor, b.ID, key, DeleteBookInput{BaseVersion: b.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Get(managedAuthor, b.ID); err == nil {
		t.Fatal("deleted book still resolves")
	}
	if _, err = m.Get(managedAuthor, keep.ID); err != nil {
		t.Fatal("unrelated book disappeared", err)
	}
	draft := filepath.Join(m.Legacy.State, "chapter-drafts", compat.Key(b.ID))
	if _, err = os.Stat(draft); !os.IsNotExist(err) {
		t.Fatal("deleted revisions remain", err)
	}
	if _, err = m.Delete(ctx, managedAuthor, b.ID, key, DeleteBookInput{BaseVersion: b.Version}); err != nil {
		t.Fatal("delete replay failed", err)
	}
	if _, err = m.Delete(ctx, managedAuthor, b.ID, key, DeleteBookInput{BaseVersion: b.Version + 1}); err == nil || AsError(err).Code != "VALIDATION_FAILED" {
		t.Fatal("a deleted book key accepted a different request", err)
	}
	if _, err = m.Delete(ctx, managedAuthor, b.ID, "fresh-browser-key", DeleteBookInput{BaseVersion: b.Version}); err != nil {
		t.Fatal("a fresh key could not confirm the completed deletion", err)
	}
	if _, err = m.Get(managedAuthor, b.ID); err == nil {
		t.Fatal("fresh-key replay restored the deleted book")
	}
	if _, err := m.Mutate(ctx, managedAuthor, "", "create", StructureInput{Operation: "create"}); err == nil || AsError(err).Status != 404 {
		t.Fatal("old creation intent recreated deleted work", err)
	}
}

func TestManagedDeleteRejectsListedPublicationBeforeCatalogCommit(t *testing.T) {
	m := managedFixture(t)
	b := createWork(t, m, "create")
	m.GuardDelete = func(context.Context, Actor, string) error {
		return Fail(409, "PUBLICATION_LISTED", "请先在发布页下架作品，再删除。")
	}
	if _, err := m.Delete(context.Background(), managedAuthor, b.ID, "delete", DeleteBookInput{BaseVersion: b.Version}); err == nil || AsError(err).Code != "PUBLICATION_LISTED" {
		t.Fatal("listed publication allowed deletion", err)
	}
	if _, err := m.Get(managedAuthor, b.ID); err != nil {
		t.Fatal("failed delete removed the book", err)
	}
}

func TestManagedDeleteFailureLeavesBookVisibleAndCleanupReplay(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	b := createWork(t, m, "create")
	draftRoot := filepath.Join(m.Legacy.State, "chapter-drafts", compat.Key(b.ID))
	if err := os.MkdirAll(draftRoot, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(draftRoot, "sentinel"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	m.commitCatalog = func(context.Context, []storedBook, map[string]managedRequest, []any) error {
		return errors.New("disk full")
	}
	if _, err := m.Delete(ctx, managedAuthor, b.ID, "failed-delete", DeleteBookInput{BaseVersion: b.Version}); err == nil {
		t.Fatal("catalog write failure ignored")
	}
	if _, err := m.Get(managedAuthor, b.ID); err != nil {
		t.Fatal("failed delete hid the visible book", err)
	}
	if _, err := os.Stat(draftRoot); err != nil {
		t.Fatal("failed visibility commit deleted private state", err)
	}
	m.commitCatalog = nil
	if _, err := m.Delete(ctx, managedAuthor, b.ID, "delete", DeleteBookInput{BaseVersion: b.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(draftRoot); !os.IsNotExist(err) {
		t.Fatal("successful delete left private revisions", err)
	}
	m.CleanupExternal = func(context.Context, Actor, string) error {
		return errors.New("temporary purge failure")
	}
	recreated := b
	recreated.Title = "重新创建"
	other := createWork(t, m, "recreate")
	recreated.ID = other.ID
	other.Version = b.Version
	other.Title = recreated.Title
	other.Volumes = b.Volumes
	other.Chapters = b.Chapters
	if err := storage.Lock(ctx, m.path()+".lock", func() error {
		st, err := m.load()
		if err != nil {
			return err
		}
		for i := range st.Books {
			if st.Books[i].ID == other.ID {
				st.Books[i].ManagedBook = other
			}
		}
		return m.write(ctx, m.path(), st)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Delete(ctx, managedAuthor, other.ID, "cleanup-replay", DeleteBookInput{BaseVersion: other.Version}); err == nil {
		t.Fatal("failed cleanup reported success")
	}
	if _, err := m.Get(managedAuthor, other.ID); err == nil {
		t.Fatal("catalog visibility rolled back after purge failure")
	}
	m.CleanupExternal = nil
	if _, err := m.Delete(ctx, managedAuthor, other.ID, "cleanup-replay-new-key", DeleteBookInput{BaseVersion: other.Version}); err != nil {
		t.Fatal("cleanup replay failed", err)
	}
	listed := createWork(t, m, "listed")
	m.GuardDelete = func(context.Context, Actor, string) error {
		return Fail(409, "PUBLICATION_LISTED", "请先在发布页下架作品，再删除。")
	}
	if _, err := m.Delete(ctx, managedAuthor, listed.ID, "listed-delete", DeleteBookInput{BaseVersion: listed.Version}); err == nil || AsError(err).Code != "PUBLICATION_LISTED" {
		t.Fatal("listed publication deleted", err)
	}
	if _, err := m.Get(managedAuthor, listed.ID); err != nil {
		t.Fatal("listed publication's book disappeared", err)
	}
}

func TestBrokenLegacyHarnessCannotBlockManagedAccess(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	b := createWork(t, m, "managed")
	if err := os.MkdirAll(filepath.Join(m.Legacy.Root, "manuscript"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.Legacy.Root, "manuscript", "CH-001.md"), []byte("# Broken legacy\nID: CH-001\norder: not-an-integer\n\nLegacy text."), 0600); err != nil {
		t.Fatal(err)
	}
	books, err := m.List(managedAuthor)
	if err != nil || len(books) != 1 || books[0].ID != b.ID {
		t.Fatal(books, err)
	}
	if _, err := m.Get(managedAuthor, m.Legacy.Project); err == nil {
		t.Fatal("explicit legacy read should report malformed source")
	}
	calls := 0
	m.Legacy.ProjectionProvider = func() (harness.Projection, error) {
		calls++
		return harness.Projection{}, errors.New("unavailable external disk")
	}
	got, err := m.Get(managedAuthor, b.ID)
	if err != nil || got.ID != b.ID {
		t.Fatal(got, err)
	}
	app, err := m.Resolve(managedAuthor, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	chapter, err := app.Source(b.Chapters[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	head, err := app.Head(ctx, chapter)
	if err != nil {
		t.Fatal(err)
	}
	key := "independent-save"
	if _, err = app.Save(ctx, managedAuthor, chapter.ID, "fixture", map[string]any{"baseRevisionId": head.ID, "markdown": "Isolated managed prose."}, &key); err != nil {
		t.Fatal(err)
	}
	if _, err = app.Workspace(managedAuthor.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = app.Chapters(); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatal("managed lookup scanned legacy", calls)
	}
	other := Actor{ID: "other-author", Role: "author"}
	if _, err = m.Get(other, b.ID); err == nil {
		t.Fatal("ownership bypass")
	}
	if _, err = m.Resolve(other, b.ID); err == nil {
		t.Fatal("resolver ownership bypass")
	}
	list, err := m.List(other)
	if err != nil || len(list) != 0 || calls != 0 {
		t.Fatal(list, err, calls)
	}
}

func TestManagedDeleteResumesAfterRestartAndScopesTombstone(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	b := createWork(t, m, "create")
	draft := filepath.Join(m.Legacy.State, "chapter-drafts", compat.Key(b.ID))
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Dir(draft), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, draft); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Delete(ctx, managedAuthor, b.ID, "delete", DeleteBookInput{BaseVersion: b.Version}); err == nil {
		t.Fatal("unsafe purge succeeded")
	}
	if _, err := m.Get(managedAuthor, b.ID); err == nil {
		t.Fatal("failed cleanup restored visibility")
	}
	st, err := m.load()
	if err != nil {
		t.Fatal(err)
	}
	marker := "delete:purge:" + compat.Key(b.ID)
	if _, ok := st.Requests[marker]; !ok {
		t.Fatal("purge intent lost")
	}
	if err := os.Remove(draft); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(draft, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(draft, "sentinel"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	restarted := NewManagement(m.Legacy, m.OwnerID)
	if n, err := restarted.ResumeDeletionCleanup(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if _, err := os.Stat(draft); !os.IsNotExist(err) {
		t.Fatal("draft survived recovery", err)
	}
	st, err = restarted.load()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := st.Requests[marker]; ok {
		t.Fatal("completed purge marker retained")
	}
	if n, err := restarted.ResumeDeletionCleanup(ctx); err != nil || n != 0 {
		t.Fatal(n, err)
	}
	if _, err := restarted.Delete(ctx, Actor{ID: "other", Role: "author"}, b.ID, "retry", DeleteBookInput{BaseVersion: b.Version}); err == nil || AsError(err).Status != 404 {
		t.Fatal("tombstone leaked to other author", err)
	}
}

func TestManagedDeleteFencesQueuedResourceWriters(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	b := createWork(t, m, "create")
	app, err := m.Resolve(managedAuthor, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	c, err := app.Source(b.Chapters[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	held := make(chan error, 1)
	go func() {
		held <- app.StateLock(ctx, app.draftPath(c)+".lock", func() error { close(entered); <-release; return nil })
	}()
	<-entered
	saved := make(chan error, 1)
	go func() {
		_, err := app.saveRevision(ctx, c, managedAuthor, RevisionInput{Base: pointer(c.SourceRevisionID), Markdown: "late private text"}, nil)
		saved <- err
	}()
	if _, err := m.Delete(ctx, managedAuthor, b.ID, "delete", DeleteBookInput{BaseVersion: b.Version}); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	if err := <-held; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-saved:
		if err == nil || AsError(err).Status != 404 {
			t.Fatal("late save recreated draft", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("writer deadlocked")
	}
	if _, err := app.MutateNote(ctx, managedAuthor, nil, "late-note", map[string]any{"content": "late note"}); err == nil || AsError(err).Status != 404 {
		t.Fatal("late note accepted", err)
	}
	if _, err := app.PatchWorkspace(ctx, managedAuthor, map[string]any{"theme": "dark"}); err == nil || AsError(err).Status != 404 {
		t.Fatal("late workspace accepted", err)
	}
	for _, path := range []string{filepath.Dir(app.draftPath(c)), app.notesPath(), filepath.Dir(app.workspacePath(managedAuthor.ID))} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("deleted private state recreated", path, err)
		}
	}
}

func TestManagedDeleteWaitsForInFlightStateCommit(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	b := createWork(t, m, "create")
	app, err := m.Resolve(managedAuthor, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	written := make(chan error, 1)
	path := app.notesPath()
	go func() {
		written <- app.CommitBookState(ctx, func() error {
			close(entered)
			<-release
			return storage.Write(ctx, path, map[string]any{"private": "in flight"})
		})
	}()
	<-entered
	deleted := make(chan error, 1)
	go func() {
		_, err := m.Delete(ctx, managedAuthor, b.ID, "delete", DeleteBookInput{BaseVersion: b.Version})
		deleted <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := m.Get(managedAuthor, b.ID); err != nil {
			break
		}
		if time.Now().After(deadline) {
			close(release)
			t.Fatal("catalog commit blocked")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case err := <-deleted:
		close(release)
		t.Fatal("delete did not wait for in-flight commit", err)
	default:
	}
	close(release)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := <-deleted; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("in-flight state survived deletion", err)
	}
}
