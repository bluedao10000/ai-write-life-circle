package knowledge

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"strings"
	"testing"
	"time"
)

func importedEPUB(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	z := zip.NewWriter(&buffer)
	files := map[string]string{
		"META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
		"OEBPS/content.opf":      `<package version="3.0"><metadata><title>导入小说</title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`,
		"OEBPS/nav.xhtml":        `<html><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="one.xhtml">第一章</a></li><li><a href="two.xhtml">第二章</a></li></ol></nav></body></html>`,
		"OEBPS/one.xhtml":        `<html><body><h1>第一章</h1><p>林舟离开北港。</p></body></html>`,
		"OEBPS/two.xhtml":        `<html><body><h1>第二章</h1><p>林舟抵达江宁。</p></body></html>`,
	}
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

func TestImportedBookQueuesKnowledgeOnlyAfterConsent(t *testing.T) {
	ctx := context.Background()
	actor := application.Actor{ID: "import-author", Role: "author"}
	managed := application.NewManagement(
		&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"},
		actor.ID,
	)
	imports := application.NewImportService(managed)
	staged, err := imports.Stage(ctx, actor, "upload", "novel.epub", importedEPUB(t))
	if err != nil {
		t.Fatal(err)
	}
	input := application.ImportCommitInput{
		Fingerprint: staged.Preview.Fingerprint,
		Title:       staged.Preview.Title,
		Volumes:     staged.Preview.Volumes,
	}
	for _, chapter := range staged.Preview.Chapters {
		input.Chapters = append(input.Chapters, application.ImportChapterRef{
			ChapterID: chapter.ChapterID, Title: chapter.Title, VolumeID: chapter.VolumeID,
		})
	}
	committed, err := imports.Commit(ctx, actor, staged.Preview.ImportID, "commit", input)
	if err != nil {
		t.Fatal(err)
	}
	app, err := managed.Resolve(actor, committed.Book.ID)
	if err != nil {
		t.Fatal(err)
	}
	config := llm.Config{
		Provider: "openai-compatible", Model: "fixture", BaseURL: "http://127.0.0.1",
		ResponseFormat: "none", TokenParameter: "max_tokens",
		Timeout: time.Second, MaxContextBytes: 12000, MaxOutputTokens: 2048,
		MaxResponseBytes: 256 * 1024,
	}
	service := New(app, config, nil)
	service.QueueOnly = true
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	state, err := service.load()
	if err != nil {
		t.Fatal(err)
	}
	if state.Settings.Enabled || len(state.Jobs) != 0 {
		t.Fatalf("imported prose reached the model queue without consent: %+v", state)
	}
	model := config.Info()
	if _, err := service.Mutate(ctx, actor, "enable", "enable", Mutation{
		BaseVersion: state.Version, Consent: true, Model: &model,
		DailyTokenBudget: 1_000_000, DailyJobBudget: 100,
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.ProcessOne(ctx); err != nil {
		t.Fatal(err)
	}
	state, err = service.load()
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Jobs) != 2 || state.Jobs[0].ChapterID != "CH-000001" || state.Jobs[1].ChapterID != "CH-000002" {
		t.Fatalf("knowledge did not queue imports in chapter order: %+v", state.Jobs)
	}
	if !strings.Contains(state.Jobs[0].Hash, "sha256:") {
		t.Fatalf("knowledge job lacks imported revision hash: %+v", state.Jobs[0])
	}
	if fmt.Sprint(state.Jobs[0].Model) != fmt.Sprint(config.Info()) {
		t.Fatalf("unexpected model binding: %+v", state.Jobs[0])
	}
}
