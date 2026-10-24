package knowledge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

func TestProductionSizedChineseChapterPreserved(t *testing.T) {
	s, _, _, _ := setup(t)
	s.Config.MaxContextBytes = 64 * 1024
	s.Config.MaxOutputTokens = 131072
	// Synthetic text only: covers the measured production maximum (37,038 bytes).
	prose := strings.Repeat("林舟在江宁城寻找铜铃。\n", 1400)
	r := application.StoredRevision{Revision: application.Revision{ID: "draft:capacity", Hash: compat.Hash(prose)}, Markdown: prose}
	st, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	req, err := s.prepareRequest(context.Background(), Job{ChapterID: "CH-000001"}, r, st, map[string]bool{})
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Markdown string `json:"targetMarkdown"`
	}
	if err = json.Unmarshal([]byte(req.Input), &body); err != nil {
		t.Fatal(err)
	}
	if body.Markdown != prose {
		t.Fatal("chapter was truncated or rewritten")
	}
	if len(req.Input) > s.contextLimit() {
		t.Fatal("request exceeded byte budget")
	}
	if s.reserve() != 65536+20000+131072 {
		t.Fatal("output not covered by token reserve")
	}
	s.Config.MaxContextBytes = 12000
	if _, err = s.prepareRequest(context.Background(), Job{}, r, st, map[string]bool{}); err == nil {
		t.Fatal("explicit legacy capacity must still be enforced")
	}
}

func TestEmptyKnowledgeStateUsesBackfillDefaults(t *testing.T) {
	s, _, _, _ := setup(t)
	st, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	if st.Settings.DailyTokenBudget != 100000000 || st.Settings.DailyJobBudget != 200 {
		t.Fatalf("unexpected initial budget: %+v", st.Settings)
	}
	if st.Settings.Enabled {
		t.Fatal("empty state must remain disabled until the author consents")
	}
}

func TestKnowledgeCandidateCapacitySupportsLargeValidExtraction(t *testing.T) {
	out := Output{
		Entities: []CandidateEntity{{
			Key: "e", Type: "character", Name: "林舟", Aliases: []string{}, Identity: "",
		}},
		Assertions: []CandidateAssertion{},
	}
	for i := 0; i < 110; i++ {
		out.Assertions = append(out.Assertions, CandidateAssertion{
			EntityKey: "e",
			Predicate: fmt.Sprintf("observation-%d", i),
			Text:      strings.Repeat("x", 900),
			Epistemic: "observation",
			Kind:      "narration",
			Quote:     "林舟",
		})
	}
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) <= 96*1024 || len(raw) > CandidateBytes {
		t.Fatalf("fixture must cover the expanded but bounded candidate envelope: %d", len(raw))
	}
	decoded, err := Decode(string(raw))
	if err != nil || len(decoded.Assertions) != 110 {
		t.Fatal("valid expanded candidate was rejected", err)
	}
}
