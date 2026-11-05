package agenttasks

import (
	"context"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type memoryCoordinatorFixture struct {
	prepared *PreparedMemory
	starts   int
	finished int
	denied   error
	sent     bool
	terminal error
}

func (f *memoryCoordinatorFixture) Contract() string { return "sha256:" + strings.Repeat("a", 64) }
func (f *memoryCoordinatorFixture) Prepare(context.Context, *application.Service, []PreparedMemory) (*PreparedMemory, error) {
	value := *f.prepared
	return &value, nil
}
func (f *memoryCoordinatorFixture) Start(context.Context, *application.Service, string, *PreparedMemory) error {
	f.starts++
	return nil
}
func (f *memoryCoordinatorFixture) Complete(_ context.Context, _ *application.Service, _ string, _ PreparedMemory, _ llm.Response, sent bool, terminal error) error {
	f.sent, f.terminal = sent, terminal
	f.finished++
	return nil
}
func (f *memoryCoordinatorFixture) Check(context.Context, *application.Service, PreparedMemory) error {
	return f.denied
}
func (f *memoryCoordinatorFixture) Inspect(context.Context, *application.Service) (MemoryInspection, error) {
	return MemoryInspection{Pending: 1}, nil
}

func TestMemoryConsolidationUsesTheAgentTaskAuthority(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	f := &memoryCoordinatorFixture{prepared: &PreparedMemory{
		Strategy: "memory-consolidation-v1",
		Sources: []MemorySourceBinding{
			{TaskID: "task-a", ResultVersion: "sha256:" + strings.Repeat("a", 64)},
			{TaskID: "task-b", ResultVersion: "sha256:" + strings.Repeat("b", 64)},
		},
		ReservedTokens: 4096,
		Request: llm.Request{
			System:     "synthetic",
			Input:      `{"items":[]}`,
			SchemaName: "memory_consolidation",
			Schema:     map[string]any{"type": "object"},
		},
	}}
	s.Memory = f
	task, err := s.Claim(ctx, "fixture", s.Config.Fingerprint(), "memory")
	if err != nil || task == nil {
		t.Fatal(task, err)
	}
	if task.Kind != "memory.consolidate" || task.OutputSchema != "memory-candidate-v1" || task.Strategy != "memory-consolidation-v1" || task.Lease == "" || task.Epoch == 0 {
		t.Fatalf("invalid memory task: %+v", task)
	}
	in := envelope(task)
	in.Response = llm.Response{Text: `{"content":null,"taskIds":[],"relations":[]}`, Usage: &llm.Usage{InputTokens: 10, OutputTokens: 4}, ModelCalls: 1}
	if err = s.Action(ctx, task.ID, "started", in); err != nil {
		t.Fatal(err)
	}
	if err = s.Action(ctx, task.ID, "started", in); err != nil || f.starts != 1 {
		t.Fatal("started was not idempotent", err, f.starts)
	}
	if err = s.Action(ctx, task.ID, "complete", in); err != nil {
		t.Fatal(err)
	}
	if f.finished != 1 {
		t.Fatal("domain completion missing")
	}
	inspection, err := s.InspectMemoryTasks(task.Book)
	if err != nil || inspection.Completed != 1 {
		t.Fatal(inspection, err)
	}
	other, err := s.InspectMemoryTasks("other-book")
	if err != nil || other != (MemoryInspection{}) {
		t.Fatal("cross-book task counts", other, err)
	}
	state, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	record := state.Tasks[task.ID]
	if record.Task.Request.Input != "" || record.Memory == nil || len(record.Memory.Sources) != 2 || record.Outcome != "completed" {
		t.Fatalf("memory task was not scrubbed correctly: %+v", record)
	}
}

func TestMemoryTerminalReportAfterRevocation(t *testing.T) {
	for _, action := range []string{"complete", "fail"} {
		for _, started := range []bool{false, true} {
			if action == "complete" && !started {
				continue
			}
			t.Run(action+map[bool]string{false: "-unstarted", true: "-started"}[started], func(t *testing.T) {
				s, _ := fixture(t)
				ctx := context.Background()
				f := &memoryCoordinatorFixture{prepared: &PreparedMemory{Strategy: "memory-consolidation-v1", ReservedTokens: 4096, Request: llm.Request{System: "fixture", Input: "{}", SchemaName: "memory_consolidation", Schema: map[string]any{"type": "object"}}}}
				s.Memory = f
				task, err := s.Claim(ctx, "fixture", s.Config.Fingerprint(), "memory")
				if err != nil || task == nil {
					t.Fatal(task, err)
				}
				in := envelope(task)
				if started {
					if err = s.Action(ctx, task.ID, "started", in); err != nil {
						t.Fatal(err)
					}
				}
				f.denied = application.Fail(409, "MEMORY_CONSOLIDATION_DISABLED", "Disabled.")
				if err = s.Action(ctx, task.ID, "heartbeat", in); err == nil {
					t.Fatal("revoked heartbeat accepted")
				}
				in.Response = llm.Response{Text: "", Usage: nil}
				if action == "fail" {
					in.Failure = "MEMORY_INTERRUPTED"
				}
				if err = s.Action(ctx, task.ID, action, in); err != nil {
					t.Fatal(err)
				}
				if f.finished != 1 || f.sent != started || f.terminal == nil {
					t.Fatal("terminal settlement missing", f)
				}
				state, err := s.load()
				if err != nil {
					t.Fatal(err)
				}
				rec := state.Tasks[task.ID]
				if !rec.Finished || rec.Outcome != "failed" || rec.Task.Request.Input != "" {
					t.Fatal(rec)
				}
				if err = s.Action(ctx, task.ID, action, in); err != nil || f.finished != 1 {
					t.Fatal("terminal replay", err, f.finished)
				}
			})
		}
	}
}

func TestExpiredMemoryTaskRecordsInterruptionAndScrubsContext(t *testing.T) {
	rec := Record{Task: Task{ID: "memory", Book: "book", Kind: "memory.consolidate", Deadline: "2000-01-01T00:00:00Z", Request: llm.Request{Input: "private source"}}, Started: true, Memory: &PreparedMemory{Sources: []MemorySourceBinding{{TaskID: "source"}}, BudgetDay: "2000-01-01", ReservedTokens: 1000, Request: llm.Request{Input: "private source"}}}
	st := Registry{Tasks: map[string]Record{"memory": rec}}
	expire(&st)
	got := st.Tasks["memory"]
	if !got.Finished || got.Outcome != "interrupted" || got.CompletedAt == "" || got.Task.Request.Input != "" || got.Memory.Request.Input != "" {
		t.Fatal(got)
	}
	if got.Memory.ReservedTokens != 1000 || got.Memory.BudgetDay != "2000-01-01" || len(got.Memory.Sources) != 1 {
		t.Fatal("lost reservation or source binding", got.Memory)
	}
	stamp := got.CompletedAt
	expire(&st)
	if st.Tasks["memory"].CompletedAt != stamp {
		t.Fatal("sweep rewrote terminal receipt")
	}
}
