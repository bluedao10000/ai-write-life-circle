package application

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func importEPUBFixture(t *testing.T) []byte {
	t.Helper()
	return importEPUBWithChapters(t, 2)
}

func importEPUBWithChapters(t *testing.T, count int) []byte {
	t.Helper()
	var buffer bytes.Buffer
	z := zip.NewWriter(&buffer)
	var manifest, spine, nav strings.Builder
	files := map[string]string{
		"mimetype":               "application/epub+zip",
		"META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
	}
	for i := 1; i <= count; i++ {
		id := fmt.Sprintf("ch-%03d", i)
		href := id + ".xhtml"
		manifest.WriteString(fmt.Sprintf(`<item id="%s" href="%s" media-type="application/xhtml+xml"/>`, id, href))
		spine.WriteString(fmt.Sprintf(`<itemref idref="%s"/>`, id))
		nav.WriteString(fmt.Sprintf(`<li><a href="%s">第%d章</a></li>`, href, i))
		text := "雨落在青石板上。"
		if i == 2 {
			text = "来客带来了灯。"
		}
		files["OEBPS/"+href] = fmt.Sprintf(
			`<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第%d章</h1><p>%s</p></body></html>`,
			i, text,
		)
	}
	files["OEBPS/content.opf"] = `<package version="3.0"><metadata><title>导入小说</title><creator>作者甲</creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` + manifest.String() + `</manifest><spine>` + spine.String() + `</spine></package>`
	files["OEBPS/nav.xhtml"] = `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>` + nav.String() + `</ol></nav></body></html>`
	for name, body := range files {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestEPUBImportStagesAtomicallyAndPreservesInitialRevisions(t *testing.T) {
	ctx := context.Background()
	managed := managedFixture(t)
	imports := NewImportService(managed)
	data := importEPUBFixture(t)
	staged, err := imports.Stage(ctx, managedAuthor, "upload-1", "novel.epub", data)
	if err != nil {
		t.Fatal(err)
	}
	if !staged.Created || staged.Preview.Status != "previewed" ||
		staged.Preview.Title != "导入小说" || len(staged.Preview.Chapters) != 2 ||
		staged.Preview.Knowledge.Status != "awaiting_author_consent" {
		t.Fatalf("preview: %+v", staged)
	}
	books, err := managed.List(managedAuthor)
	if err != nil || len(books) != 0 {
		t.Fatal("staging leaked into shelf", books, err)
	}
	// Replaying the same upload key is idempotent and reads no model.
	replay, err := imports.Stage(ctx, managedAuthor, "upload-1", "novel.epub", data)
	if err != nil || replay.Created || replay.Preview.ImportID != staged.Preview.ImportID {
		t.Fatal("stage replay", replay, err)
	}
	chapterInputs := make([]ImportChapterRef, len(staged.Preview.Chapters))
	for i, chapter := range staged.Preview.Chapters {
		chapterInputs[i] = ImportChapterRef{ChapterID: chapter.ChapterID, Title: chapter.Title, VolumeID: chapter.VolumeID}
	}
	input := ImportCommitInput{
		Fingerprint: staged.Preview.Fingerprint,
		Title:       "作者确认书名",
		Volumes:     staged.Preview.Volumes,
		Chapters:    chapterInputs,
	}
	committed, err := imports.Commit(ctx, managedAuthor, staged.Preview.ImportID, "commit-1", input)
	if err != nil {
		t.Fatal(err)
	}
	if !committed.Created || committed.Book.Title != "作者确认书名" || len(committed.Book.Chapters) != 2 {
		t.Fatalf("commit: %+v", committed)
	}
	again, err := imports.Commit(ctx, managedAuthor, staged.Preview.ImportID, "commit-1", input)
	if err != nil || again.Created || again.Book.ID != committed.Book.ID {
		t.Fatal("commit replay", again, err)
	}
	books, err = managed.List(managedAuthor)
	if err != nil || len(books) != 1 || books[0].ID != committed.Book.ID {
		t.Fatal("catalog", books, err)
	}
	app, err := managed.Resolve(managedAuthor, committed.Book.ID)
	if err != nil {
		t.Fatal(err)
	}
	for i, chapter := range committed.Book.Chapters {
		source, err := app.Source(chapter.ID)
		if err != nil {
			t.Fatal(err)
		}
		head, err := app.ReviewRevision(ctx, source)
		if err != nil {
			t.Fatal(err)
		}
		want := "雨落在青石板上"
		if i == 1 {
			want = "来客带来了灯"
		}
		if !strings.Contains(head.Markdown, want) || head.ID[:7] != "import:" ||
			!strings.HasPrefix(head.ParentID(), "source:") {
			t.Fatalf("chapter %d revision: %+v", i, head)
		}
		var draft DraftState
		path := app.draftPath(source)
		if found, err := storage.Read(path, &draft); err != nil || !found || draft.KnowledgeIntent == nil || draft.KnowledgeIntent.ID != head.ID {
			t.Fatalf("chapter %d knowledge intent: %+v, %v", i, draft.KnowledgeIntent, err)
		}
	}
	details, err := app.Chapters()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(mustJSON(t, details), "雨落在青石板上") {
		// The directory intentionally stays metadata-only; this assertion catches
		// accidental prose exposure through the directory API.
		t.Fatal("chapter prose leaked into directory")
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	b, err := jsonMarshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func jsonMarshal(value any) ([]byte, error) {
	return compat.Marshal(value, false)
}

func (r StoredRevision) ParentID() string {
	if r.Parent == nil {
		return ""
	}
	return *r.Parent
}

func TestEPUBImportOwnershipAndNoHalfBookOnRevisionFailure(t *testing.T) {
	ctx := context.Background()
	managed := managedFixture(t)
	imports := NewImportService(managed)
	staged, err := imports.Stage(ctx, managedAuthor, "upload", "novel.epub", importEPUBFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	input := ImportCommitInput{Fingerprint: staged.Preview.Fingerprint, Title: staged.Preview.Title, Volumes: staged.Preview.Volumes}
	for _, chapter := range staged.Preview.Chapters {
		input.Chapters = append(input.Chapters, ImportChapterRef{ChapterID: chapter.ChapterID, Title: chapter.Title, VolumeID: chapter.VolumeID})
	}
	other := Actor{ID: "other", Role: "author"}
	if _, err := imports.Get(other, staged.Preview.ImportID); err == nil {
		t.Fatal("other author read import")
	}
	// A failed catalog commit must remove the manifest from the next replay's
	// visibility, and a stale fingerprint must never create a half book.
	bad := input
	bad.Fingerprint = "sha256:stale"
	if _, err := imports.Commit(ctx, managedAuthor, staged.Preview.ImportID, "bad", bad); err == nil {
		t.Fatal("stale fingerprint committed")
	}
	books, err := managed.List(managedAuthor)
	if err != nil || len(books) != 0 {
		t.Fatal("failed commit was visible", books, err)
	}
	// A directory file mismatch is also rejected before catalog mutation.
	dir := filepath.Join(managed.Legacy.State, "works", "imports", compat.Key(managedAuthor.ID), staged.Preview.ImportID, "chapters", "CH-000002.md")
	if err := os.WriteFile(dir, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := imports.Commit(ctx, managedAuthor, staged.Preview.ImportID, "tampered", input); err == nil {
		t.Fatal("tampered staged content committed")
	}
	books, err = managed.List(managedAuthor)
	if err != nil || len(books) != 0 {
		t.Fatal("tampered commit was visible", books, err)
	}
	var problem *Error
	if _, err := imports.Commit(ctx, Actor{ID: "x", Role: "agent"}, staged.Preview.ImportID, "agent", input); !errors.As(err, &problem) || problem.Status != 403 {
		t.Fatal("agent import access:", err)
	}
}

func TestEPUBImportFailsClosedOnSymlinkedStagingContent(t *testing.T) {
	ctx := context.Background()
	managed := managedFixture(t)
	imports := NewImportService(managed)
	staged, err := imports.Stage(ctx, managedAuthor, "symlink", "novel.epub", importEPUBFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	input := ImportCommitInput{Fingerprint: staged.Preview.Fingerprint, Title: staged.Preview.Title, Volumes: staged.Preview.Volumes}
	for _, chapter := range staged.Preview.Chapters {
		input.Chapters = append(input.Chapters, ImportChapterRef{ChapterID: chapter.ChapterID, Title: chapter.Title, VolumeID: chapter.VolumeID})
	}
	dir := filepath.Join(managed.Legacy.State, "works", "imports", compat.Key(managedAuthor.ID), staged.Preview.ImportID)
	chapterPath := filepath.Join(dir, "chapters", "CH-000002.md")
	outside := filepath.Join(t.TempDir(), "outside.md")
	if err := os.WriteFile(outside, []byte("不可读取的替代正文"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(chapterPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, chapterPath); err != nil {
		t.Fatal(err)
	}
	if _, err := imports.Get(managedAuthor, staged.Preview.ImportID); err == nil {
		t.Fatal("preview followed a staging symlink")
	}
	if _, err := imports.Commit(ctx, managedAuthor, staged.Preview.ImportID, "symlink-commit", input); err == nil {
		t.Fatal("commit followed a staging symlink")
	}
	books, err := managed.List(managedAuthor)
	if err != nil || len(books) != 0 {
		t.Fatal("symlink import leaked into shelf", books, err)
	}
}

func TestEPUBImportCatalogFailureDoesNotExposeHalfBook(t *testing.T) {
	ctx := context.Background()
	managed := managedFixture(t)
	imports := NewImportService(managed)
	staged, err := imports.Stage(ctx, managedAuthor, "upload", "novel.epub", importEPUBFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	input := ImportCommitInput{Fingerprint: staged.Preview.Fingerprint, Title: staged.Preview.Title, Volumes: staged.Preview.Volumes}
	for _, chapter := range staged.Preview.Chapters {
		input.Chapters = append(input.Chapters, ImportChapterRef{ChapterID: chapter.ChapterID, Title: chapter.Title, VolumeID: chapter.VolumeID})
	}
	managed.commitCatalog = func(context.Context, []storedBook, map[string]managedRequest, []any) error {
		return errors.New("catalog unavailable")
	}
	if _, err := imports.Commit(ctx, managedAuthor, staged.Preview.ImportID, "commit", input); err == nil {
		t.Fatal("catalog failure committed")
	}
	managed.commitCatalog = nil
	books, err := managed.List(managedAuthor)
	if err != nil || len(books) != 0 {
		t.Fatal("catalog transaction was partially applied", books, err)
	}
}
func TestEPUBImportWriteFailureDoesNotExposeBook(t *testing.T) {
	ctx := context.Background()
	managed := managedFixture(t)
	imports := NewImportService(managed)
	staged, err := imports.Stage(ctx, managedAuthor, "upload-failure", "novel.epub", importEPUBFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	input := ImportCommitInput{Fingerprint: staged.Preview.Fingerprint, Title: staged.Preview.Title, Volumes: staged.Preview.Volumes}
	for _, chapter := range staged.Preview.Chapters {
		input.Chapters = append(input.Chapters, ImportChapterRef{ChapterID: chapter.ChapterID, Title: chapter.Title, VolumeID: chapter.VolumeID})
	}
	managed.write = func(context.Context, string, any) error { return errors.New("disk full") }
	if _, err := imports.Commit(ctx, managedAuthor, staged.Preview.ImportID, "commit", input); err == nil {
		t.Fatal("disk failure committed")
	}
	managed.write = storage.Write
	books, err := managed.List(managedAuthor)
	if err != nil || len(books) != 0 {
		t.Fatal("disk failure leaked book", books, err)
	}
	// Revisions written before the catalog commit remain invisible and are safely
	// replaceable by an idempotent retry; the catalog remains the commit point.
	if _, err := imports.Commit(ctx, managedAuthor, staged.Preview.ImportID, "commit", input); err != nil {
		t.Fatal(err)
	}
	if books, err = managed.List(managedAuthor); err != nil || len(books) != 1 {
		t.Fatal(books, err)
	}
	// The initial retry observed that every draft had already been written and
	// must not fail with an "file exists" error or overwrite the prepared state.
	app, err := managed.Resolve(managedAuthor, books[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	chapter, err := app.Source(books[0].Chapters[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	head, err := app.ReviewRevision(ctx, chapter)
	if err != nil || !strings.Contains(head.Markdown, "雨落在青石板上") {
		t.Fatal(head, err)
	}
}

func TestEPUBImportThreeHundredChaptersCompletesWithinRequestWindow(t *testing.T) {
	if testing.Short() {
		t.Skip("300-chapter import timing fixture")
	}
	ctx := context.Background()
	managed := managedFixture(t)
	imports := NewImportService(managed)
	started := time.Now()
	staged, err := imports.Stage(ctx, managedAuthor, "large-upload", "novel.epub", importEPUBWithChapters(t, 300))
	if err != nil {
		t.Fatal(err)
	}
	input := ImportCommitInput{Fingerprint: staged.Preview.Fingerprint, Title: staged.Preview.Title, Volumes: staged.Preview.Volumes}
	for _, chapter := range staged.Preview.Chapters {
		input.Chapters = append(input.Chapters, ImportChapterRef{ChapterID: chapter.ChapterID, Title: chapter.Title, VolumeID: chapter.VolumeID})
	}
	committed, err := imports.Commit(ctx, managedAuthor, staged.Preview.ImportID, "large-commit", input)
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(started)
	if len(committed.Book.Chapters) != 300 {
		t.Fatalf("chapter count: %d", len(committed.Book.Chapters))
	}
	if elapsed >= 55*time.Second {
		t.Fatalf("300-chapter stage and commit took %s, too close to the 60s request window", elapsed)
	}
	books, err := managed.List(managedAuthor)
	if err != nil || len(books) != 1 || len(books[0].Chapters) != 300 {
		t.Fatal(books, err)
	}
}

func stagedImportInput(t *testing.T, imports *ImportService) (string, ImportCommitInput) {
	t.Helper()
	staged, err := imports.Stage(context.Background(), managedAuthor, "upload", "novel.epub", importEPUBFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	p := staged.Preview
	input := ImportCommitInput{Fingerprint: p.Fingerprint, Title: p.Title, Volumes: p.Volumes}
	for _, c := range p.Chapters {
		input.Chapters = append(input.Chapters, ImportChapterRef{ChapterID: c.ChapterID, Title: c.Title, VolumeID: c.VolumeID})
	}
	return p.ImportID, input
}

func TestEPUBCommitReplayAfterAuthorEdits(t *testing.T) {
	ctx := context.Background()
	managed := managedFixture(t)
	imports := NewImportService(managed)
	id, input := stagedImportInput(t, imports)
	first, err := imports.Commit(ctx, managedAuthor, id, "commit", input)
	if err != nil {
		t.Fatal(err)
	}
	app, err := managed.Resolve(managedAuthor, first.Book.ID)
	if err != nil {
		t.Fatal(err)
	}
	chapter, err := app.Source(first.Book.Chapters[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	head, err := app.ReviewRevision(ctx, chapter)
	if err != nil {
		t.Fatal(err)
	}
	key := "author-edit"
	saved, err := app.Save(ctx, managedAuthor, chapter.ID, key, map[string]any{"baseRevisionId": head.ID, "markdown": "作者修改后的正文。"}, &key)
	if err != nil {
		t.Fatal(err)
	}
	// Reconstruct services to exercise durable receipts rather than memory.
	imports = NewImportService(NewManagement(managed.Legacy, managed.OwnerID))
	replay, err := imports.Commit(ctx, managedAuthor, id, "commit", input)
	if err != nil || replay.Created || mustJSON(t, replay.Book) != mustJSON(t, first.Book) {
		t.Fatal("replay after edit", replay, err)
	}
	current, err := app.ReviewRevision(ctx, chapter)
	if err != nil || current.ID != saved.Revision.ID || current.Markdown != "作者修改后的正文。" {
		t.Fatal("replay changed author revision", current, err)
	}
	input.Title = "不同请求"
	if _, err := imports.Commit(ctx, managedAuthor, id, "commit", input); err == nil || AsError(err).Status != 422 {
		t.Fatal("different request reused key", err)
	}
}

func TestEPUBDeleteWaitsForCommitAndPreservesManifest(t *testing.T) {
	ctx := context.Background()
	managed := managedFixture(t)
	imports := NewImportService(managed)
	id, input := stagedImportInput(t, imports)
	entered, release := make(chan struct{}), make(chan struct{})
	managed.commitCatalog = func(ctx context.Context, books []storedBook, requests map[string]managedRequest, audit []any) error {
		close(entered)
		<-release
		return storage.Write(ctx, managed.path(), managedState{Schema: 1, Books: books, Requests: requests, Audit: audit})
	}
	committed := make(chan error, 1)
	go func() { _, err := imports.Commit(ctx, managedAuthor, id, "commit", input); committed <- err }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("commit never reached catalog")
	}
	// A separate service models another browser/API process sharing disk locks.
	other := NewImportService(NewManagement(managed.Legacy, managed.OwnerID))
	deleted := make(chan error, 1)
	go func() { deleted <- other.Delete(ctx, managedAuthor, id) }()
	select {
	case err := <-deleted:
		close(release)
		t.Fatalf("delete escaped active commit: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-committed; err != nil {
		t.Fatal(err)
	}
	if err := <-deleted; err == nil || AsError(err).Code != "IMPORT_ALREADY_COMMITTED" {
		t.Fatal("delete committed import", err)
	}
	preview, err := imports.Get(managedAuthor, id)
	if err != nil || preview.Status != "committed" || len(preview.Chapters) != 2 {
		t.Fatal("import metadata lost", preview, err)
	}
	if books, err := managed.List(managedAuthor); err != nil || len(books) != 1 {
		t.Fatal("visible book lost", books, err)
	}
}

func TestEPUBDeleteBeforeCommitLeavesNoVisibleBook(t *testing.T) {
	managed := managedFixture(t)
	imports := NewImportService(managed)
	id, input := stagedImportInput(t, imports)
	if err := imports.Delete(context.Background(), managedAuthor, id); err != nil {
		t.Fatal(err)
	}
	if _, err := imports.Commit(context.Background(), managedAuthor, id, "commit", input); err == nil || AsError(err).Status != 404 {
		t.Fatal("deleted import committed", err)
	}
	books, err := managed.List(managedAuthor)
	if err != nil || len(books) != 0 {
		t.Fatal("deleted import became visible", books, err)
	}
}
