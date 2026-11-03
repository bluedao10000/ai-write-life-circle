package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestStoryRoutesSettingsOwnershipReceiptsAndUndo(t *testing.T) {
	ctx := context.Background()
	owner := application.Actor{ID: "owner", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, owner.ID)
	book, err := m.Mutate(ctx, owner, "", "create", application.StructureInput{Operation: "create"})
	if err != nil {
		t.Fatal(err)
	}
	app, err := m.Resolve(owner, book.ID)
	if err != nil {
		t.Fatal(err)
	}
	service := creative.New(app, llm.Config{}, nil)
	actor := &owner
	session := "th-00000000-0000-4000-8000-000000000001"
	h := Handler(Options{Management: m, Service: m.Legacy, ResolveActor: func(*http.Request) *application.Actor { return actor }, CreativeFor: func(app *application.Service) *creative.Service { return creative.New(app, llm.Config{}, nil) }, SessionOwned: func(a application.Actor, b, s string) error {
		if a.ID != owner.ID || b != book.ID || s != session {
			return application.Fail(404, "NOT_FOUND", "Session not found.")
		}
		return nil
	}})
	base := "/v1/studio/books/" + book.ID + "/creative"
	call := func(method, path, body, key string, status int) map[string]any {
		t.Helper()
		r := httptest.NewRequest(method, base+path, strings.NewReader(body))
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	view := call("GET", "/story-context?sessionId="+session, "", "", 200)
	if view["dialogueRecording"] != false || len(view["confirmed"].([]any)) != 0 {
		t.Fatal(view)
	}
	call("GET", "/story-context?sessionId=th-00000000-0000-4000-8000-000000000002", "", "", 404)
	call("GET", "/changes?sessionId=th-00000000-0000-4000-8000-000000000002", "", "", 404)
	call("GET", "/changes?sessionId=invalid", "", "", 422)
	call("POST", "/settings/recording", `{"dialogueRecording":true}`, "recording", 200)
	call("POST", "/settings/pause", `{}`, "pause", 200)
	name := "林舟"
	receipt, err := service.RecordStoryChanges(ctx, owner, "story:m1", session, "m1", creative.RecordStoryChangesInput{Changes: []creative.StoryChangeInput{{Intent: "decide", Kind: "character", Patch: creative.Patch{Name: &name}, Evidence: []creative.StoryEvidence{{MessageID: "m1", Quote: "林舟"}}}}}, []creative.TurnMessage{{ID: "m1", Role: "user", Text: "林舟"}})
	if err != nil {
		t.Fatal(err)
	}
	list := call("GET", "/changes?sessionId="+session, "", "", 200)
	if len(list["items"].([]any)) != 1 {
		t.Fatal(list)
	}
	view = call("GET", "/story-context?q=林舟", "", "", 200)
	if view["dialogueRecording"] != true || len(view["confirmed"].([]any)) != 1 {
		t.Fatal(view)
	}
	undo := "/changes/" + receipt.ChangeID + "/undo"
	call("POST", undo, `{}`, "", 422)
	call("POST", undo, `{"unknown":true}`, "undo:bad", 422)
	result := call("POST", undo, `{}`, "undo:one", 200)
	if result["status"] != "undone" {
		t.Fatal(result)
	}
	call("POST", undo, `{}`, "undo:one", 200)
	call("POST", undo, `{}`, "undo:two", 200)
	asset, err := service.Asset(ctx, receipt.Changes[0].AssetID)
	if err != nil {
		t.Fatal(err)
	}
	if asset.Asset.Version != 2 || asset.Asset.Status != "archived" {
		t.Fatal(asset)
	}
	actor = &application.Actor{ID: "other", Role: "author"}
	call("GET", "/story-context", "", "", 404)
	call("POST", undo, `{}`, compat.UUID(), 404)
	actor = nil
	call("GET", "/changes", "", "", 401)
}
