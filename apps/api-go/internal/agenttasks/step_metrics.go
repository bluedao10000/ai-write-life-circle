package agenttasks

import (
	"context"
	"math"
	"sort"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
)

// RoleStepMetrics is derived from the original task registry. Admissions and
// terminal results remain separate so a crash is not reported as a success.
type RoleStepMetrics struct {
	Role              string   `json:"role"`
	CallIndex         int      `json:"callIndex"`
	Admissions        int      `json:"admissions"`
	Results           int      `json:"results"`
	Completed         int      `json:"completed"`
	Failed            int      `json:"failed"`
	KnownUsage        int      `json:"knownUsage"`
	InputTokens       int      `json:"inputTokens"`
	OutputTokens      int      `json:"outputTokens"`
	CachedInputTokens int      `json:"cachedInputTokens"`
	DurationP50Ms     *float64 `json:"durationP50Ms"`
	DurationP95Ms     *float64 `json:"durationP95Ms"`
}

type StepMetrics struct {
	SchemaVersion int               `json:"schemaVersion"`
	Tasks         int               `json:"tasks"`
	Samples       int               `json:"samples"`
	Roles         []RoleStepMetrics `json:"roles"`
}

type roleStepAccumulator struct {
	RoleStepMetrics
	durations []float64
}

// StepMetrics projects bounded execution metadata from persisted task
// receipts. It does not persist a second metrics ledger, expose task identity
// or infer outcomes for admissions that never received a terminal result.
func (s *Service) StepMetrics(ctx context.Context) (StepMetrics, error) {
	if err := ctx.Err(); err != nil {
		return StepMetrics{}, err
	}
	st, err := s.load()
	if err != nil {
		return StepMetrics{}, err
	}
	byIndex := make([]roleStepAccumulator, len(modelStepRoles))
	for i, role := range modelStepRoles {
		byIndex[i].Role, byIndex[i].CallIndex = role, i+1
	}
	out := StepMetrics{SchemaVersion: 1}
	for _, record := range st.Tasks {
		if record.Task.Kind != "creative.plan_check" || record.Task.Strategy != creative.PlanStrategyReadonly {
			continue
		}
		if len(record.ModelSteps) == 0 && len(record.StepResults) == 0 {
			continue
		}
		out.Tasks++
		admitted := [5]bool{}
		for _, admission := range record.ModelSteps {
			if admission.CallIndex >= 1 && admission.CallIndex <= len(byIndex) && admission.Role == modelStepRoles[admission.CallIndex-1] {
				byIndex[admission.CallIndex-1].Admissions++
				admitted[admission.CallIndex-1] = true
			}
		}
		for _, result := range record.StepResults {
			if result.CallIndex < 1 || result.CallIndex > len(byIndex) || !admitted[result.CallIndex-1] {
				continue
			}
			role := &byIndex[result.CallIndex-1]
			role.Results++
			out.Samples++
			if result.Status == "completed" {
				role.Completed++
			} else if result.Status == "failed" {
				role.Failed++
			}
			if !math.IsNaN(result.DurationMs) && !math.IsInf(result.DurationMs, 0) && result.DurationMs >= 0 {
				role.durations = append(role.durations, result.DurationMs)
			}
			if usage := result.Usage; usage != nil {
				role.KnownUsage++
				role.InputTokens += usage.InputTokens
				role.OutputTokens += usage.OutputTokens
				role.CachedInputTokens += usage.CachedInputTokens
			}
		}
	}
	out.Roles = make([]RoleStepMetrics, len(byIndex))
	for i := range byIndex {
		byIndex[i].DurationP50Ms = durationPercentile(byIndex[i].durations, .5)
		byIndex[i].DurationP95Ms = durationPercentile(byIndex[i].durations, .95)
		out.Roles[i] = byIndex[i].RoleStepMetrics
	}
	return out, nil
}

func durationPercentile(values []float64, fraction float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	value := sorted[max(0, int(math.Ceil(float64(len(sorted))*fraction))-1)]
	return &value
}
