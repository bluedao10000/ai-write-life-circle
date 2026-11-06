package agenttasks

import (
	"context"
	"math"
	"sort"
	"time"

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
	TaskKinds     []TaskKindMetrics `json:"taskKinds"`
}

type TaskKindMetrics struct {
	Kind                   string   `json:"kind"`
	Tasks                  int      `json:"tasks"`
	Accepted               int      `json:"accepted"`
	Running                int      `json:"running"`
	Completed              int      `json:"completed"`
	Failed                 int      `json:"failed"`
	Interrupted            int      `json:"interrupted"`
	Unknown                int      `json:"unknown"`
	ClaimToStartedP50Ms    *float64 `json:"claimToStartedP50Ms"`
	ClaimToStartedP95Ms    *float64 `json:"claimToStartedP95Ms"`
	StartedToTerminalP50Ms *float64 `json:"startedToTerminalP50Ms"`
	StartedToTerminalP95Ms *float64 `json:"startedToTerminalP95Ms"`
}

type roleStepAccumulator struct {
	RoleStepMetrics
	durations []float64
}

var taskMetricKinds = []string{
	"review.execute",
	"knowledge.extract",
	"creative.organize",
	"creative.plan_check",
	"memory.consolidate",
}

type taskKindAccumulator struct {
	TaskKindMetrics
	claimDurations    []float64
	terminalDurations []float64
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
	byKind := make([]taskKindAccumulator, len(taskMetricKinds))
	for i, kind := range taskMetricKinds {
		byKind[i].Kind = kind
	}
	out := StepMetrics{SchemaVersion: 1}
	for _, record := range st.Tasks {
		for i, kind := range taskMetricKinds {
			if record.Task.Kind == kind {
				accumulateTaskKind(&byKind[i], record)
				break
			}
		}
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
	out.TaskKinds = make([]TaskKindMetrics, len(byKind))
	for i := range byKind {
		byKind[i].ClaimToStartedP50Ms = durationPercentile(byKind[i].claimDurations, .5)
		byKind[i].ClaimToStartedP95Ms = durationPercentile(byKind[i].claimDurations, .95)
		byKind[i].StartedToTerminalP50Ms = durationPercentile(byKind[i].terminalDurations, .5)
		byKind[i].StartedToTerminalP95Ms = durationPercentile(byKind[i].terminalDurations, .95)
		out.TaskKinds[i] = byKind[i].TaskKindMetrics
	}
	return out, nil
}

func accumulateTaskKind(out *taskKindAccumulator, record Record) {
	out.Tasks++
	outcome := record.Outcome
	if outcome == "" {
		switch {
		case record.ResultHash == "expired":
			outcome = "interrupted"
		case record.Finished:
			outcome = "unknown"
		case record.Started:
			outcome = "running"
		default:
			outcome = "accepted"
		}
	}
	switch outcome {
	case "accepted":
		out.Accepted++
	case "running":
		out.Running++
	case "completed":
		out.Completed++
	case "failed":
		out.Failed++
	case "interrupted":
		out.Interrupted++
	default:
		out.Unknown++
	}
	claimed, hasClaimed := auditTime(record.Audit, "claimed")
	started, hasStarted := auditTime(record.Audit, "started")
	terminal, hasTerminal := auditTime(record.Audit, "terminal")
	if hasClaimed && hasStarted && !started.Before(claimed) {
		out.claimDurations = append(out.claimDurations, float64(started.Sub(claimed))/float64(time.Millisecond))
	}
	if hasStarted && hasTerminal && !terminal.Before(started) {
		out.terminalDurations = append(out.terminalDurations, float64(terminal.Sub(started))/float64(time.Millisecond))
	}
}

func auditTime(events []ExecutionAudit, action string) (time.Time, bool) {
	for _, event := range events {
		if event.Action == action {
			at, err := time.Parse(time.RFC3339Nano, event.At)
			return at, err == nil
		}
	}
	return time.Time{}, false
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
