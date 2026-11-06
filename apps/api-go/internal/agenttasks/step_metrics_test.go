package agenttasks

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestStepMetricsAreDerivedFromAdmissionsAndTerminalResults(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	role := func(parent string, index int) ModelStepReceipt {
		return ModelStepReceipt{ModelStep: ModelStep{
			Role: modelStepRoles[index], CallIndex: index + 1, ParentTaskID: parent, MaxTokens: 100,
		}}
	}
	usage := func(input, output int) *llm.Usage {
		return &llm.Usage{InputTokens: input, OutputTokens: output}
	}
	const firstID, secondID = "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012"
	records := map[string]Record{
		firstID: {
			Task:        Task{ID: firstID, Book: "book", Kind: "creative.plan_check", Strategy: creative.PlanStrategyReadonly},
			Creative:    &creative.PreparedJob{},
			ModelSteps:  []ModelStepReceipt{role(firstID, 0), role(firstID, 1)},
			StepResults: []llm.StepResult{{CallIndex: 1, Status: "completed", DurationMs: 10, Usage: usage(10, 2)}, {CallIndex: 2, Status: "completed", DurationMs: 30, Usage: usage(20, 4)}},
			Finished:    true,
		},
		secondID: {
			Task:        Task{ID: secondID, Book: "book", Kind: "creative.plan_check", Strategy: creative.PlanStrategyReadonly},
			Creative:    &creative.PreparedJob{},
			ModelSteps:  []ModelStepReceipt{role(secondID, 0)},
			StepResults: []llm.StepResult{{CallIndex: 1, Status: "failed", DurationMs: 20, Usage: nil}},
			Finished:    true,
		},
	}
	if err := s.transaction(ctx, func(st *Registry) error {
		for id, record := range records {
			st.Tasks[id] = record
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.StepMetrics(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.SchemaVersion != 1 || got.Tasks != 2 || got.Samples != 3 || len(got.Roles) != 5 {
		t.Fatalf("metrics=%+v", got)
	}
	planner := got.Roles[0]
	if planner.Admissions != 2 || planner.Results != 2 || planner.Completed != 1 || planner.Failed != 1 || planner.KnownUsage != 1 || planner.InputTokens != 10 || planner.OutputTokens != 2 || planner.DurationP50Ms == nil || *planner.DurationP50Ms != 10 || planner.DurationP95Ms == nil || *planner.DurationP95Ms != 20 {
		t.Fatalf("planner=%+v", planner)
	}
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), firstID) || strings.Contains(string(raw), secondID) || strings.Contains(string(raw), `"task"`) {
		t.Fatal("metrics leaked task identity", string(raw))
	}
	reloaded, err := (&Service{State: s.State}).StepMetrics(ctx)
	if err != nil || !reflect.DeepEqual(got, reloaded) {
		t.Fatalf("reloaded metrics=%+v error=%v", reloaded, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := (&Service{State: s.State}).StepMetrics(cancelled); err != context.Canceled {
		t.Fatal(err)
	}
}
