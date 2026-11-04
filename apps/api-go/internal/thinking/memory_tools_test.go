package thinking

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestMemoryRetrievalUsesCurrentDomainSourcesAndScopes(t *testing.T) {
	s, rec, chapter := fixture(t)
	ctx := context.Background()
	body := `{"sessionId":"` + rec.ID + `","tool":"retrieve_memory","arguments":{}}`
	call(t, s, rec, "/internal/v1/agent/tools/execute", body, 403)
	rec.Scopes = append(rec.Scopes, "creative")
	rec.Model.Limits.Tools = 30
	if e := s.tx(ctx, func(st *registry) error { st.Sessions[rec.ID] = rec; return nil }); e != nil {
		t.Fatal(e)
	}
	actor := application.Actor{ID: rec.Owner, Role: "author"}
	app, e := s.Management.Resolve(actor, rec.Book)
	if e != nil {
		t.Fatal(e)
	}
	c := creative.New(app, llm.Config{}, nil)
	asset, e := c.CreateAsset(ctx, actor, compat.UUID(), creative.AssetInput{Kind: "character", Status: "accepted", Content: creative.Content{Name: "林舟", Summary: "作者确认的人物"}})
	if e != nil {
		t.Fatal(e)
	}
	revision, e := app.SavedRevisionAt(ctx, chapter, "")
	if e != nil {
		t.Fatal(e)
	}
	source := knowledge.Source{BookID: rec.Book, ChapterID: chapter, RevisionID: revision.ID, ContentHash: revision.Hash, Quote: "林舟", Start: 0, End: 2, Kind: "narration", Validity: "current"}
	// Stored extraction fixture: the read must still verify against the real revision.
	state := map[string]any{"schemaVersion": 1, "bookId": rec.Book, "version": 1, "entities": map[string]knowledge.Entity{"entity": {ID: "entity", BookID: rec.Book, Type: "character", Name: "林舟", Status: "observed", Version: 1}}, "assertions": map[string]knowledge.Assertion{"assertion": {ID: "assertion", EntityID: "entity", Predicate: "原文观察", Text: "林舟出现在原文", Epistemic: "observation", Status: "current", Sources: []knowledge.Source{source}}}, "requests": map[string]any{}, "index": map[string][]string{"林舟": {"entity"}}}
	path := filepath.Join(app.State, "knowledge", compat.Key(rec.Book), "index-v1.json")
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(state)
	if e = os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	out := call(t, s, rec, "/internal/v1/agent/tools/execute", body, 200)
	records := out["records"].([]any)
	if len(records) != 2 {
		t.Fatal(out)
	}
	if records[0].(map[string]any)["status"] != "confirmed" || records[1].(map[string]any)["status"] != "observed" {
		t.Fatal(records)
	}
	if len(out["sources"].([]any)) != 1 {
		t.Fatal(out)
	}
	for _, v := range records {
		r := v.(map[string]any)
		if r["provenance"] == nil || r["version"] == nil || r["versionResource"] == nil {
			t.Fatal(r)
		}
	}
	limited := rec
	limited.Model.Limits.ResultBytes = 1000
	bounded, e := s.execute(ctx, limited, "retrieve_memory", toolArgs{})
	if e != nil {
		t.Fatal(e)
	}
	boundedJSON, _ := json.Marshal(bounded)
	limitedView := bounded.(map[string]any)
	if len(boundedJSON) > 1000 || limitedView["truncated"] != true || limitedView["omitted"].(int) == 0 {
		t.Fatal(string(boundedJSON))
	}
	// Revision changes retire manuscript observations; author settings remain independent.
	key := compat.UUID()
	if _, e = app.Save(ctx, actor, chapter, key, map[string]any{"baseRevisionId": revision.ID, "markdown": "人物已经离开。"}, &key); e != nil {
		t.Fatal(e)
	}
	out = call(t, s, rec, "/internal/v1/agent/tools/execute", body, 200)
	if len(out["records"].([]any)) != 1 || len(out["sources"].([]any)) != 0 {
		t.Fatal(out)
	}
	archived := "archived"
	if _, e = c.UpdateAsset(ctx, actor, compat.UUID(), asset.ID, creative.AssetUpdate{BaseVersion: asset.Version, Status: &archived}); e != nil {
		t.Fatal(e)
	}
	if _, e = c.UpdateAsset(ctx, actor, compat.UUID(), asset.ID, creative.AssetUpdate{BaseVersion: asset.Version, Status: &archived}); e == nil {
		t.Fatal("stale asset version accepted")
	}
	// A new service reads the same authoritative deletion/retirement state.
	restarted := &Service{Management: s.Management, State: s.State, Secret: s.Secret}
	out = call(t, restarted, rec, "/internal/v1/agent/tools/execute", body, 200)
	if len(out["records"].([]any)) != 0 {
		t.Fatal(out)
	}
	call(t, s, rec, "/internal/v1/agent/tools/execute", `{"sessionId":"`+rec.ID+`","tool":"retrieve_memory","arguments":{"bookId":"other"}}`, 422)
	rec.Scopes = []string{"creative"}
	if e = s.tx(ctx, func(st *registry) error { st.Sessions[rec.ID] = rec; return nil }); e != nil {
		t.Fatal(e)
	}
	call(t, s, rec, "/internal/v1/agent/tools/execute", body, 403)
}
