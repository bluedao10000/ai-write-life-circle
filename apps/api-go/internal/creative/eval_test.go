package creative

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

// The synthetic eval cases must keep passing in fixture mode; this guards the
// metric pipeline and server-side validation, not model quality.
func TestEvalFixturePipeline(t *testing.T) {
	raw, e := os.ReadFile("../../../../harness/evals/creative/cases.json")
	if e != nil {
		t.Fatal(e)
	}
	var cases []EvalCase
	if e = json.Unmarshal(raw, &cases); e != nil {
		t.Fatal(e)
	}
	cfg := llm.Config{Provider: "openai-compatible", BaseURL: "http://localhost", Model: "fixture", ResponseFormat: "json_object", TokenParameter: "max_tokens", Timeout: 1e9, MaxContextBytes: 64 * 1024, MaxOutputTokens: 2048, MaxResponseBytes: 1 << 20}
	rep, e := RunEval(context.Background(), cases, cfg, nil)
	if e != nil {
		t.Fatal(e)
	}
	if rep.IntentAccuracy != 1 || rep.UnconfirmedPromotionRate != 0 || rep.DuplicateEntities != 0 || rep.TraceabilityRate != 1 || rep.QualityClaim {
		t.Fatalf("%+v", rep)
	}
}
