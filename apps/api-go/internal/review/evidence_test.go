package review

import (
	"encoding/json"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

func TestReviewNormalizesQuotesAndAnchorsOriginalText(t *testing.T) {
	s, _ := testService(t, nil)
	p := plan(t, s)
	for i := range p.Sources {
		if p.Sources[i].Kind == "target" {
			p.Sources[i].Excerpt = "😀林舟\n  到过北港。"
			p.Sources[i].ExcerptHash = compat.Hash(p.Sources[i].Excerpt)
			p.Sources[i].StartUTF16 = 20
		}
	}
	c := validCandidate()
	c["evidence"].([]map[string]string)[0]["quote"] = "林舟 到过北港."
	raw, _ := json.Marshal(map[string]any{"findings": []any{c}})
	findings, reasons, err := Validate(p, string(raw))
	if err != nil || len(reasons) != 0 || len(findings) != 1 {
		t.Fatalf("findings=%+v reasons=%v error=%v", findings, reasons, err)
	}
	a := findings[0].Anchor
	if a.Quote != "林舟\n  到过北港。" || a.Status != "unique" || a.Start == nil || *a.Start != 22 || a.End == nil || *a.End != 32 {
		t.Fatalf("anchor=%+v", a)
	}
	if findings[0].Evidence[0].Quote != a.Quote {
		t.Fatal("evidence and editor anchor must use the same source slice")
	}
}
