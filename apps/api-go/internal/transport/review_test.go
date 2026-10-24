package transport

import (
	"context"
	"encoding/json"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type reviewModelFunc func(context.Context, llm.Request) (llm.Response, error)

func (f reviewModelFunc) Generate(ctx context.Context, r llm.Request) (llm.Response, error) {
	return f(ctx, r)
}
func TestReviewHTTPAuthorizationConsentAndProjectIsolation(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "manuscript"), 0700)
	os.WriteFile(filepath.Join(root, "manuscript/CH-008.md"), []byte("# Fixture\nID: CH-008\n\nAuthor fixture.\n"), 0600)
	app := &application.Service{Root: root, State: t.TempDir(), Project: "project", ReviewsEnabled: true}
	var calls atomic.Int32
	cfg := llm.Config{Provider: "openai-compatible", BaseURL: "http://127.0.0.1:11434/v1", Model: "test-only", ResponseFormat: "none", TokenParameter: "max_tokens", Timeout: time.Second, MaxContextBytes: 16000}
	service := review.New(app, cfg, reviewModelFunc(func(context.Context, llm.Request) (llm.Response, error) {
		calls.Add(1)
		return llm.Response{Text: `{"findings":[]}`}, nil
	}))
	defer service.Close()
	handler := Handler(Options{Service: app, Reviews: service, Environment: "development", ResolveActor: func(r *http.Request) *application.Actor {
		v := r.Header.Get("X-Test-Role")
		if v == "none" {
			return nil
		}
		if v == "" {
			v = "author"
		}
		return &application.Actor{ID: "writer", Role: v}
	}})
	request := func(method, path, role, key string, body any) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, strings.NewReader(string(data)))
		r.Header.Set("X-Test-Role", role)
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	chapter, _ := app.Source("CH-008")
	revision, _ := app.ReviewRevision(context.Background(), chapter)
	input := review.Input{RevisionID: revision.ID, ContentHash: revision.Hash, ReviewTypes: []string{"character_consistency"}}
	previewPath := "/v1/projects/project/chapters/CH-008/review-preview"
	for _, tc := range []struct {
		path, role string
		status     int
	}{{previewPath, "none", 401}, {previewPath, "agent", 403}, {previewPath, "system", 403}, {"/v1/projects/other/chapters/CH-008/review-preview", "author", 404}} {
		w := request("POST", tc.path, tc.role, "", input)
		if w.Code != tc.status {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if calls.Load() != 0 {
		t.Fatal("authorization failure sent a model request")
	}
	w := request("POST", previewPath, "author", "", input)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var plan review.Plan
	if json.Unmarshal(w.Body.Bytes(), &plan) != nil {
		t.Fatal("invalid plan")
	}
	create := review.CreateInput{Input: input}
	create.Consent.PlanHash = plan.PlanHash
	path := "/v1/projects/project/chapters/CH-008/reviews"
	if w = request("POST", path, "author", "create", create); w.Code != 422 {
		t.Fatal("missing consent accepted")
	}
	create.Consent.Confirmed = true
	if w = request("POST", path, "author", "", create); w.Code != 422 {
		t.Fatal("missing key accepted")
	}
	w = request("POST", path, "author", "create", create)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var run review.Run
	json.Unmarshal(w.Body.Bytes(), &run)
	runPath := "/v1/projects/project/reviews/" + run.RunID
	for i := 0; i < 100; i++ {
		w = request("GET", runPath, "author", "", nil)
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
		json.Unmarshal(w.Body.Bytes(), &run)
		if run.Status != "running" && run.Status != "queued" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if run.Status != "completed" || calls.Load() != 1 {
		t.Fatal(run.Status, calls.Load())
	}
	if w = request("GET", strings.Replace(runPath, "/project/", "/other/", 1), "author", "", nil); w.Code != 404 {
		t.Fatal("cross project run leaked")
	}
	if w = request("GET", runPath, "agent", "", nil); w.Code != 403 {
		t.Fatal("agent read review")
	}
	if w = request("POST", runPath+"/findings/missing/feedback", "agent", "feedback", map[string]any{"choice": "useful", "baseVersion": run.Version}); w.Code != 403 {
		t.Fatal("agent changed feedback")
	}
	if w = request("POST", runPath+"/cancel", "author", "cancel", nil); w.Code != 409 {
		t.Fatal("completed review cancelled")
	}
	if w = request("GET", path, "author", "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), run.RunID) {
		t.Fatal("history not reloaded")
	}
	if w = request("DELETE", runPath, "author", "", nil); w.Code != 405 {
		t.Fatal("unknown method accepted")
	}
	// Unconfigured service remains readable, but cannot send a model request or claim an enabled capability.
	disabled := review.New(app, llm.Config{}, nil)
	defer disabled.Close()
	app.ReviewsEnabled = false
	disabledHandler := Handler(Options{Service: app, Reviews: disabled, ResolveActor: func(*http.Request) *application.Actor { return &application.Actor{ID: "writer", Role: "author"} }})
	r := httptest.NewRequest("POST", previewPath, strings.NewReader(string(mustJSON(input))))
	out := httptest.NewRecorder()
	disabledHandler.ServeHTTP(out, r)
	if out.Code != 503 {
		t.Fatal(out.Code, out.Body.String())
	}
	if _, e := disabled.Get(context.Background(), application.Actor{ID: "writer", Role: "author"}, run.RunID); e != nil {
		t.Fatal("disabled model hid historical reviews", e)
	}
}
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
