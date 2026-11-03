package thinking

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestStoryToolsBindWritesToActualActiveAuthorTurn(t *testing.T) {
	s, rec, _ := fixture(t)
	ctx := context.Background()
	endpoint := "/internal/v1/agent/tools/execute"
	contextBody := `{"sessionId":"` + rec.ID + `","query":"林舟"}`
	call(t, s, rec, "/internal/v1/agent/story-context", contextBody, 403)
	rec.Scopes = append(rec.Scopes, "creative")
	rec.Model.Limits.Tools = 50
	// Go's accepted-message handoff may lag Pi; the persisted Pi run is authority.
	rec.LastMessage = "old"
	_ = s.tx(ctx, func(st *registry) error { st.Sessions[rec.ID] = rec; return nil })
	out := call(t, s, rec, "/internal/v1/agent/story-context", contextBody, 200)
	if out["dialogueRecording"] != false {
		t.Fatal(out)
	}
	actor := application.Actor{ID: rec.Owner, Role: "author"}
	app, _ := s.Management.Resolve(actor, rec.Book)
	c := creative.New(app, llm.Config{}, nil)
	on := true
	if _, err := c.Configure(ctx, actor, "recording", "enable-recording", creative.SettingsInput{DialogueRecording: &on}); err != nil {
		t.Fatal(err)
	}
	messages := []creative.SnapshotMessage{{ID: "old", Role: "user", Status: "completed", Text: "讨论人物"}, {ID: "old-answer", Role: "assistant", Status: "completed", Text: "方案二：林舟是医师。"}}
	for i := 0; i < 14; i++ {
		messages = append(messages, creative.SnapshotMessage{ID: fmt.Sprint("prior-", i), Role: "user", Status: "completed", Text: "继续构思"})
	}
	messages = append(messages, creative.SnapshotMessage{ID: "current", Role: "user", Status: "completed", Text: "采用第二个方案，林舟是医师。"}, creative.SnapshotMessage{ID: "current-answer", Role: "assistant", Status: "running"})
	snap := map[string]any{"sessionId": rec.ID, "bookId": rec.Book, "status": "running", "messages": messages, "run": map[string]any{"runId": "run-current", "messageId": "current", "status": "checkpointed", "authorizationVersion": 0}}
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-service" {
			t.Error("missing service token")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(snap)
	}))
	defer pi.Close()
	s.Origin = pi.URL
	s.ServiceToken = "fixture-service"
	body := func(tool, message, run string, args any) string {
		b, _ := json.Marshal(map[string]any{"sessionId": rec.ID, "tool": tool, "messageId": message, "runId": run, "arguments": args})
		return string(b)
	}
	args := map[string]any{"changes": []any{map[string]any{"intent": "decide", "kind": "character", "patch": map[string]any{"name": "林舟", "setFields": []any{map[string]any{"key": "职业", "value": "医师"}}}, "evidence": []any{map[string]any{"messageId": "current", "quote": "采用第二个方案"}, map[string]any{"messageId": "old-answer", "quote": "林舟是医师"}}}}}
	call(t, s, rec, endpoint, body("record_story_changes", "old", "run-current", args), 409)
	call(t, s, rec, endpoint, body("record_story_changes", "current", "run-old", args), 409)
	forged := strings.Replace(body("record_story_changes", "current", "run-current", args), "采用第二个方案", "伪造作者批准", 1)
	call(t, s, rec, endpoint, forged, 422)
	result := call(t, s, rec, endpoint, body("record_story_changes", "current", "run-current", args), 200)
	if result["status"] != "applied" {
		t.Fatal(result)
	}
	// A changed regenerated batch cannot modify the same logical author's receipt.
	replayed := call(t, s, rec, endpoint, strings.Replace(body("record_story_changes", "current", "run-current", args), "医师", "剑客", 1), 200)
	if replayed["changeId"] != result["changeId"] {
		t.Fatal("duplicate story change", result, replayed)
	}
	out = call(t, s, rec, "/internal/v1/agent/story-context", contextBody, 200)
	if out["dialogueRecording"] != true || len(out["confirmed"].([]any)) != 1 {
		t.Fatal(out)
	}
	focus := map[string]any{"goal": "讨论人物冲突", "assetIds": []string{}, "questionIds": []string{}}
	call(t, s, rec, endpoint, body("update_discussion_focus", "current", "run-current", focus), 200)
	snap["status"] = "idle"
	call(t, s, rec, endpoint, body("update_discussion_focus", "current", "run-current", focus), 409)
}

