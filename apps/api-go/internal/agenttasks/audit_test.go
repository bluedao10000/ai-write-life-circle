package agenttasks

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestExecutionAuditIsBoundedAndSanitized(t *testing.T) {
	rec := Record{}
	rec.audit("claimed", "")
	rec.audit("started", "")
	rec.audit("terminal", "private provider output and credential")
	original := rec.Audit[2].At
	rec.audit("terminal", "LLM_TIMEOUT")
	if len(rec.Audit) != 3 || rec.Audit[2].Reason != "TASK_REJECTED" || rec.Audit[2].At != original {
		t.Fatal(rec.Audit)
	}
	raw, _ := json.Marshal(rec.Audit)
	if strings.Contains(string(raw), "private") {
		t.Fatal(string(raw))
	}

}

func TestExpiredMemoryAuditPreservesOriginalLifecycle(t *testing.T) {
	rec := Record{Task: Task{ID: "memory", Deadline: "2000-01-01T00:00:00Z"}, Memory: &PreparedMemory{}, Started: true}
	rec.audit("claimed", "")
	rec.audit("started", "")
	st := Registry{Tasks: map[string]Record{"memory": rec}}
	expire(&st)
	got := st.Tasks["memory"]
	if len(got.Audit) != 3 || got.Audit[2].Reason != "TASK_DEADLINE_EXPIRED" {
		t.Fatal(got.Audit)
	}
	expire(&st)
	if len(st.Tasks["memory"].Audit) != 3 || st.Tasks["memory"].Audit[2].At != got.Audit[2].At {
		t.Fatal("duplicate terminal event")
	}
}
