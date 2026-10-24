package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestCreativeRoutesOwnershipStrictInputAndCAS(t *testing.T) {
	owner := application.Actor{ID: "owner", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, owner.ID)
	b, e := m.Mutate(context.Background(), owner, "", "create", application.StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	actor := &owner
	sessions := map[string]string{"th-00000000-0000-4000-8000-000000000001": b.ID}
	h := Handler(Options{Management: m, Service: m.Legacy, ResolveActor: func(*http.Request) *application.Actor { return actor },
		CreativeFor: func(app *application.Service) *creative.Service { return creative.New(app, llm.Config{}, nil) },
		SessionOwned: func(a application.Actor, book, id string) error {
			if sessions[id] != book || a.ID != owner.ID {
				return application.Fail(404, "NOT_FOUND", "Session not found.")
			}
			return nil
		}})
	n := 0
	call := func(method, path, body string, want int) map[string]any {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		n++
		r.Header.Set("Idempotency-Key", "k-"+strconv.Itoa(n))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		out := map[string]any{}
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	base := "/v1/studio/books/" + b.ID + "/creative"
	call("GET", base, "", 200)
	created := call("POST", base+"/assets", `{"kind":"character","content":{"name":"林舟","aliases":[],"summary":"灯塔看守人","fields":[{"key":"动机","value":"赎罪"}]},"status":"draft"}`, 201)
	id := created["assetId"].(string)
	call("GET", base+"/assets/"+id, "", 200)
	call("PATCH", base+"/assets/"+id, `{"baseVersion":1,"status":"accepted"}`, 200)
	call("PATCH", base+"/assets/"+id, `{"baseVersion":1,"status":"archived"}`, 409)
	// Unknown fields, model-like authority fields and bad kinds are rejected.
	call("POST", base+"/assets", `{"kind":"character","content":{"name":"x","aliases":[],"summary":"","fields":[]},"status":"accepted","ownerId":"other"}`, 422)
	call("POST", base+"/assets", `{"kind":"spell","content":{"name":"x","aliases":[],"summary":"","fields":[]},"status":"draft"}`, 422)
	call("GET", base+"/assets?limit=1000", "", 422)
	// Turns require a session owned by this author and book.
	call("GET", base+"/turns?sessionId=th-00000000-0000-4000-8000-000000000001", "", 200)
	call("GET", base+"/turns?sessionId=th-00000000-0000-4000-8000-000000000002", "", 404)
	// Manual organizing needs consent first.
	call("POST", base+"/organize", `{"sessionId":"th-00000000-0000-4000-8000-000000000001","messageId":"m1"}`, 422)
	// Cross-author and unauthenticated access.
	actor = &application.Actor{ID: "other", Role: "author"}
	call("GET", base, "", 404)
	actor = &application.Actor{ID: "owner", Role: "agent"}
	call("POST", base+"/assets", `{}`, 403)
	actor = nil
	call("GET", base, "", 401)
}
