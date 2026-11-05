package agenttasks

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"time"
)

type ModelStep struct {
	Role         string `json:"role"`
	CallIndex    int    `json:"callIndex"`
	ParentTaskID string `json:"parentTaskId"`
	MaxTokens    int    `json:"maxTokens"`
}
type ModelStepReceipt struct {
	ModelStep
	At string `json:"at"`
}

func (r *Record) admitModelStep(step ModelStep) error {
	invalid := func() error {
		return application.Fail(409, "AGENT_CONFIG_CHANGED", "Model step differs from the registered execution policy.")
	}
	roles := []string{"creative.plan.planner", "creative.plan.researcher", "creative.plan.analyst", "creative.plan.critic", "creative.plan.coordinator"}
	if r.Task.Kind != "creative.plan_check" || r.Task.Strategy != creative.PlanStrategyReadonly || step.ParentTaskID != r.Task.ID || step.CallIndex < 1 || step.CallIndex > len(roles) || step.Role != roles[step.CallIndex-1] {
		return invalid()
	}
	limit := r.Task.Reserved / len(roles)
	if step.CallIndex == len(roles) {
		limit = r.Task.Reserved - limit*(len(roles)-1)
	}
	if step.MaxTokens < 1 || step.MaxTokens != limit {
		return invalid()
	}
	for _, prior := range r.ModelSteps {
		if prior.CallIndex == step.CallIndex {
			if prior.ModelStep != step {
				return invalid()
			}
			return nil
		}
	}
	if (step.CallIndex > 1 && len(r.ModelSteps) == 0) || (step.CallIndex == 5 && len(r.ModelSteps) != 4) {
		return invalid()
	}
	r.ModelSteps = append(r.ModelSteps, ModelStepReceipt{ModelStep: step, At: time.Now().UTC().Format(time.RFC3339Nano)})
	return nil
}
