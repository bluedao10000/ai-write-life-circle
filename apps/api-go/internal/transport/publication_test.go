package transport

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/publication"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPublicationHTTPPermissionsAndContracts(t *testing.T) {
	app := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "book-a"}
	service := publication.New(t.TempDir(), map[string]publication.Book{"book-a": {App: app, OwnerID: "writer-a"}, "book-b": {App: app, OwnerID: "writer-b"}})
	handler := Handler(Options{Service: app, Environment: "test", Publications: service, ResolveActor: func(r *http.Request) *application.Actor {
		switch r.Header.Get("X-Test-Actor") {
		case "author":
			return &application.Actor{ID: "writer-a", Role: "author"}
		case "other":
			return &application.Actor{ID: "writer-b", Role: "author"}
		case "agent":
			return &application.Actor{ID: "writer-a", Role: "agent"}
		default:
			return nil
		}
	}})
	for _, tc := range []struct {
		method, path, actor, body string
		status                    int
	}{
		{"GET", "/v1/public/home", "", "", 200},
		{"GET", "/v1/public/books", "", "", 200},
		{"GET", "/v1/public/categories", "", "", 200},
		{"GET", "/v1/public/books?limit=101", "", "", 422},
		{"GET", "/v1/public/books?limit=1e2", "", "", 422},
		{"GET", "/v1/public/books?cursor=-1", "", "", 422},
		{"GET", "/v1/public/books?status=draft", "", "", 422},
		{"GET", "/v1/public/books/missing", "", "", 404},
		{"GET", "/v1/public/books/missing/chapters/secret", "", "", 404},
		{"GET", "/v1/public/authors/missing", "", "", 404},
		{"POST", "/v1/public/books", "author", "{}", 405},
		{"GET", "/v1/studio/books/book-a/publication", "", "", 401},
		{"GET", "/v1/studio/books/book-a/publication/versions", "other", "", 404},
		{"GET", "/v1/studio/books/book-a/publication", "agent", "", 403},
		{"POST", "/v1/studio/books/book-a/publication/preview", "", "{}", 401},
		{"POST", "/v1/studio/books/book-a/publication/versions", "agent", "{}", 403},
		{"POST", "/v1/studio/books/book-b/publication/unlist", "author", `{"baseVersionId":"x"}`, 404},
		{"POST", "/v1/studio/books/book-b/publication/relist", "author", `{"baseVersionId":"x"}`, 404},
		{"POST", "/v1/studio/books/book-a/publication/preview", "author", "null", 422},
		{"POST", "/v1/studio/books/book-a/publication/preview", "author", "{}", 422},
		{"POST", "/v1/studio/books/book-a/publication/versions", "author", `{"baseVersionId":null,"previewId":"missing","markdown":"private"}`, 422},
		{"POST", "/v1/studio/books/book-a/publication/versions", "author", `{"baseVersionId":null,"previewId":null}`, 422},
		{"GET", "/v1/studio/books/book-a/publication", "author", "", 200},
		{"GET", "/v1/studio/books/book-a/publication/versions", "author", "", 200},
	} {
		t.Run(tc.method+tc.path+tc.actor+tc.body, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			request.Header.Set("X-Test-Actor", tc.actor)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Idempotency-Key", "test-key")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, request)
			if rec.Code != tc.status {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("shared caching enabled")
			}
			if strings.Contains(rec.Body.String(), "writer-a") || strings.Contains(rec.Body.String(), "writer-b") || strings.Contains(rec.Body.String(), app.Root) {
				t.Fatal("private identity/path leaked")
			}
		})
	}
}
