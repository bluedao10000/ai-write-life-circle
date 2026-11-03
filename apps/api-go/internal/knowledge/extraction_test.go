package knowledge

import (
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

func TestValidateCandidatesRetainsRepeatedAndNormalizedQuotes(t *testing.T) {
	text := "😀林舟说：“我\n  留下……”\n林舟说：“我\n  留下……”"
	r := application.StoredRevision{ID: "revision", Markdown: text, Hash: compat.Hash(text)}
	out := Output{
		Entities:   []CandidateEntity{{Key: "lin", Type: "character", Name: "林舟", Aliases: []string{}}},
		Assertions: []CandidateAssertion{{EntityKey: "lin", Predicate: "决定", Text: "林舟说要留下", Epistemic: "claim", Kind: "dialogue", Quote: "林舟说:\"我 留下...\""}},
	}
	valid, discarded := ValidateCandidates(r, out)
	if len(valid.Assertions) != 1 || len(valid.Entities) != 1 || discarded.Total() != 0 {
		t.Fatalf("valid=%+v discarded=%+v", valid, discarded)
	}
	src, err := evidence("book", "chapter", r, valid.Assertions[0])
	if err != nil || src.Quote != "林舟说：“我\n  留下……”" || src.Start != 2 || src.End != 16 {
		t.Fatalf("source=%+v error=%v", src, err)
	}
	if valid.Assertions[0].Quote != src.Quote {
		t.Fatal("assertion must keep the actual source quote")
	}
}
