package agenttasks

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
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
