package creative

import (
	"encoding/json"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

func TestPlanCheckRetainsRepeatedAndNormalizedEvidence(t *testing.T) {
	text := "😀“我\n  留下……”\n“我\n  留下……”"
	p := &planContext{
		Revision: application.StoredRevision{ID: "revision", Markdown: text, Hash: compat.Hash(text)},
		Plans:    map[string]Asset{"plan": {ID: "plan", Version: 1, Content: Content{Name: "离开组织"}}},
	}
	for _, quote := range []string{"“我\n  留下……”", "\"我 留下...\""} {
		raw, _ := json.Marshal(planOutput{Checks: []planCheck{{AssetID: "plan", Assessment: "diverged", Quote: quote, Explanation: "他留下了。", Question: "离开的计划要推迟吗？"}}})
		list, discarded, err := new(Service).buildPlan(p, Job{ID: "job", ChapterID: "chapter"}, string(raw), "now")
		if err != nil || discarded != 0 || len(list) != 1 || list[0].Evidence == nil {
			t.Fatalf("results=%+v discarded=%d error=%v", list, discarded, err)
		}
		ev := list[0].Evidence
		if ev.Quote != "“我\n  留下……”" || ev.Start != 2 || ev.End != 12 {
			t.Fatalf("evidence=%+v", ev)
		}
	}
}
