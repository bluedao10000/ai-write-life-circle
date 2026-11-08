package agenttasks

import (
	"context"
	"testing"
)

func TestWorkerHeartbeatAcceptsAnalysisKind(t *testing.T) {
	s, _ := fixture(t)
	err := s.ReportWorker(context.Background(), WorkerHeartbeat{
		Instance: "fixture-worker",
		Version:  "test",
		Config:   s.Config.Fingerprint(),
		Kinds:    []string{"review", "knowledge", "creative", "memory", "analysis"},
		Ready:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	status := s.WorkerStatus()
	if len(status.Kinds) != 5 || status.ByKind["analysis"].Pending != 0 {
		t.Fatalf("analysis kind not reported: %+v", status)
	}
}
