package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/transport"
)

// Two signed-in accounts against the real resolver and managed transport:
// every author-owned surface is invisible to the other account, and the
// pre-identity author is inherited only by the bound legacy owner.
func TestTwoAccountsCannotReachEachOthersWork(t *testing.T) {
	s, public := newSigner(t)
	c := production(t)
	c.IdentityPublicKey = public
	resolver, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	app := &application.Service{Root: t.TempDir(), State: c.State, Project: "local"}
	m := application.NewManagement(app, c.AuthorID)
	// A book created before per-user identity belongs to the configured author.
	legacy, err := m.Mutate(context.Background(), application.Actor{ID: c.AuthorID, Role: "author"}, "", "legacy-create", application.StructureInput{Operation: "create", Title: "旧书"})
	if err != nil {
		t.Fatal(err)
	}
	h := transport.Handler(transport.Options{Service: app, Management: m, Environment: "production", ResolveActor: resolver,
		CreativeFor:  func(a *application.Service) *creative.Service { return creative.New(a, llm.Config{}, nil) },
		KnowledgeFor: func(a *application.Service) *knowledge.Service { return knowledge.New(a, llm.Config{}, nil) },
	})
	call := func(sub, email, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", bearer)
		r.Header.Set(Header, s.token(t, claimsFor(sub, email, method, r.URL.EscapedPath())))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", "k-"+sub+"-"+method+"-"+strings.ReplaceAll(strings.Trim(path, "/"), "/", "-"))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	books := func(sub, email string) []string {
		t.Helper()
		w := call(sub, email, "GET", "/v1/studio/books", "")
		var out struct {
			Items []application.ManagedBook `json:"items"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		ids := []string{}
		for _, b := range out.Items {
			ids = append(ids, b.ID)
		}
		return ids
	}
	w := call("alice", "alice@example.com", "POST", "/v1/studio/books", `{"operation":"create","baseVersion":0,"title":"Alice"}`)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var alice application.ManagedBook
	_ = json.Unmarshal(w.Body.Bytes(), &alice)
	if got := books("alice", "alice@example.com"); len(got) != 1 || got[0] != alice.ID {
		t.Fatalf("alice sees %v", got)
	}
	// A new account starts empty: no shared or legacy books.
	if got := books("bob", "bob@example.com"); len(got) != 0 {
		t.Fatalf("bob sees %v", got)
	}
	for _, target := range []string{alice.ID, legacy.ID, "local"} {
		for _, req := range []struct{ method, path, body string }{
			{"GET", "/v1/studio/books/" + target, ""},
			{"PUT", "/v1/studio/books/" + target + "/structure", `{"operation":"rename","title":"x","baseVersion":1}`},
			{"DELETE", "/v1/studio/books/" + target, `{"baseVersion":1}`},
			{"GET", "/v1/projects/" + target + "/chapters", ""},
			{"GET", "/v1/projects/" + target + "/chapters/CH-000001", ""},
			{"POST", "/v1/projects/" + target + "/chapters/CH-000001/revisions", `{"baseRevisionId":null,"markdown":"bob"}`},
			{"GET", "/v1/projects/" + target + "/workspace", ""},
			{"GET", "/v1/projects/" + target + "/notes", ""},
			{"POST", "/v1/projects/" + target + "/notes", `{"content":"bob"}`},
			{"GET", "/v1/studio/books/" + target + "/creative/assets", ""},
			{"POST", "/v1/studio/books/" + target + "/creative/assets", `{"kind":"character","content":{"name":"x","aliases":[],"summary":"","fields":[]}}`},
			{"GET", "/v1/studio/books/" + target + "/knowledge", ""},
			{"POST", "/v1/studio/books/" + target + "/knowledge/pause", `{"baseVersion":0}`},
		} {
			if got := call("bob", "bob@example.com", req.method, req.path, req.body); got.Code != 404 && got.Code != 403 {
				t.Fatalf("bob %s %s on %s: %d %s", req.method, req.path, target, got.Code, got.Body.String())
			}
		}
	}
	// The verified legacy email inherits the pre-identity author and its books.
	owner := books("legacy-sub", "owner@example.com")
	found := false
	for _, id := range owner {
		found = found || id == legacy.ID
		if id == alice.ID {
			t.Fatal("legacy owner sees another account's book")
		}
	}
	if !found {
		t.Fatalf("legacy owner lost %s: %v", legacy.ID, owner)
	}
	if got := call("legacy-sub", "owner@example.com", "GET", "/v1/studio/books/"+legacy.ID, ""); got.Code != 200 {
		t.Fatal(got.Code, got.Body.String())
	}
	// Background discovery sees every author's books, each with its true owner.
	all, err := m.OwnedBooks()
	if err != nil {
		t.Fatal(err)
	}
	owners := map[string]string{}
	for _, b := range all {
		owners[b.Book.ID] = b.Owner.ID
	}
	if owners[alice.ID] != UserActorID("alice") || owners[legacy.ID] != c.AuthorID {
		t.Fatalf("owners %v", owners)
	}
	if _, who, err := m.ResolveOwned(alice.ID); err != nil || who.ID != UserActorID("alice") {
		t.Fatal(who, err)
	}
}

// A real request path is percent-encoded identically by the Worker and Go.
func TestAssertionPathMatchesEscapedPath(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/v1/studio/books/book-1/creative/assets?q=%E6%9E%97", nil)
	if r.URL.EscapedPath() != "/v1/studio/books/book-1/creative/assets" {
		t.Fatal(r.URL.EscapedPath())
	}
}
