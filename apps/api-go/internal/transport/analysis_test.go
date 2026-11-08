package transport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/analysis"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestAnalysisRoutesStrictInputAndOwnership(t *testing.T) {
	owner := application.Actor{ID: "owner", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, owner.ID)
	book, err := m.Mutate(context.Background(), owner, "", "create", application.StructureInput{Operation: "create"})
	if err != nil {
		t.Fatal(err)
	}
	actor := &owner
	h := Handler(Options{
		Management: m, Service: m.Legacy,
		ResolveActor: func(*http.Request) *application.Actor { return actor },
		AnalysisFor:  func(app *application.Service) *analysis.Service { return analysis.New(app, llm.Config{MaxContextBytes: 12000, MaxOutputTokens: 2048}) },
	})
	call := func(method, path, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Idempotency-Key", "transport-key")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		return w
	}
	path := "/v1/studio/books/" + book.ID + "/analysis"
	view := call("GET", path, "", 200)
	if !strings.Contains(view.Body.String(), `"job":null`) {
		t.Fatalf("empty view: %s", view.Body.String())
	}
	created := call("POST", path, `{}`, 200)
	if !strings.Contains(created.Body.String(), `"status":"queued"`) {
		t.Fatalf("create: %s", created.Body.String())
	}
	call("POST", path, `{"chapterIds":["CH-000001"],"ownerId":"other"}`, 422)
	call("POST", path, `not json`, 422)
	call("POST", path+"/pause", `{}`, 200)
	call("POST", path+"/resume", `{}`, 200)
	call("POST", path+"/cancel", `{}`, 200)
	call("POST", path+"/findings/find-000000000000000000000000/decision", `{"decision":"maybe"}`, 422)
	call("GET", path+"/unknown", "", 404)
	actor = nil
	call("GET", path, "", 401)
	actor = &application.Actor{ID: "other", Role: "author"}
	call("GET", path, "", 404)
	actor = &application.Actor{ID: "owner", Role: "agent"}
	call("GET", path, "", 403)
}

func TestAnalysisUnavailableWithoutExecutor(t *testing.T) {
	owner := application.Actor{ID: "owner", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, owner.ID)
	book, err := m.Mutate(context.Background(), owner, "", "create", application.StructureInput{Operation: "create"})
	if err != nil {
		t.Fatal(err)
	}
	h := Handler(Options{Management: m, Service: m.Legacy, ResolveActor: func(*http.Request) *application.Actor { return &owner }})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/v1/studio/books/"+book.ID+"/analysis", nil))
	if w.Code != 503 {
		t.Fatalf("expected 503, got %d %s", w.Code, w.Body.String())
	}
}
