package agenttasks

import (
	"math"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
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

var modelStepRoles = []string{
	"creative.plan.planner",
	"creative.plan.researcher",
	"creative.plan.analyst",
	"creative.plan.critic",
	"creative.plan.coordinator",
}

func (r *Record) admitModelStep(step ModelStep) error {
	invalid := func() error {
		return application.Fail(409, "AGENT_CONFIG_CHANGED", "Model step differs from the registered execution policy.")
	}
	if r.Task.Kind != "creative.plan_check" || r.Task.Strategy != creative.PlanStrategyReadonly || step.ParentTaskID != r.Task.ID || step.CallIndex < 1 || step.CallIndex > len(modelStepRoles) || step.Role != modelStepRoles[step.CallIndex-1] {
		return invalid()
	}
	limit := r.Task.Reserved / len(modelStepRoles)
	if step.CallIndex == len(modelStepRoles) {
		limit = r.Task.Reserved - limit*(len(modelStepRoles)-1)
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

func (r *Record) validateStepResults(results []llm.StepResult) error {
	invalid := func() error { return application.Fail(422, "LLM_INVALID_USAGE", "Invalid model step result metadata.") }
	if len(results) == 0 {
		return nil
	}
	if len(results) > 5 || r.Task.Kind != "creative.plan_check" || r.Task.Strategy != creative.PlanStrategyReadonly {
		return invalid()
	}
	seen := map[int]bool{}
	seenRunIDs := map[string]bool{}
	for _, result := range results {
		if seen[result.CallIndex] || len(result.PiRunID) > 128 || (result.PiRunID != "" && seenRunIDs[result.PiRunID]) || math.IsNaN(result.DurationMs) || math.IsInf(result.DurationMs, 0) || result.DurationMs < 0 || result.DurationMs > 180000 || (result.Status != "completed" && result.Status != "failed") {
			return invalid()
		}
		seen[result.CallIndex] = true
		if result.PiRunID != "" {
			seenRunIDs[result.PiRunID] = true
		}
		var admitted *ModelStepReceipt
		for i := range r.ModelSteps {
			if r.ModelSteps[i].CallIndex == result.CallIndex {
				admitted = &r.ModelSteps[i]
				break
			}
		}
		if admitted == nil {
			return invalid()
		}
		u := result.Usage
		if u != nil && (u.InputTokens < 0 || u.OutputTokens < 0 || u.CachedInputTokens < 0 || u.CachedInputTokens > u.InputTokens || u.InputTokens > admitted.MaxTokens || u.OutputTokens > admitted.MaxTokens-u.InputTokens) {
			return invalid()
		}
	}
	return nil
}
