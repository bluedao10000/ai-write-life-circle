package transport

import (
	"context"
	"encoding/json"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestKnowledgeOwnershipPrivateNoStoreAndStrictInput(t *testing.T) {
	owner := application.Actor{ID: "owner", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, owner.ID)
	b, e := m.Mutate(context.Background(), owner, "", "create", application.StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	actor := &owner
	h := Handler(Options{Management: m, Service: m.Legacy, ResolveActor: func(*http.Request) *application.Actor { return actor }, KnowledgeFor: func(app *application.Service) *knowledge.Service { return knowledge.New(app, llm.Config{}, nil) }})
	call := func(method, path, body string, want int) {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Idempotency-Key", "test-key")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	path := "/v1/studio/books/" + b.ID + "/knowledge"
	call("GET", path, "", 200)
	actor = nil
	call("GET", path, "", 401)
	actor = &application.Actor{ID: "other", Role: "author"}
	call("GET", path, "", 404)
	actor = &application.Actor{ID: "owner", Role: "agent"}
	call("GET", path, "", 403)
	actor = &owner
	call("POST", path+"/enable", `{"baseVersion":0,"ownerId":"other"}`, 422)
	call("GET", path+"?limit=1000", "", 422)
	call("GET", path+"/related", "", 422)
	call("POST", path+"/rebuild", `{"baseVersion":0}`, 422)
}

func TestKnowledgeSummaryAndBoundedRecordPage(t *testing.T) {
	owner := application.Actor{ID: "owner", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, owner.ID)
	b, e := m.Mutate(context.Background(), owner, "", "create", application.StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	h := Handler(Options{
		Management: m,
		Service:    m.Legacy,
		ResolveActor: func(*http.Request) *application.Actor {
			return &owner
		},
		KnowledgeFor: func(app *application.Service) *knowledge.Service {
			return knowledge.New(app, llm.Config{}, nil)
		},
	})

	summary := httptest.NewRecorder()
	h.ServeHTTP(summary, httptest.NewRequest(http.MethodGet, "/v1/studio/books/"+b.ID+"/knowledge/summary", nil))
	if summary.Code != http.StatusOK {
		t.Fatalf("summary status %d: %s", summary.Code, summary.Body.String())
	}
	var view map[string]any
	if e := json.Unmarshal(summary.Body.Bytes(), &view); e != nil || view["bookId"] != b.ID {
		t.Fatalf("summary: %v %+v", e, view)
	}
	if _, ok := view["entities"]; ok {
		t.Fatal("summary unexpectedly includes entity rows")
	}

	jobs := httptest.NewRecorder()
	h.ServeHTTP(jobs, httptest.NewRequest(http.MethodGet, "/v1/studio/books/"+b.ID+"/knowledge/jobs", nil))
	if jobs.Code != http.StatusOK {
		t.Fatalf("jobs status %d: %s", jobs.Code, jobs.Body.String())
	}
	var records map[string]any
	if e := json.Unmarshal(jobs.Body.Bytes(), &records); e != nil || records["total"] != float64(0) {
		t.Fatalf("jobs: %v %+v", e, records)
	}
	// Kept for one deployment window so an already-open older Web build can
	// continue reading record pages after the API rolls first.
	if _, ok := records["view"]; !ok {
		t.Fatal("record page lost rolling-deploy view compatibility")
	}
}
