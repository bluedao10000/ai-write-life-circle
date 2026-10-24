package transport

import (
	"context"
	"encoding/json"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagedTransportOwnershipAndRoutes(t *testing.T) {
	app := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	m := application.NewManagement(app, "owner")
	actor := application.Actor{ID: "owner", Role: "author"}
	b, e := m.Mutate(context.Background(), actor, "", "create", application.StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	h := Handler(Options{Service: app, Management: m, ResolveActor: func(r *http.Request) *application.Actor {
		switch r.Header.Get("X-Fixture") {
		case "anonymous":
			return nil
		case "other":
			return &application.Actor{ID: "other", Role: "author"}
		case "agent":
			return &application.Actor{ID: "agent", Role: "agent"}
		}
		return &actor
	}})
	for _, c := range []struct {
		method, path, identity, body string
		status                       int
	}{
		{"GET", "/v1/studio/books", "anonymous", "", 401}, {"POST", "/v1/studio/books", "agent", `{"operation":"create"}`, 403},
		{"GET", "/v1/studio/books/" + b.ID, "other", "", 404}, {"GET", "/v1/projects/" + b.ID + "/workspace", "other", "", 404},
		{"PUT", "/v1/studio/books/" + b.ID + "/structure", "agent", `{}`, 403}, {"GET", "/v1/projects/arbitrary/chapters", "", "", 404},
		{"DELETE", "/v1/studio/books/" + b.ID, "other", `{"baseVersion":1}`, 404},
		{"DELETE", "/v1/studio/books/" + b.ID, "agent", `{"baseVersion":1}`, 403},
		{"DELETE", "/v1/studio/books/" + b.ID, "", `{"baseVersion":1,"ownerId":"other"}`, 422},
		{"DELETE", "/v1/studio/books/legacy", "", `{"baseVersion":1}`, 403},
		{"POST", "/v1/studio/books", "", `{"operation":"create","ownerId":"other"}`, 422},
		{"GET", "/v1/projects/" + b.ID + "/chapters/CH-000001", "", "", 200},
		{"GET", "/v1/projects/" + b.ID + "/notes", "", "", 200},
		{"PUT", "/v1/studio/books/legacy/structure", "", `{"operation":"rename","title":"bad","baseVersion":1}`, 403},
	} {
		r := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		r.Header.Set("X-Fixture", c.identity)
		r.Header.Set("Idempotency-Key", "mutation")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.status {
			t.Fatalf("%s %s %s: %d %s", c.method, c.path, c.identity, w.Code, w.Body.String())
		}
	}
	// Both domains use project-specific existing storage; caller cannot supply an owner/root.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/v1/studio/books", nil))
	var list struct {
		Items []application.ManagedBook `json:"items"`
	}
	if json.Unmarshal(w.Body.Bytes(), &list) != nil || len(list.Items) != 1 {
		t.Fatal(w.Body.String())
	}
	r := httptest.NewRequest("DELETE", "/v1/studio/books/"+b.ID, strings.NewReader(`{"baseVersion":1}`))
	r.Header.Set("Idempotency-Key", "delete")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
}
