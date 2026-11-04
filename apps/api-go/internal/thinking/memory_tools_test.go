package thinking

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

func TestMemoryRetrievalExpiresDeletedConversationSources(t *testing.T) {
	s, rec, _ := fixture(t)
	ctx := context.Background()
	rec.Scopes = append(rec.Scopes, "creative")
	rec.Model.Limits.Tools = 20
	if e := s.tx(ctx, func(st *registry) error { st.Sessions[rec.ID] = rec; return nil }); e != nil {
		t.Fatal(e)
	}
	actor := application.Actor{ID: rec.Owner, Role: "author"}
	app, e := s.Management.Resolve(actor, rec.Book)
	if e != nil {
		t.Fatal(e)
	}
	c := creative.New(app, llm.Config{}, nil)
	on := true
	if _, e = c.Configure(ctx, actor, "recording", compat.UUID(), creative.SettingsInput{DialogueRecording: &on}); e != nil {
		t.Fatal(e)
	}
	name := "林舟"
	quote := "作者保留的人物和未确认的候选地点。"
	for index, intent := range []string{"decide", "explore"} {
		message := []string{"accepted-message", "candidate-message"}[index]
		_, e = c.RecordStoryChanges(ctx, actor, compat.UUID(), "deleted-source-session", message, creative.RecordStoryChangesInput{Changes: []creative.StoryChangeInput{{Intent: intent, Kind: "character", Patch: creative.Patch{Name: &name}, Evidence: []creative.StoryEvidence{{MessageID: message, Quote: quote}}}}}, []creative.TurnMessage{{ID: message, Role: "user", Text: quote}})
		if e != nil {
			t.Fatal(e)
		}
	}
	body := `{"sessionId":"` + rec.ID + `","tool":"retrieve_memory","arguments":{}}`
	before := call(t, s, rec, "/internal/v1/agent/tools/execute", body, 200)
	counts := func(out map[string]any) map[string]int {
		result := map[string]int{}
		for _, item := range out["records"].([]any) {
			record := item.(map[string]any)
			result[record["resource"].(string)]++
		}
		return result
	}
	got := counts(before)
	if got["creative.asset"] != 1 || got["creative.proposal"] != 1 || got["creative.story_change"] != 2 {
		t.Fatal(before)
	}
	if e = c.CancelSession(ctx, "deleted-source-session"); e != nil {
		t.Fatal(e)
	}
	for _, reader := range []*Service{s, {Management: s.Management, State: s.State, Secret: s.Secret}} {
		after := call(t, reader, rec, "/internal/v1/agent/tools/execute", body, 200)
		got = counts(after)
		if got["creative.asset"] != 1 || got["creative.proposal"] != 0 || got["creative.story_change"] != 0 {
			t.Fatal(after)
		}
		raw, _ := json.Marshal(after)
		if strings.Contains(string(raw), "deleted-source-session") {
			t.Fatal("unreadable source still referenced")
		}
	}
	receipts, e := c.StoryChanges(ctx, "deleted-source-session")
	if e != nil || len(receipts) != 2 {
		t.Fatal("business receipts lost", e)
	}
}

func TestMemoryConflictReviewUsesAuthoritativeVersionsAndLifecycle(t *testing.T) {
	s, rec, _ := fixture(t)
	ctx := context.Background()
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
	on := true
	if _, e = c.Configure(ctx, actor, "recording", compat.UUID(), creative.SettingsInput{DialogueRecording: &on}); e != nil {
		t.Fatal(e)
	}
	asset, e := c.CreateAsset(ctx, actor, compat.UUID(), creative.AssetInput{Kind: "character", Status: "accepted", Content: creative.Content{Name: "林舟", Summary: "已确认的看守人"}})
	if e != nil {
		t.Fatal(e)
	}
	sessions := []string{}
	proposals := []string{}
	for i := 0; i < 10; i++ {
		session, message := compat.UUID(), compat.UUID()
		sessions = append(sessions, session)
		summary := "尚未确认的摆渡人"
		receipt, e := c.RecordStoryChanges(ctx, actor, compat.UUID(), session, message, creative.RecordStoryChangesInput{Changes: []creative.StoryChangeInput{{Intent: "explore", TargetAssetID: asset.ID, BaseVersion: &asset.Version, Patch: creative.Patch{Summary: &summary}, Evidence: []creative.StoryEvidence{{MessageID: message, Quote: summary}}}}}, []creative.TurnMessage{{ID: message, Role: "user", Text: summary}})
		if e != nil {
			t.Fatal(e)
		}
		proposals = append(proposals, receipt.Changes[0].ProposalID)
	}
	body := `{"sessionId":"` + rec.ID + `","tool":"retrieve_memory","arguments":{}}`
	before := call(t, s, rec, "/internal/v1/agent/tools/execute", body, 200)
	if len(before["reviewRequired"].([]any)) != 0 {
		t.Fatal(before)
	}
	updatedContent := creative.Content{Name: "林舟", Summary: "作者更新后的看守人"}
	updated, e := c.UpdateAsset(ctx, actor, compat.UUID(), asset.ID, creative.AssetUpdate{BaseVersion: asset.Version, Content: &updatedContent})
	if e != nil {
		t.Fatal(e)
	}
	restarted := &Service{Management: s.Management, State: s.State, Secret: s.Secret}
	after := call(t, restarted, rec, "/internal/v1/agent/tools/execute", body, 200)
	review := after["reviewRequired"].([]any)
	if len(review) != 8 || after["truncated"] != true || after["omitted"].(float64) < 2 {
		t.Fatal(after)
	}
	for _, item := range review {
		conflict := item.(map[string]any)
		if conflict["reason"] != "target_version_changed" || conflict["targetAssetId"] != asset.ID || conflict["baseVersion"] != float64(asset.Version) || conflict["currentVersion"] != float64(updated.Version) || conflict["provenance"] == nil {
			t.Fatal(conflict)
		}
	}
	for _, item := range after["records"].([]any) {
		if item.(map[string]any)["resource"] == "creative.proposal" {
			t.Fatal("stale candidate exposed as current memory")
		}
	}
	if _, e = c.Decide(ctx, actor, compat.UUID(), creative.DecideInput{Decisions: []creative.DecisionInput{{ProposalID: proposals[0], Action: "accept"}}}); e == nil || application.AsError(e).Code != "PROPOSAL_STALE" {
		t.Fatal("stale acceptance", e)
	}
	edited := creative.Content{Name: "林舟", Summary: "作者重新审核的摆渡人"}
	if _, e = c.Decide(ctx, actor, compat.UUID(), creative.DecideInput{Decisions: []creative.DecisionInput{{ProposalID: proposals[0], Action: "accept_edited", Content: &edited, ExpectedVersion: &updated.Version}}}); e != nil {
		t.Fatal(e)
	}
	limited := rec
	limited.Model.Limits.ResultBytes = 1600
	bounded, e := s.execute(ctx, limited, "retrieve_memory", toolArgs{})
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(bounded)
	if len(raw) > 1600 || bounded.(map[string]any)["truncated"] != true {
		t.Fatal(string(raw))
	}
	for _, session := range sessions {
		if e = c.CancelSession(ctx, session); e != nil {
			t.Fatal(e)
		}
	}
	final := call(t, restarted, rec, "/internal/v1/agent/tools/execute", body, 200)
	if len(final["reviewRequired"].([]any)) != 0 {
		t.Fatal(final)
	}
	detail, e := c.Asset(ctx, asset.ID)
	if e != nil || detail.Asset.Summary != edited.Summary {
		t.Fatal("confirmed setting lost", e)
	}
}
