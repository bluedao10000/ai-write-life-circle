package agenttasks

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"testing"
)

func TestReadonlyModelStepAdmissionIsBoundedAndIdempotent(t *testing.T) {
	r := Record{Task: Task{ID: "parent", Kind: "creative.plan_check", Strategy: creative.PlanStrategyReadonly, Reserved: 10003}}
	roles := []string{"creative.plan.planner", "creative.plan.researcher", "creative.plan.analyst", "creative.plan.critic", "creative.plan.coordinator"}
	for i, role := range roles {
		limit := 2000
		if i == 4 {
			limit = 2003
		}
		step := ModelStep{Role: role, CallIndex: i + 1, ParentTaskID: "parent", MaxTokens: limit}
		bad := step
		bad.MaxTokens++
		if r.admitModelStep(bad) == nil {
			t.Fatal("expanded child budget accepted")
		}
		bad = step
		bad.ParentTaskID = "other"
		if r.admitModelStep(bad) == nil {
			t.Fatal("foreign parent accepted")
		}
		bad = step
		bad.Role = "creative.plan.coordinator"
		if i == 4 {
			bad.Role = "thinking"
		}
		if r.admitModelStep(bad) == nil {
			t.Fatal("unregistered role accepted")
		}
		if err := r.admitModelStep(step); err != nil {
			t.Fatal(err)
		}
		stamp := r.ModelSteps[i].At
		if err := r.admitModelStep(step); err != nil || len(r.ModelSteps) != i+1 || r.ModelSteps[i].At != stamp {
			t.Fatal("replay changed receipt", err)
		}
	}
	sum := 0
	for _, step := range r.ModelSteps {
		sum += step.MaxTokens
	}
	if sum != r.Task.Reserved {
		t.Fatal(sum)
	}
	r.Task.Kind = "creative.organize"
	if r.admitModelStep(r.ModelSteps[0].ModelStep) == nil {
		t.Fatal("wrong task kind accepted")
	}
}

func TestModelStepResultsRequireAdmissionAndValidUsage(t *testing.T) {
	r := Record{Task: Task{ID: "parent", Kind: "creative.plan_check", Strategy: creative.PlanStrategyReadonly, Reserved: 10000}}
	if err := r.admitModelStep(ModelStep{Role: "creative.plan.planner", CallIndex: 1, ParentTaskID: "parent", MaxTokens: 2000}); err != nil {
		t.Fatal(err)
	}
	valid := llm.StepResult{PiRunID: "00000000-0000-4000-8000-000000000001", CallIndex: 1, Status: "completed", DurationMs: 12.5, Usage: &llm.Usage{InputTokens: 100, OutputTokens: 20}}
	if err := r.validateStepResults([]llm.StepResult{valid}); err != nil {
		t.Fatal(err)
	}
	legacy := valid
	legacy.PiRunID = ""
	if err := r.validateStepResults([]llm.StepResult{legacy}); err != nil {
		t.Fatal("legacy step result was rejected", err)
	}
	unknown := valid
	unknown.Status = "failed"
	unknown.Usage = nil
	if err := r.validateStepResults([]llm.StepResult{unknown}); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*llm.StepResult){
		func(v *llm.StepResult) { v.CallIndex = 2 }, func(v *llm.StepResult) { v.Status = "private text" }, func(v *llm.StepResult) { v.DurationMs = -1 }, func(v *llm.StepResult) { v.Usage = &llm.Usage{InputTokens: 2000, OutputTokens: 1} }, func(v *llm.StepResult) { v.Usage = &llm.Usage{InputTokens: 10, CachedInputTokens: 11} },
	} {
		bad := valid
		change(&bad)
		if r.validateStepResults([]llm.StepResult{bad}) == nil {
			t.Fatal("invalid step result accepted", bad)
		}
	}
	if r.validateStepResults([]llm.StepResult{valid, valid}) == nil {
		t.Fatal("duplicate result accepted")
	}
	duplicateRun := valid
	duplicateRun.CallIndex = 2
	if r.validateStepResults([]llm.StepResult{valid, duplicateRun}) == nil {
		t.Fatal("duplicate Pi run id accepted")
	}
}

func TestPreflightAdmissionFailuresCanBecomeTerminalReceipts(t *testing.T) {
	for _, code := range []string{"AGENT_CONFIG_CHANGED", "MODEL_REQUEST_NOT_ADMITTED"} {
		if !failureAllowed(code) {
			t.Fatalf("%s must be recorded as a terminal execution failure", code)
		}
	}
}
