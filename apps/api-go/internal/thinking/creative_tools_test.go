package thinking

import (
	"context"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestCreativeToolsAreScopedReadOnlyAndLabelled(t *testing.T) {
	s, rec, ch := fixture(t)
	ctx := context.Background()
	body := func(tool, args string) string {
		return `{"sessionId":"` + rec.ID + `","tool":"` + tool + `","arguments":` + args + `}`
	}
	// Sessions created before V3 lack the creative scope.
	call(t, s, rec, "/internal/v1/agent/tools/execute", body("list_creative_assets", `{}`), 403)
	rec.Scopes = append(rec.Scopes, "creative")
	_ = s.tx(ctx, func(st *registry) error { st.Sessions[rec.ID] = rec; return nil })
	app, e := s.Management.Resolve(application.Actor{ID: rec.Owner, Role: "author"}, rec.Book)
	if e != nil {
		t.Fatal(e)
	}
	c := creative.New(app, llm.Config{}, nil)
	a := application.Actor{ID: rec.Owner, Role: "author"}
	if _, e = c.CreateAsset(ctx, a, compat.UUID(), creative.AssetInput{Kind: "event", Content: creative.Content{Name: "灯塔熄灭", Plan: &creative.Plan{ChapterID: ch}}, Status: "accepted"}); e != nil {
		t.Fatal(e)
	}
	out := call(t, s, rec, "/internal/v1/agent/tools/execute", body("list_creative_assets", `{"kind":"event"}`), 200)
	if len(out["assets"].([]any)) != 1 || !strings.Contains(out["notice"].(string), "author-confirmed") {
		t.Fatal(out)
	}
	call(t, s, rec, "/internal/v1/agent/tools/execute", body("list_creative_assets", `{"kind":"spell"}`), 422)
	out = call(t, s, rec, "/internal/v1/agent/tools/execute", body("compare_plan_with_manuscript", `{"chapterId":"`+ch+`"}`), 200)
	if len(out["plans"].([]any)) != 1 || !strings.Contains(out["notice"].(string), "intentions") {
		t.Fatal(out)
	}
	out = call(t, s, rec, "/internal/v1/agent/tools/execute", body("list_creative_proposals", `{}`), 200)
	if !strings.Contains(out["notice"].(string), "UNCONFIRMED") {
		t.Fatal(out)
	}
	// No accepted turn yet; and organizing still needs the author's book consent.
	call(t, s, rec, "/internal/v1/agent/tools/execute", body("request_turn_organize", `{}`), 409)
	rec.LastMessage = "m1"
	_ = s.tx(ctx, func(st *registry) error { st.Sessions[rec.ID] = rec; return nil })
	call(t, s, rec, "/internal/v1/agent/tools/execute", body("request_turn_organize", `{}`), 422)
	// Arbitrary write-like tools and arguments stay forbidden.
	call(t, s, rec, "/internal/v1/agent/tools/execute", body("update_creative_asset", `{}`), 403)
	call(t, s, rec, "/internal/v1/agent/tools/execute", body("get_creative_asset", `{"assetId":"ca-x","content":"x"}`), 422)
}
