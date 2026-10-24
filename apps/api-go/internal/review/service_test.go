package review

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

var testAuthor = application.Actor{ID: "fixture-author", Role: "author"}

type fakeModel struct {
	calls    atomic.Int32
	generate func(context.Context, llm.Request) (llm.Response, error)
}

func (f *fakeModel) Generate(ctx context.Context, r llm.Request) (llm.Response, error) {
	f.calls.Add(1)
	return f.generate(ctx, r)
}
func writeFixture(t *testing.T, root, path, text string) {
	t.Helper()
	p := filepath.Join(root, path)
	if e := os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(p, []byte(text), 0600); e != nil {
		t.Fatal(e)
	}
}
func testService(t *testing.T, fn func(context.Context, llm.Request) (llm.Response, error)) (*Service, *fakeModel) {
	t.Helper()
	root := t.TempDir()
	writeFixture(t, root, "manuscript/CH-003.md", "# 历史记录\nID: CH-003\norder: 3\n\n林舟从未到过北港。\n")
	writeFixture(t, root, "manuscript/CH-004.md", "# 事件记录\nID: CH-004\norder: 4\n\n抵达记录：三月三日。\n")
	writeFixture(t, root, "manuscript/CH-008.md", "# 当前记录\nID: CH-008\norder: 8\n\n😀林舟到过北港。\n")
	writeFixture(t, root, "inbox/accepted.md", "作者确认的隔离测试资料。\n")
	writeFixture(t, root, "book/characters/CHAR-001.md", "# 可靠身份\nID: CHAR-001\nstatus: confirmed\nsource: inbox/accepted.md\n\n林舟是一名抄录员。\n")
	writeFixture(t, root, "book/characters/CHAR-002.md", "# 未确认身份\nID: CHAR-002\nstatus: confirmed（部分）\nsource: inbox/accepted.md\n\n尚未确认的测试身份。\n")
	writeFixture(t, root, "proposals/P-001.md", "# 候选\nID: P-001\nstatus: confirmed\nsource: inbox/accepted.md\n\n候选不能成为正式事实。\n")
	if fn == nil {
		fn = func(context.Context, llm.Request) (llm.Response, error) {
			return llm.Response{Text: validOutput()}, nil
		}
	}
	fake := &fakeModel{generate: fn}
	app := &application.Service{Root: root, State: t.TempDir(), Project: "fixture/中文"}
	config := llm.Config{Provider: "openai-compatible", BaseURL: "http://127.0.0.1:11434/v1", Model: "fake-test-only", ResponseFormat: "none", TokenParameter: "max_completion_tokens", Timeout: time.Second, MaxContextBytes: 16000, MaxOutputTokens: 2048, MaxResponseBytes: 256 * 1024}
	s := New(app, config, fake)
	t.Cleanup(s.Close)
	return s, fake
}
func validCandidate() map[string]any {
	return map[string]any{"type": "character_consistency", "title": "经历可能存在差异", "inference": "这是需要作者判断的候选推断，不能据此认定错误。", "question": "是否属于有意安排的信息差异？", "alternativeExplanation": "可能是人物说谎、回忆差异或成长，并非客观事实冲突。", "evidence": []map[string]string{{"sourceId": "chapter:CH-008", "quote": "林舟到过北港。"}, {"sourceId": "chapter:CH-003", "quote": "林舟从未到过北港。"}}}
}
func validOutput() string {
	b, _ := json.Marshal(map[string]any{"findings": []any{validCandidate()}})
	return string(b)
}
func plan(t *testing.T, s *Service) Plan {
	t.Helper()
	c, e := s.App.Source("CH-008")
	if e != nil {
		t.Fatal(e)
	}
	r, e := s.App.ReviewRevision(context.Background(), c)
	if e != nil {
		t.Fatal(e)
	}
	p, e := s.Preview(context.Background(), testAuthor, c.ID, Input{r.ID, r.Hash, []string{"character_consistency"}})
	if e != nil {
		t.Fatal(e)
	}
	return p
}
func creation(p Plan) CreateInput {
	v := CreateInput{Input: p.Input}
	v.Consent.Confirmed = true
	v.Consent.PlanHash = p.PlanHash
	return v
}
func start(t *testing.T, s *Service, p Plan, key string) Run {
	t.Helper()
	r, e := s.Start(context.Background(), testAuthor, p.ChapterID, key, creation(p))
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func finish(t *testing.T, s *Service, r Run) Run {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		value, e := s.Get(context.Background(), testAuthor, r.RunID)
		if e != nil {
			t.Fatal(e)
		}
		if value.Status != "running" {
			if value.Status == "queued" {
				continue
			}
			return value
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("review did not finish")
	return Run{}
}
func code(e error) string {
	var p *application.Error
	if errors.As(e, &p) {
		return p.Code
	}
	return ""
}
func TestReviewSnapshotsFeedbackAndStaleness(t *testing.T) {
	s, fake := testService(t, nil)
	p := plan(t, s)
	if p.ExcludedKnowledgeCount != 1 || p.ContextBytes > p.BudgetBytes {
		t.Fatal("context bounds/confirmation rules", p.ExcludedKnowledgeCount)
	}
	for _, src := range p.Sources {
		if src.Kind == "confirmed_knowledge" && *src.DocumentID != "CHAR-001" {
			t.Fatal("unconfirmed knowledge selected")
		}
		if src.ProjectID != s.App.Project {
			t.Fatal("cross-project source")
		}
	}
	in := creation(p)
	in.Consent.Confirmed = false
	if _, e := s.Start(context.Background(), testAuthor, p.ChapterID, "without-consent", in); code(e) != "REVIEW_CONSENT_REQUIRED" || fake.calls.Load() != 0 {
		t.Fatal(e)
	}
	r := start(t, s, p, "first")
	r = finish(t, s, r)
	if r.Status != "completed" || len(r.Findings) != 1 || r.Stale || r.RejectedCount != 0 {
		t.Fatalf("invalid result: %+v", r)
	}
	a := r.Findings[0].Anchor
	if a.Start == nil || *a.Start != 2 || a.OffsetEncoding != "utf16" {
		t.Fatal("emoji offsets are not UTF-16", a)
	}
	repeated, e := s.Start(context.Background(), testAuthor, p.ChapterID, "first", creation(p))
	if e != nil || repeated.RunID != r.RunID || fake.calls.Load() != 1 {
		t.Fatal("duplicate model work", e)
	}
	input := FeedbackInput{Choice: "intentional", BaseVersion: r.Version}
	updated, e := s.Feedback(context.Background(), testAuthor, r.RunID, r.Findings[0].FindingID, "feedback-key", input)
	if e != nil {
		t.Fatal(e)
	}
	if updated.Findings[0].Feedback == nil || updated.Findings[0].Feedback.AuthorID != testAuthor.ID {
		t.Fatal("feedback not saved")
	}
	if _, e = s.Feedback(context.Background(), testAuthor, r.RunID, r.Findings[0].FindingID, "stale-feedback", FeedbackInput{"ignored", r.Version}); code(e) != "REVIEW_VERSION_CONFLICT" {
		t.Fatal(e)
	}
	if replay, e := s.Feedback(context.Background(), testAuthor, r.RunID, r.Findings[0].FindingID, "feedback-key", input); e != nil || replay.Version != updated.Version {
		t.Fatal("feedback replay", e)
	}
	if _, e = s.Feedback(context.Background(), testAuthor, r.RunID, r.Findings[0].FindingID, "feedback-key", FeedbackInput{"useful", updated.Version}); code(e) != "IDEMPOTENCY_KEY_REUSED" {
		t.Fatal(e)
	}
	reloaded := New(s.App, s.Config, nil)
	defer reloaded.Close()
	loaded, e := reloaded.Get(context.Background(), testAuthor, r.RunID)
	if e != nil || loaded.Findings[0].Feedback.Choice != "intentional" {
		t.Fatal("restart lost feedback", e)
	}
	rerun := finish(t, s, start(t, s, p, "explicit-rerun"))
	if rerun.RunID == r.RunID || fake.calls.Load() != 2 || rerun.Findings[0].Feedback != nil || rerun.StrategyVersion != StrategyVersion {
		t.Fatal("completed review could not be independently rerun")
	}
	if replay := start(t, s, p, "explicit-rerun"); replay.RunID != rerun.RunID || fake.calls.Load() != 2 {
		t.Fatal("rerun idempotency lost")
	}
	items, err := s.List(context.Background(), testAuthor, p.ChapterID)
	if err != nil || len(items) != 2 {
		t.Fatal("rerun erased history", err)
	}
	st, err := s.load()
	if err != nil || st.Runs[r.RunID].Findings[0].Feedback.Choice != "intentional" {
		t.Fatal("rerun erased prior author feedback", err)
	}
	legacy := st.Runs[r.RunID]
	legacy.StrategyVersion = ""
	st.Runs[r.RunID] = legacy
	if err := storage.Write(context.Background(), s.path(), st); err != nil {
		t.Fatal(err)
	}
	if old, err := reloaded.Get(context.Background(), testAuthor, r.RunID); err != nil || old.StrategyVersion != LegacyStrategyVersion || old.Findings[0].Feedback.Choice != "intentional" {
		t.Fatal("legacy strategy attribution lost", err)
	}
	writeFixture(t, s.App.Root, "manuscript/CH-003.md", "# 历史记录\nID: CH-003\norder: 3\n\n其他工具修改过的记录。\n")
	stale, e := s.Get(context.Background(), testAuthor, r.RunID)
	if e != nil || !stale.Stale {
		t.Fatal("changed historical source not stale", e)
	}
	if stale.Findings[0].Evidence[1].Quote != "林舟从未到过北港。" {
		t.Fatal("old snapshot overwritten")
	}
}
func TestCandidateEvidenceAndSchemaRejections(t *testing.T) {
	cases := []struct {
		name           string
		change         func(map[string]any)
		raw            string
		status, reason string
	}{
		{name: "fabricated chapter", change: func(c map[string]any) { c["evidence"].([]map[string]string)[1]["sourceId"] = "chapter:CH-999" }, status: "completed", reason: "unknown_source"},
		{name: "fabricated quote", change: func(c map[string]any) { c["evidence"].([]map[string]string)[1]["quote"] = "不存在的原文" }, status: "completed", reason: "quote_missing"},
		{name: "wrong source", change: func(c map[string]any) { c["evidence"].([]map[string]string)[1]["quote"] = "林舟到过北港。" }, status: "completed", reason: "quote_missing"},
		{name: "unconfirmed knowledge", change: func(c map[string]any) { c["evidence"].([]map[string]string)[1]["sourceId"] = "knowledge:CHAR-002" }, status: "completed", reason: "unknown_source"},
		{name: "tool injection", change: func(c map[string]any) {
			c["action"] = map[string]string{"tool": "write_file", "path": "manuscript/CH-008.md", "replacement": "untrusted"}
		}, status: "failed", reason: "LLM_INVALID_OUTPUT"},
		{name: "path injection", change: func(c map[string]any) { c["path"] = "../../other-project/chapter.md" }, status: "failed", reason: "LLM_INVALID_OUTPUT"},
		{name: "missing alternative", change: func(c map[string]any) { delete(c, "alternativeExplanation") }, status: "failed", reason: "LLM_INVALID_OUTPUT"},
		{name: "unrequested type", change: func(c map[string]any) { c["type"] = "timeline_consistency" }, status: "completed", reason: "unrequested_review_type"},
		{name: "missing target", change: func(c map[string]any) {
			c["evidence"] = []map[string]string{{"sourceId": "chapter:CH-003", "quote": "林舟从未到过北港。"}, {"sourceId": "chapter:CH-004", "quote": "抵达记录：三月三日。"}}
		}, status: "completed", reason: "missing_target"},
		{name: "invalid JSON", raw: "not JSON", status: "failed", reason: "LLM_INVALID_OUTPUT"},
		{name: "trailing JSON", raw: `{"findings":[]} {}`, status: "failed", reason: "LLM_INVALID_OUTPUT"},
		{name: "null findings", raw: `{"findings":null}`, status: "failed", reason: "LLM_INVALID_OUTPUT"},
		{name: "empty findings", raw: `{"findings":[]}`, status: "completed"},
		{name: "large output", raw: strings.Repeat("x", 64*1024+1), status: "failed", reason: "LLM_INVALID_OUTPUT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := validCandidate()
			if tc.change != nil {
				tc.change(c)
			}
			b, _ := json.Marshal(map[string]any{"findings": []any{c}})
			output := string(b)
			if tc.raw != "" {
				output = tc.raw
			}
			s, _ := testService(t, func(context.Context, llm.Request) (llm.Response, error) { return llm.Response{Text: output}, nil })
			before, _ := os.ReadFile(filepath.Join(s.App.Root, "manuscript/CH-008.md"))
			r := finish(t, s, start(t, s, plan(t, s), "test"))
			if r.Status != tc.status || len(r.Findings) != 0 {
				t.Fatal(r.Status, r.Findings)
			}
			if tc.reason != "" {
				if tc.status == "failed" {
					if r.FailureCode == nil || *r.FailureCode != tc.reason {
						t.Fatal(r.FailureCode)
					}
				} else if r.RejectedCount != 1 || r.RejectionReasons[0] != tc.reason {
					t.Fatal(r.RejectionReasons)
				}
			}
			after, _ := os.ReadFile(filepath.Join(s.App.Root, "manuscript/CH-008.md"))
			if string(before) != string(after) {
				t.Fatal("model modified manuscript")
			}
		})
	}
}
func TestRepeatedQuoteHashAndVersionGuards(t *testing.T) {
	s, fake := testService(t, nil)
	writeFixture(t, s.App.Root, "manuscript/CH-008.md", "# 当前记录\nID: CH-008\norder: 8\n\n😀林舟到过北港。\n\n林舟到过北港。\n")
	p := plan(t, s)
	r := finish(t, s, start(t, s, p, "ambiguous"))
	if r.Findings[0].Anchor.Status != "ambiguous" || r.Findings[0].Anchor.Start != nil {
		t.Fatal("picked first repeated text")
	}
	corrupt := p
	corrupt.Sources = append([]Source{}, p.Sources...)
	corrupt.Sources[0].ExcerptHash = "sha256:bad"
	findings, reasons, e := Validate(corrupt, validOutput())
	if e != nil || len(findings) != 0 || reasons[0] != "invalid_source_hash" {
		t.Fatal(e, reasons)
	}
	wrong := p.Input
	wrong.RevisionID = "other-revision"
	if _, e = s.Preview(context.Background(), testAuthor, p.ChapterID, wrong); code(e) != "REVIEW_REVISION_CHANGED" {
		t.Fatal(e)
	}
	before := fake.calls.Load()
	writeFixture(t, s.App.Root, "book/characters/CHAR-001.md", "# 可靠身份\nID: CHAR-001\nstatus: confirmed\nsource: inbox/accepted.md\n\n外部更新后的知识。\n")
	if _, e = s.Start(context.Background(), testAuthor, p.ChapterID, "changed-consent", creation(p)); code(e) != "REVIEW_CONTEXT_CHANGED" || fake.calls.Load() != before {
		t.Fatal("sent changed scope without consent", e)
	}
	current := plan(t, s)
	s.Config.Model = "different-model"
	if _, e = s.Start(context.Background(), testAuthor, current.ChapterID, "model-changed", creation(current)); code(e) != "REVIEW_CONTEXT_CHANGED" {
		t.Fatal(e)
	}
}
func TestReviewReadsDraftWithoutWritingItAndMarksLocalRevisionStale(t *testing.T) {
	s, _ := testService(t, nil)
	c, _ := s.App.Source("CH-008")
	revision, _ := s.App.ReviewRevision(context.Background(), c)
	k := "author-save"
	saved, e := s.App.Save(context.Background(), testAuthor, c.ID, "author-request", map[string]any{"baseRevisionId": revision.ID, "markdown": "😀林舟到过北港。\n作者新增的测试记录。"}, &k)
	if e != nil {
		t.Fatal(e)
	}
	draft := filepath.Join(s.App.State, "chapter-drafts", compat.Key(s.App.Project), compat.Key(c.ID)+".json")
	before, _ := os.ReadFile(draft)
	p := plan(t, s)
	if p.RevisionID != saved.Revision.ID {
		t.Fatal("review ignored saved application revision")
	}
	r := finish(t, s, start(t, s, p, "draft-review"))
	after, _ := os.ReadFile(draft)
	if string(before) != string(after) {
		t.Fatal("review rewrote draft")
	}
	k2 := "author-save-again"
	_, e = s.App.Save(context.Background(), testAuthor, c.ID, "author-request-2", map[string]any{"baseRevisionId": p.RevisionID, "markdown": "作者自己修改后的测试记录。"}, &k2)
	if e != nil {
		t.Fatal(e)
	}
	stale, e := s.Get(context.Background(), testAuthor, r.RunID)
	if e != nil || !stale.Stale {
		t.Fatal("new saved version did not stale old review", e)
	}
	retry, e := s.Start(context.Background(), testAuthor, c.ID, "draft-review", creation(p))
	if e != nil || retry.RunID != r.RunID || !retry.Stale {
		t.Fatal("idempotent old-key retry failed after edit", e)
	}
}
func TestContextBudgetAndKnowledgeIsolation(t *testing.T) {
	s, fake := testService(t, nil)
	for i := 9; i < 15; i++ {
		writeFixture(t, s.App.Root, fmt.Sprintf("book/characters/CHAR-%03d.md", i), "# Unknown\nstatus: unknown\n\nNot a confirmed fact.\n")
	}
	p := plan(t, s)
	for _, src := range p.Sources {
		if strings.Contains(src.Path, "proposals/") || src.Kind == "confirmed_knowledge" && *src.DocumentID != "CHAR-001" {
			t.Fatal("source isolation failed")
		}
	}
	s.Config.MaxContextBytes = 2048
	if _, e := s.BuildPlan(context.Background(), p.ChapterID, p.Input); code(e) != "REVIEW_CONTEXT_TOO_LARGE" || fake.calls.Load() != 0 {
		t.Fatal(e)
	}
	s.Client = nil
	if _, e := s.BuildPlan(context.Background(), p.ChapterID, p.Input); code(e) != "REVIEW_UNAVAILABLE" {
		t.Fatal(e)
	}
}
func TestDuplicateConcurrentRunsAndFeedbackCAS(t *testing.T) {
	gate := make(chan struct{})
	var release sync.Once
	defer release.Do(func() { close(gate) })
	s, fake := testService(t, func(context.Context, llm.Request) (llm.Response, error) {
		<-gate
		return llm.Response{Text: validOutput()}, nil
	})
	s.Config.Timeout = 5 * time.Second
	p := plan(t, s)
	other := New(s.App, s.Config, fake)
	defer other.Close()
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			instance := s
			if i%2 != 0 {
				instance = other
			}
			r, e := instance.Start(context.Background(), testAuthor, p.ChapterID, "parallel-"+string(rune('a'+i)), creation(p))
			if e != nil {
				errs <- e
			} else {
				ids <- r.RunID
			}
		}(i)
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	id := ""
	for value := range ids {
		if id != "" && id != value {
			t.Fatal("duplicate runs")
		}
		id = value
	}
	release.Do(func() { close(gate) })
	r := finish(t, s, Run{RunID: id})
	if fake.calls.Load() != 1 {
		t.Fatal("duplicate model calls", fake.calls.Load())
	}
	successes := atomic.Int32{}
	conflicts := atomic.Int32{}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			instance := s
			if i == 1 {
				instance = other
			}
			_, e := instance.Feedback(context.Background(), testAuthor, id, r.Findings[0].FindingID, "parallel-feedback-"+string(rune('a'+i)), FeedbackInput{"useful", r.Version})
			if e == nil {
				successes.Add(1)
			} else if code(e) == "REVIEW_VERSION_CONFLICT" {
				conflicts.Add(1)
			} else {
				t.Error(e)
			}
		}(i)
	}
	wg.Wait()
	if successes.Load() != 1 || conflicts.Load() != 1 {
		t.Fatal(successes.Load(), conflicts.Load())
	}
}
func TestCancellationTimeoutAndProjectConcurrency(t *testing.T) {
	gate := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(gate) })
	s, fake := testService(t, func(context.Context, llm.Request) (llm.Response, error) {
		<-gate
		return llm.Response{Text: validOutput()}, nil
	})
	p := plan(t, s)
	r := start(t, s, p, "cancel")
	for fake.calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	second := p
	second.ReviewTypes = []string{"timeline_consistency"}
	secondPlan, e := s.BuildPlan(context.Background(), p.ChapterID, second.Input)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Start(context.Background(), testAuthor, p.ChapterID, "busy", creation(secondPlan)); code(e) != "REVIEW_BUSY" {
		t.Fatal(e)
	}
	canceled, e := s.Cancel(context.Background(), testAuthor, r.RunID, "cancel-key")
	if e != nil || canceled.Status != "cancelled" {
		t.Fatal(e)
	}
	once.Do(func() { close(gate) })
	s.wg.Wait()
	final, e := s.Get(context.Background(), testAuthor, r.RunID)
	if e != nil || final.Status != "cancelled" || len(final.Findings) != 0 {
		t.Fatal("late model result replaced cancellation", e)
	}
	// A queued worker can start after cancellation. Its cancelled job context is
	// not a storage failure and must not make the persisted cancellation unreadable.
	queuedCtx, cancelQueued := context.WithCancel(context.Background())
	cancelQueued()
	s.wg.Add(1)
	s.execute(queuedCtx, func() {}, final)
	if queued, err := s.Get(context.Background(), testAuthor, r.RunID); err != nil || queued.Status != "cancelled" {
		t.Fatal("cancelled preflight was reported as storage failure", err)
	}
	timed, _ := testService(t, func(ctx context.Context, _ llm.Request) (llm.Response, error) {
		<-ctx.Done()
		return llm.Response{}, ctx.Err()
	})
	timed.Config.Timeout = 20 * time.Millisecond
	result := finish(t, timed, start(t, timed, plan(t, timed), "timeout"))
	if result.FailureCode == nil || *result.FailureCode != "LLM_TIMEOUT" {
		t.Fatal(result.FailureCode)
	}
}
func TestStorageFailureNeverReportsCompletedAndInterruptedRunsRecover(t *testing.T) {
	s, _ := testService(t, nil)
	var writes atomic.Int32
	s.write = func(ctx context.Context, path string, v any) error {
		if writes.Add(1) > 1 {
			return os.ErrPermission
		}
		return storage.Write(ctx, path, v)
	}
	p := plan(t, s)
	r := start(t, s, p, "write-failure")
	s.wg.Wait()
	if _, e := s.Get(context.Background(), testAuthor, r.RunID); code(e) != "REVIEW_STORAGE_FAILED" {
		t.Fatal("false saved result", e)
	}
	st, e := s.load()
	if e != nil {
		t.Fatal(e)
	}
	saved := st.Runs[r.RunID]
	if saved.Status == "completed" {
		t.Fatal("failed persist reported success")
	}
	saved.DeadlineAt = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
	st.Runs[r.RunID] = saved
	if e = storage.Write(context.Background(), s.path(), st); e != nil {
		t.Fatal(e)
	}
	restarted := New(s.App, s.Config, nil)
	defer restarted.Close()
	recovered, e := restarted.Get(context.Background(), testAuthor, r.RunID)
	if e != nil || recovered.Status != "queued" || recovered.Lease != "" {
		t.Fatal("unclaimed work must remain queued after a failed claim write", recovered.Status, e)
	}
	// Preserve recovery of pre-protocol running records, without replaying their model call.
	saved.Status = "running"
	saved.Lease = ""
	saved.ExecutorOwner = ""
	saved.ExecutorEpoch = 0
	st.Runs[r.RunID] = saved
	if e = storage.Write(context.Background(), s.path(), st); e != nil {
		t.Fatal(e)
	}
	recovered, e = restarted.Get(context.Background(), testAuthor, r.RunID)
	if e != nil || recovered.Status != "failed" || recovered.FailureCode == nil || *recovered.FailureCode != "REVIEW_INTERRUPTED" {
		t.Fatal(recovered.Status, e)
	}
}

