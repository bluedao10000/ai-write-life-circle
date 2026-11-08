package analysis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

const fixtureBody = "林舟是医师。他在雨夜回到临安。"

type fixture struct {
	ctx  context.Context
	app  *application.Service
	book application.ManagedBook
	s    *Service
}

func newFixture(t *testing.T, chapters int) *fixture {
	t.Helper()
	ctx := context.Background()
	base := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	actor := application.Actor{ID: "author-one", Role: "author"}
	m := application.NewManagement(base, "author-one")
	book, err := m.Mutate(ctx, actor, "", "create", application.StructureInput{Operation: "create"})
	if err != nil {
		t.Fatal(err)
	}
	for len(book.Chapters) < chapters {
		book, err = m.Mutate(ctx, actor, book.ID, fmt.Sprintf("grow-%d", len(book.Chapters)), application.StructureInput{Operation: "chapter", BaseVersion: book.Version, Title: fmt.Sprintf("第%d章", len(book.Chapters)+1)})
		if err != nil {
			t.Fatal(err)
		}
	}
	app, err := m.Resolve(actor, book.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, chapter := range book.Chapters {
		source, err := app.Source(chapter.ID)
		if err != nil {
			t.Fatal(err)
		}
		head, err := app.Head(ctx, source)
		if err != nil {
			t.Fatal(err)
		}
		key := "save-" + chapter.ID
		if _, err := app.Save(ctx, actor, chapter.ID, "fixture-"+chapter.ID, map[string]any{"baseRevisionId": head.ID, "markdown": fixtureBody + chapter.Title}, &key); err != nil {
			t.Fatal(err)
		}
	}
	cfg := llm.Config{Provider: "openai-compatible", BaseURL: "http://127.0.0.1:9999", Model: "fixture", ResponseFormat: "json_object", TokenParameter: "max_tokens", Timeout: 5 * time.Second, MaxContextBytes: 12000, MaxOutputTokens: 2048, MaxResponseBytes: 256 * 1024}
	return &fixture{ctx: ctx, app: app, book: book, s: New(app, cfg)}
}

func (f *fixture) resave(t *testing.T, chapterID, body string) {
	t.Helper()
	source, err := f.app.Source(chapterID)
	if err != nil {
		t.Fatal(err)
	}
	head, err := f.app.Head(f.ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	key := "resave-" + chapterID
	if _, err := f.app.Save(f.ctx, application.Actor{ID: "author-one", Role: "author"}, chapterID, "resave-"+chapterID, map[string]any{"baseRevisionId": head.ID, "markdown": body}, &key); err != nil {
		t.Fatal(err)
	}
}

func chapterJSON(t *testing.T, view View) []map[string]any {
	t.Helper()
	raw, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Findings []map[string]any `json:"findings"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out.Findings
}

func TestCreateBatchesIdempotencyAndControls(t *testing.T) {
	f := newFixture(t, 6)
	view, err := f.s.Create(f.ctx, "analysis-key", nil)
	if err != nil {
		t.Fatal(err)
	}
	if view.Job == nil || view.Manifest == nil || len(view.Manifest.Chapters) != 6 {
		t.Fatalf("manifest not frozen: %+v", view)
	}
	if len(view.Job.Batches) != 2 || len(view.Job.Batches[0].ChapterIDs) != 4 || len(view.Job.Batches[1].ChapterIDs) != 2 {
		t.Fatalf("expected a 4+2 split, got %+v", view.Job.Batches)
	}
	if view.Job.Status != "queued" || view.Job.Progress.Pending != 2 {
		t.Fatalf("unexpected initial job: %+v", view.Job)
	}
	again, err := f.s.Create(f.ctx, "analysis-key", nil)
	if err != nil || again.Job.AnalysisID != view.Job.AnalysisID {
		t.Fatalf("idempotent create: %+v %v", again.Job, err)
	}
	if _, err := f.s.Create(f.ctx, "analysis-key", []string{view.Manifest.Chapters[0].ChapterID}); err == nil {
		t.Fatal("reused idempotency key for a different manifest")
	}
	if paused, err := f.s.Pause(f.ctx); err != nil || paused.Job.Status != "paused" {
		t.Fatalf("pause: %+v %v", paused.Job, err)
	}
	if resumed, err := f.s.Resume(f.ctx); err != nil || resumed.Job.Status != "running" {
		t.Fatalf("resume: %+v %v", resumed.Job, err)
	}
	cancelled, err := f.s.Cancel(f.ctx)
	if err != nil || cancelled.Job.Status != "cancelled" {
		t.Fatalf("cancel: %+v %v", cancelled.Job, err)
	}
	if claim, err := f.s.Claim(f.ctx); err != nil || claim != nil {
		t.Fatalf("cancelled job claimed: %+v %v", claim, err)
	}
}

func TestChapterAndSynthesisCandidatesPersistWithEvidence(t *testing.T) {
	f := newFixture(t, 2)
	view, err := f.s.Create(f.ctx, "analysis-key", nil)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := f.s.Claim(f.ctx)
	if err != nil || claim == nil {
		t.Fatalf("claim: %+v %v", claim, err)
	}
	prepared, err := f.s.Prepare(f.ctx, claim)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(prepared.Request.System, "章节分析组") || prepared.Request.SchemaName != "novel-analysis-candidates-v1" {
		t.Fatalf("unexpected chapter request: %+v", prepared.Request)
	}
	for _, chapter := range claim.Manifest.Chapters {
		if !strings.Contains(prepared.Request.Input, chapter.ChapterID) {
			t.Fatalf("chapter %s missing from batch input", chapter.ChapterID)
		}
	}
	output := `{"findings":[
		{"kind":"character","title":"林舟身份","statement":"林舟是医师。","confidence":0.9,"entityNames":["林舟"],"evidence":[{"chapterId":"CH-000001","quote":"林舟是医师。"}]},
		{"kind":"event","title":"伪造引文","statement":"不应保存。","confidence":0.5,"evidence":[{"chapterId":"CH-000001","quote":"正文里没有这句话。"}]},
		{"kind":"event","title":"越界章节","statement":"不应保存。","confidence":0.5,"evidence":[{"chapterId":"CH-000001","quote":"第二章"}]}
	],"entities":[{"kind":"character","name":"林舟","aliases":["林大夫"],"description":"医师","attributes":{"身份":"医师"}}]}`
	if err := f.s.Complete(f.ctx, prepared, llm.Response{Text: output}, true, nil); err != nil {
		t.Fatal(err)
	}
	view, err = f.s.View(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Findings) != 1 || view.Findings[0].Kind != "character" || len(view.Findings[0].Evidence) != 1 {
		t.Fatalf("evidence validation kept the wrong findings: %+v", view.Findings)
	}
	evidence := view.Findings[0].Evidence[0]
	if evidence.Start != 0 || evidence.End != len([]rune("林舟是医师。")) || evidence.RevisionID == "" || evidence.ContentHash == "" {
		t.Fatalf("evidence offsets not frozen: %+v", evidence)
	}
	if len(view.Entities) != 1 || view.Entities[0].State != "observed" || view.Entities[0].Name != "林舟" {
		t.Fatalf("entity not observed: %+v", view.Entities)
	}
	if view.Job.SynthesisStatus != "pending" || view.Job.Status != "running" || len(view.Job.Batches) != 2 {
		t.Fatalf("synthesis not queued: %+v", view.Job)
	}

	synthesisClaim, err := f.s.Claim(f.ctx)
	if err != nil || synthesisClaim == nil || synthesisClaim.Batch.Phase != "synthesis" {
		t.Fatalf("synthesis claim: %+v %v", synthesisClaim, err)
	}
	synthesis, err := f.s.Prepare(f.ctx, synthesisClaim)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(synthesis.Request.Input, fixtureBody) || !strings.Contains(synthesis.Request.Input, "林舟身份") {
		t.Fatalf("synthesis must receive findings only: %s", synthesis.Request.Input)
	}
	synthesisOutput := `{"findings":[{"kind":"conflict","title":"时间线冲突","statement":"同一引文被指为冲突。","confidence":0.7,"evidence":[{"chapterId":"CH-000001","quote":"林舟是医师。"}]}],"entities":[]}`
	if err := f.s.Complete(f.ctx, synthesis, llm.Response{Text: synthesisOutput}, true, nil); err != nil {
		t.Fatal(err)
	}
	view, err = f.s.View(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Findings) != 2 || view.Job.Status != "completed" || view.Job.SynthesisStatus != "completed" {
		t.Fatalf("synthesis not persisted: %+v %+v", view.Job, view.Findings)
	}
	confirmed, err := f.s.Decide(f.ctx, view.Findings[0].FindingID, "confirm", "确认")
	if err != nil {
		t.Fatal(err)
	}
	if confirmed.Findings[0].Status != "author_confirmed" || confirmed.Entities[0].State != "author_confirmed" {
		t.Fatalf("confirm did not propagate: %+v", confirmed)
	}
	rejected, err := f.s.Decide(f.ctx, view.Findings[1].FindingID, "reject", "")
	if err != nil || rejected.Findings[1].Status != "rejected" {
		t.Fatalf("reject: %+v %v", rejected.Findings, err)
	}
}

func TestRevisionChangeMarksBatchesAndFindingsStale(t *testing.T) {
	f := newFixture(t, 2)
	view, err := f.s.Create(f.ctx, "analysis-key", nil)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := f.s.Claim(f.ctx)
	if err != nil || claim == nil {
		t.Fatalf("claim: %+v %v", claim, err)
	}
	prepared, err := f.s.Prepare(f.ctx, claim)
	if err != nil {
		t.Fatal(err)
	}
	output := `{"findings":[{"kind":"character","title":"林舟身份","statement":"林舟是医师。","confidence":0.9,"evidence":[{"chapterId":"CH-000001","quote":"林舟是医师。"}]}],"entities":[]}`
	if err := f.s.Complete(f.ctx, prepared, llm.Response{Text: output}, true, nil); err != nil {
		t.Fatal(err)
	}
	f.resave(t, "CH-000001", "林舟改了行，去了建康。")
	view, err = f.s.View(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Findings) != 1 || view.Findings[0].Status != "stale" {
		t.Fatalf("finding not stale: %+v", view.Findings)
	}
	if view.Job.Status == "completed" || view.Job.SynthesisStatus != "pending" {
		t.Fatalf("stale finding still treated as complete: %+v", view.Job)
	}
	synthesisClaim, err := f.s.Claim(f.ctx)
	if err != nil || synthesisClaim == nil || synthesisClaim.Batch.Phase != "synthesis" {
		t.Fatalf("synthesis claim: %+v %v", synthesisClaim, err)
	}
	if _, err := f.s.Prepare(f.ctx, synthesisClaim); err == nil {
		t.Fatal("synthesis ran without surviving findings")
	}
	view, err = f.s.View(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if view.Job.SynthesisStatus != "failed" || view.Job.Status != "failed" {
		t.Fatalf("empty synthesis not recorded: %+v", view.Job)
	}
}

func TestPrepareRejectsChangedRevision(t *testing.T) {
	f := newFixture(t, 2)
	if _, err := f.s.Create(f.ctx, "analysis-key", nil); err != nil {
		t.Fatal(err)
	}
	claim, err := f.s.Claim(f.ctx)
	if err != nil || claim == nil {
		t.Fatalf("claim: %+v %v", claim, err)
	}
	f.resave(t, claim.Batch.ChapterIDs[0], "改过的正文。")
	_, err = f.s.Prepare(f.ctx, claim)
	var appErr *application.Error
	if !errors.As(err, &appErr) || appErr.Code != "ANALYSIS_REVISION_CHANGED" {
		t.Fatalf("expected revision mismatch, got %v", err)
	}
	view, err := f.s.View(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if view.Job.Progress.Stale != 1 {
		t.Fatalf("batch not marked stale: %+v", view.Job)
	}
}
