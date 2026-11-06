package agenttasks

import (
	"context"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
)

// RuntimeMetrics adapts the existing task-receipt projection for the private
// runtime exporter without introducing a second metrics store.
func (s *Service) RuntimeMetrics(ctx context.Context) (agentruntime.RuntimeTaskMetrics, error) {
	current, err := s.StepMetrics(ctx)
	if err != nil {
		return agentruntime.RuntimeTaskMetrics{}, err
	}
	out := agentruntime.RuntimeTaskMetrics{
		SchemaVersion: current.SchemaVersion,
		Tasks:         current.Tasks,
		Samples:       current.Samples,
		Roles:         make([]agentruntime.RuntimeRoleMetric, len(current.Roles)),
		TaskKinds:     make([]agentruntime.RuntimeTaskKindMetric, len(current.TaskKinds)),
	}
	for i, role := range current.Roles {
		out.Roles[i] = agentruntime.RuntimeRoleMetric{
			Role:              role.Role,
			CallIndex:         role.CallIndex,
			Admissions:        role.Admissions,
			Results:           role.Results,
			Completed:         role.Completed,
			Failed:            role.Failed,
			KnownUsage:        role.KnownUsage,
			InputTokens:       role.InputTokens,
			OutputTokens:      role.OutputTokens,
			CachedInputTokens: role.CachedInputTokens,
			DurationP50Ms:     role.DurationP50Ms,
			DurationP95Ms:     role.DurationP95Ms,
		}
	}
	for i, kind := range current.TaskKinds {
		out.TaskKinds[i] = agentruntime.RuntimeTaskKindMetric{
			Kind:                   kind.Kind,
			Tasks:                  kind.Tasks,
			Accepted:               kind.Accepted,
			Running:                kind.Running,
			Completed:              kind.Completed,
			Failed:                 kind.Failed,
			Interrupted:            kind.Interrupted,
			Unknown:                kind.Unknown,
			ClaimToStartedP50Ms:    kind.ClaimToStartedP50Ms,
			ClaimToStartedP95Ms:    kind.ClaimToStartedP95Ms,
			StartedToTerminalP50Ms: kind.StartedToTerminalP50Ms,
			StartedToTerminalP95Ms: kind.StartedToTerminalP95Ms,
		}
	}
	return out, nil
}
