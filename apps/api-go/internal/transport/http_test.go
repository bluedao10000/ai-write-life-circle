package transport

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHTTPContractAndAuthority(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "manuscript"), 0700)
	source := "# Fixture\nID: CH-001\n\nBody 😀.\n"
	os.WriteFile(filepath.Join(root, "manuscript/CH-001.md"), []byte(source), 0600)
	s := &application.Service{Root: root, State: t.TempDir(), Project: "test"}
	handler := Handler(Options{Service: s, Environment: "development", ResolveActor: func(r *http.Request) *application.Actor {
		role := r.Header.Get("X-Test-Role")
		if role == "none" {
			return nil
		}
		if role == "" {
			role = "author"
		}
		return &application.Actor{ID: "writer", Role: role}
	}})
	cases := []struct {
		name, method, path, role, body, code string
		status                               int
	}{
		{"health", "GET", "/healthz", "none", "", "", 200},
		{"unknown", "GET", "/unknown", "", "", "NOT_FOUND", 404},
		{"project scope", "GET", "/v1/projects/other/workspace", "", "", "NOT_FOUND", 404},
		{"bad project encoding", "GET", "/v1/projects/%FF/workspace", "", "", "VALIDATION_FAILED", 400},
		{"anonymous", "GET", "/v1/projects/test/workspace", "none", "", "AUTHOR_DECISION_REQUIRED", 401},
		{"agent workspace", "GET", "/v1/projects/test/workspace", "agent", "", "AGENT_WRITE_FORBIDDEN", 403},
		{"system workspace", "GET", "/v1/projects/test/workspace", "system", "", "AUTHOR_DECISION_REQUIRED", 403},
		{"agent read chapter", "GET", "/v1/projects/test/chapters/CH-001", "agent", "", "", 200},
		{"agent denied history", "GET", "/v1/projects/test/chapters/CH-001/revisions", "agent", "", "AGENT_WRITE_FORBIDDEN", 403},
		{"agent denied save", "POST", "/v1/projects/test/chapters/CH-001/revisions", "agent", `{}`, "AGENT_WRITE_FORBIDDEN", 403},
		{"agent denied note", "POST", "/v1/projects/test/notes", "agent", `{"content":"a"}`, "AGENT_WRITE_FORBIDDEN", 403},
		{"invalid JSON", "POST", "/v1/projects/test/notes", "", `{bad`, "VALIDATION_FAILED", 422},
		{"trailing JSON", "POST", "/v1/projects/test/notes", "", `{"content":"a"} {}`, "VALIDATION_FAILED", 422},
		{"strict note", "POST", "/v1/projects/test/notes", "", `{"content":"a","canon":true}`, "VALIDATION_FAILED", 422},
		{"null is not missing", "POST", "/v1/projects/test/notes", "", `{"content":"a","purpose":null}`, "VALIDATION_FAILED", 422},
		{"missing associated chapter", "POST", "/v1/projects/test/notes", "", `{"content":"a","chapterId":"../../etc/passwd"}`, "NOT_FOUND", 404},
		{"note method", "DELETE", "/v1/projects/test/notes", "", "", "METHOD_NOT_ALLOWED", 405},
		{"workspace method", "DELETE", "/v1/projects/test/workspace", "", "", "NOT_FOUND", 404},
		{"invalid layout", "PATCH", "/v1/projects/test/workspace", "", `{"layout":{"rightW":561}}`, "VALIDATION_FAILED", 422},
		{"invalid page", "GET", "/v1/projects/test/chapters/CH-001/revisions?limit=201", "", "", "VALIDATION_FAILED", 422},
		{"encoded chapter slash", "GET", "/v1/projects/test/chapters/%2e%2e%2fetc%2fpasswd", "", "", "NOT_FOUND", 404},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
			r.Header.Set("X-Test-Role", c.role)
			r.Header.Set("Idempotency-Key", "test")
			r.Header.Set("X-Request-ID", "test-request")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != c.status {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("missing no-store")
			}
			if c.code != "" {
				var body map[string]any
				if e := compat.Decode(w.Body.Bytes(), &body); e != nil || body["code"] != c.code || w.Header().Get("Content-Type") != "application/problem+json" {
					t.Fatal(w.Body.String(), e)
				}
			}
			if c.name == "agent read chapter" && !strings.HasPrefix(w.Header().Get("ETag"), `"source:`) {
				t.Fatal("missing ETag")
			}
			if c.name == "agent denied save" && w.Header().Get("X-Request-ID") != "test-request" {
				t.Fatal("lost request correlation")
			}
		})
	}
	for _, environment := range []string{"test", "production", ""} {
		h := Handler(Options{Service: s, Environment: environment, ResolveActor: func(*http.Request) *application.Actor { return &application.Actor{ID: "writer", Role: "author"} }})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/internal/projects/test/harness-projection", nil))
		if w.Code != 404 {
			t.Fatal("diagnostic exposed in", environment)
		}
	}
	after, _ := os.ReadFile(filepath.Join(root, "manuscript/CH-001.md"))
	if string(after) != source {
		t.Fatal("Harness modified")
	}
}
func TestBoundedRequestBody(t *testing.T) {
	s := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "test"}
	h := Handler(Options{Service: s, ResolveActor: func(*http.Request) *application.Actor { return &application.Actor{ID: "writer", Role: "author"} }})
	request := httptest.NewRequest("POST", "/v1/projects/test/notes", strings.NewReader(`{"content":"`+strings.Repeat("x", int(MaxBodyBytes))+`"}`))
	request.Header.Set("Idempotency-Key", "large")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request)
	if w.Code != 422 {
		t.Fatal(w.Code)
	}
	if _, e := os.Stat(filepath.Join(s.State, "notes")); !os.IsNotExist(e) {
		t.Fatal("oversized request created state")
	}
}
