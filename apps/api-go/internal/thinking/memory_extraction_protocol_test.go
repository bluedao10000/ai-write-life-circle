package thinking

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

func TestMemoryExtractionProtocolKeepsLegacySessionsLoadable(t *testing.T) {
	legacyJSON := []byte(`{"version":2,"tasks":[{"taskId":"task-a","resultVersion":7}],"comparisons":[],"comparisonOmitted":0}`)
	var legacy MemoryExtraction
	if err := json.Unmarshal(legacyJSON, &legacy); err != nil {
		t.Fatal(err)
	}
	if value, ok := legacy.Tasks[0].ResultVersion.Legacy(); !ok || value != 7 {
		t.Fatal("legacy result version was not retained", legacy.Tasks[0].ResultVersion)
	}
	encoded, err := json.Marshal(legacy)
	if err != nil || !bytes.Contains(encoded, []byte(`"resultVersion":7`)) {
		t.Fatal("legacy protocol was not preserved on disk", string(encoded), err)
	}
	_, err = (&Service{}).memoryExtractionSources(context.Background(), Record{Owner: "owner", Book: "book", MemoryExtraction: &legacy})
	if err == nil || application.AsError(err).Code != "MEMORY_EXTRACTION_UNAVAILABLE" {
		t.Fatal("legacy extraction remained resumable", err)
	}

	token := "sha256:" + strings.Repeat("a", 64)
	var current MemoryExtraction
	if err = json.Unmarshal([]byte(`{"version":3,"tasks":[{"taskId":"task-a","resultVersion":"`+token+`"}],"comparisons":[],"comparisonOmitted":0}`), &current); err != nil {
		t.Fatal(err)
	}
	if current.Tasks[0].ResultVersion != MemoryResultVersion(token) {
		t.Fatal("current result version was not retained")
	}
}