func TestExcerptKeepsRawUnicodeOffsets(t *testing.T) {
	body := strings.Repeat("Ⱥ", 1000) + "测试事实" + strings.Repeat("。", 1000)
	text, offset := excerpt(body, []string{"测试"}, 1800)
	if !strings.Contains(text, "测试事实") || len(text) > 1800 || offset <= 0 || !utf8.ValidString(text) {
		t.Fatal("excerpt lost the raw Unicode match", offset)
	}
}

func TestReviewHashContract(t *testing.T) {
	for _, value := range []string{"", "sha256:" + strings.Repeat("g", 64), "sha256:" + strings.Repeat("A", 64)} {
		if validHash(value) {
			t.Fatal("invalid hash accepted", value)
		}
		_, err := normalize(Input{RevisionID: "saved", ContentHash: value, ReviewTypes: []string{"timeline_consistency"}})
		if code(err) != "VALIDATION_FAILED" {
			t.Fatal("hash contract not enforced", err)
		}
	}
	if !validHash("sha256:" + strings.Repeat("a", 64)) {
		t.Fatal("valid hash refused")
	}
}

func TestHistoryUsesDirectoryVolumeOrder(t *testing.T) {
	s, _ := testService(t, nil)
	for _, c := range []struct{ id, volume, order string }{
		{"CH-003", "VOL-1", "10"},
		{"CH-004", "VOL-1", "11"},
		{"CH-008", "VOL-2", "1"},
		{"CH-009", "VOL-2", "2"},
		{"CH-010", "VOL-3", "1"},
	} {
		writeFixture(t, s.App.Root, "manuscript/"+c.id+".md", "# "+c.id+"\nID: "+c.id+"\nvolumeId: "+c.volume+"\norder: "+c.order+"\n\n相同相关词。\n")
	}
	for _, tc := range []struct {
		target string
		want   []string
	}{
		{"CH-003", []string{}},
		{"CH-004", []string{"CH-003"}},
		{"CH-008", []string{"CH-004", "CH-003"}},
		{"CH-009", []string{"CH-008", "CH-004", "CH-003"}},
	} {
		c, err := s.App.Source(tc.target)
		if err != nil {
			t.Fatal(err)
		}
		r, err := s.App.ReviewRevision(context.Background(), c)
		if err != nil {
			t.Fatal(err)
		}
		p, err := s.BuildPlan(context.Background(), tc.target, Input{r.ID, r.Hash, []string{"character_consistency"}})
		if err != nil {
			t.Fatal(err)
		}
		got := []string{}
		for _, src := range p.Sources {
			if src.Kind == "historical_chapter" {
				got = append(got, *src.ChapterID)
			}
		}
		if fmt.Sprint(got) != fmt.Sprint(tc.want) {
			t.Fatalf("%s: history %v, want %v", tc.target, got, tc.want)
		}
	}
}
