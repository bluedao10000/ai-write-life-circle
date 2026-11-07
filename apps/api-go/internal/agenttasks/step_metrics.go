package agenttasks

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
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
	SchemaVersion int                `json:"schemaVersion"`
	SampledAt     string             `json:"sampledAt"`
	Tasks         int                `json:"tasks"`
	Samples       int                `json:"samples"`
	Roles         []RoleStepMetrics  `json:"roles"`
	TaskKinds     []TaskKindMetrics  `json:"taskKinds"`
	Windows       []StepMetricWindow `json:"windows"`
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

type StepMetricWindow struct {
	Window    string                  `json:"window"`
	Duration  string                  `json:"duration"`
	TaskKinds []TaskKindWindowMetrics `json:"taskKinds"`
	Roles     []RoleStepWindowMetrics `json:"roles"`
}

type TaskKindWindowMetrics struct {
	Kind                     string   `json:"kind"`
	Claimed                  int      `json:"claimed"`
	Started                  int      `json:"started"`
	Completed                int      `json:"completed"`
	Failed                   int      `json:"failed"`
	Interrupted              int      `json:"interrupted"`
	Unknown                  int      `json:"unknown"`
	ClaimToStartedSamples    int      `json:"claimToStartedSamples"`
	ClaimToStartedP50Ms      *float64 `json:"claimToStartedP50Ms,omitempty"`
	ClaimToStartedP95Ms      *float64 `json:"claimToStartedP95Ms,omitempty"`
	StartedToTerminalSamples int      `json:"startedToTerminalSamples"`
	StartedToTerminalP50Ms   *float64 `json:"startedToTerminalP50Ms,omitempty"`
	StartedToTerminalP95Ms   *float64 `json:"startedToTerminalP95Ms,omitempty"`
}

