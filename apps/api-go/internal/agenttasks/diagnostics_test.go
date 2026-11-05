package agenttasks

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestDiagnosticsProjectsReceiptsWithoutPayloads(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	id := "00000000-0000-4000-8000-000000000001"
	rec := Record{Task: Task{ID: id, Book: "book", Kind: "memory.consolidate", Lease: "private-lease", Config: "private-config", Request: llm.Request{Input: "private-manuscript"}}, Memory: &PreparedMemory{Sources: []MemorySourceBinding{{TaskID: "source-a", ResultVersion: "private-version"}}, Request: llm.Request{Input: "private-manuscript"}}}
	for _, step := range []struct {
		started, finished   bool
		outcome, hash, want string
	}{
		{false, false, "", "", "accepted"}, {true, false, "", "", "running"}, {true, true, "completed", "receipt", "completed"}, {true, true, "failed", "receipt", "failed"}, {true, true, "interrupted", "expired", "interrupted"}, {true, true, "", "expired", "interrupted"}, {true, true, "", "receipt", "unknown"},
	} {
		rec.Started, rec.Finished, rec.Outcome, rec.ResultHash = step.started, step.finished, step.outcome, step.hash
		if err := s.transaction(ctx, func(st *Registry) error { st.Tasks[id] = rec; return nil }); err != nil {
			t.Fatal(err)
		}
		got, err := (&Service{State: s.State}).Diagnostics(ctx, id)
		if err != nil || got.Outcome != step.want || got.Started != step.started || got.Finished != step.finished || len(got.SourceTaskIDs) != 1 || got.SourceTaskIDs[0] != "source-a" {
			t.Fatal(got, err)
		}
		raw, _ := json.Marshal(got)
		if strings.Contains(string(raw), "private-") {
			t.Fatal("diagnostics leaked execution payload", string(raw))
		}
	}
	if _, err := s.Diagnostics(ctx, "missing"); err == nil {
		t.Fatal("missing receipt returned success")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.Diagnostics(cancelled, id); err != context.Canceled {
		t.Fatal(err)
	}
}