func TestDiscussionSourceIsSameBookOriginalAndRecordingIsOptIn(t *testing.T) {
	s, rec, _ := fixture(t)
	ctx := context.Background()
	rec.Scopes = []string{"creative"}
	rec.Model.Limits.Tools = 20
	other := rec
	other.ID = "th-other"
	other.Book = "other-book"
	old := rec
	old.ID = "th-old"
	_ = s.tx(ctx, func(st *registry) error {
		st.Sessions[rec.ID] = rec
		st.Sessions[old.ID] = old
		st.Sessions[other.ID] = other
		return nil
	})
	pi := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sid := rec.ID
		if strings.Contains(r.URL.Path, old.ID) {
			sid = old.ID
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sessionId": sid, "bookId": rec.Book, "status": "running", "run": map[string]any{"runId": "run", "messageId": "current", "status": "running"}, "messages": []creative.SnapshotMessage{{ID: "current", Role: "user", Text: "主角叫林舟", Status: "completed"}, {ID: "failed", Role: "assistant", Text: "虚构结果", Status: "failed"}}})
	}))
	defer pi.Close()
	s.Origin = pi.URL
	s.ServiceToken = "fixture-service"
	callSource := func(session, message string, status int) map[string]any {
		return call(t, s, rec, "/internal/v1/agent/tools/execute", fmt.Sprintf(`{"sessionId":%q,"tool":"get_discussion_source","arguments":{"sessionId":%q,"messageId":%q}}`, rec.ID, session, message), status)
	}
	out := callSource(old.ID, "current", 200)
	if out["text"] != "主角叫林舟" || out["role"] != "user" {
		t.Fatal(out)
	}
	callSource(other.ID, "current", 404)
	callSource(rec.ID, "failed", 404)
	body := fmt.Sprintf(`{"sessionId":%q,"tool":"record_story_changes","messageId":"current","runId":"run","arguments":{"changes":[{"intent":"decide","kind":"character","patch":{"name":"林舟"},"evidence":[{"messageId":"current","quote":"主角叫林舟"}]}]}}`, rec.ID)
	out = call(t, s, rec, "/internal/v1/agent/tools/execute", body, 409)
	if out["code"] != "DIALOGUE_RECORDING_DISABLED" {
		t.Fatal(out)
	}
	offer := strings.Replace(body, "record_story_changes", "offer_story_changes", 1)
	out = call(t, s, rec, "/internal/v1/agent/tools/execute", offer, 200)
	if out["status"] != "offered" {
		t.Fatal(out)
	}
	app, _ := s.Management.Resolve(application.Actor{ID: rec.Owner, Role: "author"}, rec.Book)
	assets, err := creative.New(app, llm.Config{}, nil).Assets(ctx, creative.AssetQuery{Limit: 20})
	if err != nil || len(assets.Items) != 0 {
		t.Fatal("offering changed the story", assets, err)
	}
	stored := call(t, s, rec, "/internal/v1/agent/story-change-receipt", fmt.Sprintf(`{"sessionId":%q,"messageId":"current"}`, rec.ID), 200)
	if stored["changeId"] != out["changeId"] || stored["status"] != "offered" {
		t.Fatal(stored, out)
	}
	call(t, s, rec, "/internal/v1/agent/tools/execute", strings.Replace(offer, `"messageId":"current","runId"`, `"messageId":"old","runId"`, 1), 409)
	focus := fmt.Sprintf(`{"sessionId":%q,"tool":"update_discussion_focus","messageId":"current","runId":"run","arguments":{"goal":"探索人物动机","assetIds":[],"questionIds":[]}}`, rec.ID)
	out = call(t, s, rec, "/internal/v1/agent/tools/execute", focus, 200)
	if out["goal"] != "探索人物动机" {
		t.Fatal(out)
	}
}