type RoleStepWindowMetrics struct {
	Role                  string   `json:"role"`
	Admissions            int      `json:"admissions"`
	Results               int      `json:"results"`
	Completed             int      `json:"completed"`
	Failed                int      `json:"failed"`
	KnownUsage            int      `json:"knownUsage"`
	UnknownUsage          int      `json:"unknownUsage"`
	ReservedTokens        int      `json:"reservedTokens"`
	UnknownReservedTokens int      `json:"unknownReservedTokens"`
	InputTokens           int      `json:"inputTokens"`
	OutputTokens          int      `json:"outputTokens"`
	CachedInputTokens     int      `json:"cachedInputTokens"`
	DurationSamples       int      `json:"durationSamples"`
	DurationP50Ms         *float64 `json:"durationP50Ms,omitempty"`
	DurationP95Ms         *float64 `json:"durationP95Ms,omitempty"`
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

type taskKindWindowAccumulator struct {
	TaskKindWindowMetrics
	claimDurations    []float64
	terminalDurations []float64
}

type roleStepWindowAccumulator struct {
	RoleStepWindowMetrics
	durations []float64
}

type stepMetricWindowAccumulator struct {
	StepMetricWindow
	taskKinds []taskKindWindowAccumulator
	roles     []roleStepWindowAccumulator
}

var metricWindows = []struct {
	name     string
	duration time.Duration
}{
	{name: "24h", duration: 24 * time.Hour},
	{name: "7d", duration: 7 * 24 * time.Hour},
}

// StepMetrics projects bounded execution metadata from persisted task
// receipts. It does not persist a second metrics ledger, expose task identity
// or infer outcomes for admissions that never received a terminal result.
func (s *Service) StepMetrics(ctx context.Context) (StepMetrics, error) {
	return s.stepMetricsAt(ctx, time.Now().UTC())
}

func (s *Service) stepMetricsAt(ctx context.Context, sampledAt time.Time) (StepMetrics, error) {
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
	sampledAt = sampledAt.UTC()
	out := StepMetrics{SchemaVersion: 1, SampledAt: sampledAt.Format(time.RFC3339Nano)}
	windowAccumulators := make([]stepMetricWindowAccumulator, 0, len(metricWindows))
	for _, window := range metricWindows {
		windowAccumulators = append(windowAccumulators, newStepMetricWindow(window.name, window.duration))
	}
	for _, record := range st.Tasks {
		for i, kind := range taskMetricKinds {
			if record.Task.Kind == kind {
				accumulateTaskKind(&byKind[i], record)
				break
			}
		}
		for i := range windowAccumulators {
			accumulateTaskKindWindow(&windowAccumulators[i], record, sampledAt, metricWindows[i].duration)
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
		for i := range windowAccumulators {
			accumulateRoleWindow(&windowAccumulators[i], record, sampledAt, metricWindows[i].duration)
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
	out.Windows = make([]StepMetricWindow, len(windowAccumulators))
	for i := range windowAccumulators {
		finishStepMetricWindow(&windowAccumulators[i])
		out.Windows[i] = windowAccumulators[i].StepMetricWindow
	}
	return out, nil
}

func newStepMetricWindow(name string, duration time.Duration) stepMetricWindowAccumulator {
	out := stepMetricWindowAccumulator{
		StepMetricWindow: StepMetricWindow{Window: name, Duration: duration.String()},
		taskKinds:        make([]taskKindWindowAccumulator, len(taskMetricKinds)),
		roles:            make([]roleStepWindowAccumulator, len(modelStepRoles)),
	}
	for i, kind := range taskMetricKinds {
		out.taskKinds[i].Kind = kind
	}
	for i, role := range modelStepRoles {
		out.roles[i].Role = role
	}
	return out
}

func finishStepMetricWindow(window *stepMetricWindowAccumulator) {
	window.TaskKinds = make([]TaskKindWindowMetrics, len(window.taskKinds))
	for i := range window.taskKinds {
		value := &window.taskKinds[i]
		value.ClaimToStartedSamples = len(value.claimDurations)
		value.ClaimToStartedP50Ms = durationPercentile(value.claimDurations, .5)
		value.ClaimToStartedP95Ms = durationPercentile(value.claimDurations, .95)
		value.StartedToTerminalSamples = len(value.terminalDurations)
		value.StartedToTerminalP50Ms = durationPercentile(value.terminalDurations, .5)
		value.StartedToTerminalP95Ms = durationPercentile(value.terminalDurations, .95)
		window.TaskKinds[i] = value.TaskKindWindowMetrics
	}
	window.Roles = make([]RoleStepWindowMetrics, len(window.roles))
	for i := range window.roles {
		value := &window.roles[i]
		value.DurationSamples = len(value.durations)
		value.DurationP50Ms = durationPercentile(value.durations, .5)
		value.DurationP95Ms = durationPercentile(value.durations, .95)
		window.Roles[i] = value.RoleStepWindowMetrics
	}
}

func accumulateTaskKind(out *taskKindAccumulator, record Record) {
	out.Tasks++
	outcome := taskOutcome(record)
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

func taskOutcome(record Record) string {
	if record.Outcome != "" {
		return record.Outcome
	}
	switch {
	case record.ResultHash == "expired":
		return "interrupted"
	case record.Finished:
		return "unknown"
	case record.Started:
		return "running"
	default:
		return "accepted"
	}
}

func accumulateTaskKindWindow(out *stepMetricWindowAccumulator, record Record, sampledAt time.Time, duration time.Duration) {
	index := -1
	for i, kind := range taskMetricKinds {
		if kind == record.Task.Kind {
			index = i
			break
		}
	}
	if index < 0 {
		return
	}
	metrics := &out.taskKinds[index]
	claimed, hasClaimed := auditTime(record.Audit, "claimed")
	started, hasStarted := auditTime(record.Audit, "started")
	terminal, hasTerminal := auditTime(record.Audit, "terminal")
	if hasClaimed && inMetricWindow(claimed, sampledAt, duration) {
		metrics.Claimed++
	}
	if hasStarted && inMetricWindow(started, sampledAt, duration) {
		metrics.Started++
		if hasClaimed && !claimed.After(sampledAt) && !started.Before(claimed) {
			metrics.claimDurations = append(metrics.claimDurations, float64(started.Sub(claimed))/float64(time.Millisecond))
		}
	}
	if !hasTerminal || !inMetricWindow(terminal, sampledAt, duration) {
		return
	}
	switch taskOutcome(record) {
	case "completed":
		metrics.Completed++
	case "failed":
		metrics.Failed++
	case "interrupted":
		metrics.Interrupted++
	default:
		metrics.Unknown++
	}
	if hasStarted && !started.After(sampledAt) && !terminal.Before(started) {
		metrics.terminalDurations = append(metrics.terminalDurations, float64(terminal.Sub(started))/float64(time.Millisecond))
	}
}

func accumulateRoleWindow(out *stepMetricWindowAccumulator, record Record, sampledAt time.Time, duration time.Duration) {
	var admissions [5]*ModelStepReceipt
	for i := range record.ModelSteps {
		admission := &record.ModelSteps[i]
		index := admission.CallIndex - 1
		if index < 0 || index >= len(out.roles) || admission.Role != modelStepRoles[index] || admission.ParentTaskID != record.Task.ID {
			continue
		}
		admissions[index] = admission
		at, err := time.Parse(time.RFC3339Nano, admission.At)
		if err != nil || !inMetricWindow(at, sampledAt, duration) {
			continue
		}
		role := &out.roles[index]
		role.Admissions++
		if admission.MaxTokens > 0 {
			role.ReservedTokens += admission.MaxTokens
		}
	}

	terminal, hasTerminal := auditTime(record.Audit, "terminal")
	if !hasTerminal || !inMetricWindow(terminal, sampledAt, duration) {
		return
	}
	var results [5]*llm.StepResult
	for i := range record.StepResults {
		result := &record.StepResults[i]
		index := result.CallIndex - 1
		if index >= 0 && index < len(results) && admissions[index] != nil {
			results[index] = result
		}
	}
	for index, admission := range admissions {
		if admission == nil {
			continue
		}
		role := &out.roles[index]
		result := results[index]
		if result == nil {
			role.UnknownUsage++
			if admission.MaxTokens > 0 {
				role.UnknownReservedTokens += admission.MaxTokens
			}
			continue
		}
		role.Results++
		if result.Status == "completed" {
			role.Completed++
		} else if result.Status == "failed" {
			role.Failed++
		}
		if result.Usage == nil {
			role.UnknownUsage++
			if admission.MaxTokens > 0 {
				role.UnknownReservedTokens += admission.MaxTokens
			}
		} else {
			role.KnownUsage++
			role.InputTokens += result.Usage.InputTokens
			role.OutputTokens += result.Usage.OutputTokens
			role.CachedInputTokens += result.Usage.CachedInputTokens
		}
		if !math.IsNaN(result.DurationMs) && !math.IsInf(result.DurationMs, 0) && result.DurationMs >= 0 {
			role.durations = append(role.durations, result.DurationMs)
		}
	}
}

func inMetricWindow(at, sampledAt time.Time, duration time.Duration) bool {
	return !at.After(sampledAt) && !at.Before(sampledAt.Add(-duration))
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
