package agentruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type RuntimeRoleMetric struct {
	Role              string
	CallIndex         int
	Admissions        int
	Results           int
	Completed         int
	Failed            int
	KnownUsage        int
	InputTokens       int
	OutputTokens      int
	CachedInputTokens int
	DurationP50Ms     *float64
	DurationP95Ms     *float64
}

type RuntimeTaskKindMetric struct {
	Kind                   string
	Tasks                  int
	Accepted               int
	Running                int
	Completed              int
	Failed                 int
	Interrupted            int
	Unknown                int
	ClaimToStartedP50Ms    *float64
	ClaimToStartedP95Ms    *float64
	StartedToTerminalP50Ms *float64
	StartedToTerminalP95Ms *float64
}

type RuntimeTaskMetrics struct {
	SchemaVersion int
	Tasks         int
	Samples       int
	Roles         []RuntimeRoleMetric
	TaskKinds     []RuntimeTaskKindMetric
}

type ThinkingRunMetrics struct {
	SchemaVersion         int      `json:"schemaVersion"`
	Attempts              int      `json:"attempts"`
	Accepted              int      `json:"accepted"`
	Running               int      `json:"running"`
	Checkpointed          int      `json:"checkpointed"`
	Completed             int      `json:"completed"`
	Failed                int      `json:"failed"`
	Interrupted           int      `json:"interrupted"`
	Cancelled             int      `json:"cancelled"`
	Resumed               int      `json:"resumed"`
	ModelCalls            int      `json:"modelCalls"`
	KnownUsageRequests    int      `json:"knownUsageRequests"`
	UnknownUsageRequests  int      `json:"unknownUsageRequests"`
	InputTokens           int      `json:"inputTokens"`
	OutputTokens          int      `json:"outputTokens"`
	UnknownReservedTokens int      `json:"unknownReservedTokens"`
	TerminalSamples       int      `json:"terminalSamples"`
	DurationP50Ms         *float64 `json:"durationP50Ms"`
	DurationP95Ms         *float64 `json:"durationP95Ms"`
}

type RuntimeMetricsSource func(context.Context) (RuntimeTaskMetrics, error)

var exposedTaskKinds = map[string]bool{
	"review.execute":      true,
	"knowledge.extract":   true,
	"creative.organize":   true,
	"creative.plan_check": true,
	"memory.consolidate":  true,
}

var exposedRoles = map[string]bool{
	"creative.plan.planner":     true,
	"creative.plan.researcher":  true,
	"creative.plan.analyst":     true,
	"creative.plan.critic":      true,
	"creative.plan.coordinator": true,
}

type prometheusText struct {
	body strings.Builder
}

func (p *prometheusText) family(name, help string) {
	fmt.Fprintf(&p.body, "# HELP %s %s\n# TYPE %s gauge\n", name, help, name)
}

func (p *prometheusText) sample(name, labels string, value string) {
	if labels != "" {
		fmt.Fprintf(&p.body, "%s{%s} %s\n", name, labels, value)
		return
	}
	fmt.Fprintf(&p.body, "%s %s\n", name, value)
}

func (p *prometheusText) integer(name, labels string, value int) {
	p.sample(name, labels, strconv.Itoa(value))
}

func (p *prometheusText) optionalFloat(name, labels string, value *float64) {
	if value == nil {
		return
	}
	p.sample(name, labels, strconv.FormatFloat(*value, 'f', -1, 64))
}

func label(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(value) + `"`
}

func boolValue(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

func formatRuntimeMetrics(health RuntimeHealth, metrics RuntimeTaskMetrics, thinkingRuns *ThinkingRunMetrics) string {
	var p prometheusText

	p.family("writer_agent_runtime_liveness", "Process liveness; always 1 when the private handler responds.")
	p.integer("writer_agent_runtime_liveness", "", 1)
	p.family("writer_agent_runtime_ready", "Aggregate Agent Runtime readiness derived from existing health authorities.")
	p.sample("writer_agent_runtime_ready", "", boolValue(health.Readiness))
	p.family("writer_agent_runtime_degraded", "Whether the Agent Runtime is degraded by a known component condition.")
	p.sample("writer_agent_runtime_degraded", "", boolValue(health.Degraded))

	p.family("writer_agent_worker_ready", "Whether every enabled Worker executor is ready.")
	p.sample("writer_agent_worker_ready", "", boolValue(health.Worker.Readiness))
	p.family("writer_agent_worker_executors", "Enabled and currently online Worker executors.")
	p.integer("writer_agent_worker_executors", `state="enabled"`, health.Worker.Enabled)
	p.integer("writer_agent_worker_executors", `state="online"`, health.Worker.Online)
	p.family("writer_agent_worker_pending_tasks", "Pending Worker tasks; absent when any enabled executor heartbeat is stale.")
	if health.Worker.Pending != nil {
		p.integer("writer_agent_worker_pending_tasks", "", *health.Worker.Pending)
	}

	p.family("writer_agent_thinking_ready", "Whether the Thinking readiness authority reports ready.")
	p.sample("writer_agent_thinking_ready", "", boolValue(health.Thinking.Readiness))
	p.family("writer_agent_thinking_tasks", "Thinking task and recovery counts from the existing readiness projection.")
	if counts := health.Thinking.Counts; counts != nil {
		p.integer("writer_agent_thinking_tasks", `state="active"`, counts.Active)
		p.integer("writer_agent_thinking_tasks", `state="pending_admission"`, counts.Pending)
		p.integer("writer_agent_thinking_tasks", `state="failed_session"`, counts.Failed)
		p.integer("writer_agent_thinking_tasks", `state="unpublished_session"`, counts.Unpublished)
		p.integer("writer_agent_thinking_tasks", `state="recovery_pending"`, counts.Recovery)
	}
	if thinkingRuns != nil {
		p.family("writer_agent_thinking_run_attempts", "Persisted Thinking run attempts by lifecycle state.")
		for _, state := range []struct {
			name  string
			value int
		}{{"accepted", thinkingRuns.Accepted}, {"running", thinkingRuns.Running}, {"checkpointed", thinkingRuns.Checkpointed}, {"completed", thinkingRuns.Completed}, {"failed", thinkingRuns.Failed}, {"interrupted", thinkingRuns.Interrupted}, {"cancelled", thinkingRuns.Cancelled}} {
			p.integer("writer_agent_thinking_run_attempts", `state=`+label(state.name), state.value)
		}
		p.family("writer_agent_thinking_run_resumptions", "Persisted Thinking run attempts that resumed an earlier run.")
		p.integer("writer_agent_thinking_run_resumptions", "", thinkingRuns.Resumed)
		p.family("writer_agent_thinking_run_model_calls", "Model calls recorded by persisted Thinking runs.")
		p.integer("writer_agent_thinking_run_model_calls", "", thinkingRuns.ModelCalls)
		p.family("writer_agent_thinking_model_requests", "Persisted Thinking model requests by usage settlement state.")
		p.integer("writer_agent_thinking_model_requests", `state="settled"`, thinkingRuns.KnownUsageRequests)
		p.integer("writer_agent_thinking_model_requests", `state="unknown"`, thinkingRuns.UnknownUsageRequests)
		p.family("writer_agent_thinking_model_tokens", "Known input and output tokens from settled Thinking model requests.")
		p.integer("writer_agent_thinking_model_tokens", `type="input"`, thinkingRuns.InputTokens)
		p.integer("writer_agent_thinking_model_tokens", `type="output"`, thinkingRuns.OutputTokens)
		p.family("writer_agent_thinking_model_unknown_reserved_tokens", "Conservative token reservations retained for Thinking requests with unknown usage.")
		p.integer("writer_agent_thinking_model_unknown_reserved_tokens", "", thinkingRuns.UnknownReservedTokens)
		p.family("writer_agent_thinking_run_terminal_samples", "Terminal persisted Thinking runs available for duration percentiles.")
		p.integer("writer_agent_thinking_run_terminal_samples", "", thinkingRuns.TerminalSamples)
		p.family("writer_agent_thinking_run_duration_ms", "Persisted terminal Thinking run duration by quantile.")
		p.optionalFloat("writer_agent_thinking_run_duration_ms", `quantile="0.5"`, thinkingRuns.DurationP50Ms)
		p.optionalFloat("writer_agent_thinking_run_duration_ms", `quantile="0.95"`, thinkingRuns.DurationP95Ms)
	}

	p.family("writer_agent_worker_projection_tasks", "Creative read-only tasks represented by persisted step receipts.")
	p.integer("writer_agent_worker_projection_tasks", "", metrics.Tasks)
	p.family("writer_agent_worker_projection_samples", "Completed or failed role results represented by the projection.")
	p.integer("writer_agent_worker_projection_samples", "", metrics.Samples)

	p.family("writer_agent_worker_task_receipts", "Persisted task receipts by fixed task kind and lifecycle state.")
	for _, task := range metrics.TaskKinds {
		if !exposedTaskKinds[task.Kind] {
			continue
		}
		kind := `kind=` + label(task.Kind)
		p.integer("writer_agent_worker_task_receipts", kind+`,state="accepted"`, task.Accepted)
		p.integer("writer_agent_worker_task_receipts", kind+`,state="running"`, task.Running)
		p.integer("writer_agent_worker_task_receipts", kind+`,state="completed"`, task.Completed)
		p.integer("writer_agent_worker_task_receipts", kind+`,state="failed"`, task.Failed)
		p.integer("writer_agent_worker_task_receipts", kind+`,state="interrupted"`, task.Interrupted)
		p.integer("writer_agent_worker_task_receipts", kind+`,state="unknown"`, task.Unknown)
	}

	p.family("writer_agent_worker_task_transition_ms", "Persisted task transition latency by fixed kind, transition and quantile.")
	for _, task := range metrics.TaskKinds {
		if !exposedTaskKinds[task.Kind] {
			continue
		}
		kind := `kind=` + label(task.Kind)
		p.optionalFloat("writer_agent_worker_task_transition_ms", kind+`,transition="claim_to_started",quantile="0.5"`, task.ClaimToStartedP50Ms)
		p.optionalFloat("writer_agent_worker_task_transition_ms", kind+`,transition="claim_to_started",quantile="0.95"`, task.ClaimToStartedP95Ms)
		p.optionalFloat("writer_agent_worker_task_transition_ms", kind+`,transition="started_to_terminal",quantile="0.5"`, task.StartedToTerminalP50Ms)
		p.optionalFloat("writer_agent_worker_task_transition_ms", kind+`,transition="started_to_terminal",quantile="0.95"`, task.StartedToTerminalP95Ms)
	}

	p.family("writer_agent_worker_role_steps", "Persisted read-only role admissions and terminal results.")
	p.family("writer_agent_worker_role_tokens", "Known token totals from persisted read-only role results.")
	p.family("writer_agent_worker_role_duration_ms", "Persisted read-only role result duration by quantile.")
	for _, role := range metrics.Roles {
		if !exposedRoles[role.Role] {
			continue
		}
		current := `role=` + label(role.Role)
		p.integer("writer_agent_worker_role_steps", current+`,state="admission"`, role.Admissions)
		p.integer("writer_agent_worker_role_steps", current+`,state="result"`, role.Results)
		p.integer("writer_agent_worker_role_steps", current+`,state="completed"`, role.Completed)
		p.integer("writer_agent_worker_role_steps", current+`,state="failed"`, role.Failed)
		p.integer("writer_agent_worker_role_steps", current+`,state="known_usage"`, role.KnownUsage)
		p.integer("writer_agent_worker_role_tokens", current+`,type="input"`, role.InputTokens)
		p.integer("writer_agent_worker_role_tokens", current+`,type="output"`, role.OutputTokens)
		p.integer("writer_agent_worker_role_tokens", current+`,type="cached_input"`, role.CachedInputTokens)
		p.optionalFloat("writer_agent_worker_role_duration_ms", current+`,quantile="0.5"`, role.DurationP50Ms)
		p.optionalFloat("writer_agent_worker_role_duration_ms", current+`,quantile="0.95"`, role.DurationP95Ms)
	}
	return p.body.String()
}

func probeThinkingRunMetrics(ctx context.Context, origin, token string) *ThinkingRunMetrics {
	if origin == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/internal/v1/diagnostics", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 32769))
	if err != nil || len(data) > 32768 {
		return nil
	}
	var response struct {
		Metrics struct {
			Persisted struct {
				ThinkingRuns json.RawMessage `json:"thinkingRuns"`
			} `json:"persisted"`
		} `json:"metrics"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil
	}
	rawMetrics := response.Metrics.Persisted.ThinkingRuns
	if len(rawMetrics) == 0 {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(rawMetrics, &fields); err != nil {
		return nil
	}
	for _, name := range []string{"schemaVersion", "attempts", "accepted", "running", "checkpointed", "completed", "failed", "interrupted", "cancelled", "resumed", "modelCalls", "knownUsageRequests", "unknownUsageRequests", "inputTokens", "outputTokens", "unknownReservedTokens", "terminalSamples", "durationP50Ms", "durationP95Ms"} {
		if _, ok := fields[name]; !ok {
			return nil
		}
	}
	for _, name := range []string{"schemaVersion", "attempts", "accepted", "running", "checkpointed", "completed", "failed", "interrupted", "cancelled", "resumed", "modelCalls", "knownUsageRequests", "unknownUsageRequests", "inputTokens", "outputTokens", "unknownReservedTokens", "terminalSamples"} {
		if strings.TrimSpace(string(fields[name])) == "null" {
			return nil
		}
	}
	var value ThinkingRunMetrics
	if err := json.Unmarshal(rawMetrics, &value); err != nil || value.SchemaVersion != 1 {
		return nil
	}
	values := []int{value.Attempts, value.Accepted, value.Running, value.Checkpointed, value.Completed, value.Failed, value.Interrupted, value.Cancelled, value.Resumed, value.ModelCalls, value.KnownUsageRequests, value.UnknownUsageRequests, value.InputTokens, value.OutputTokens, value.UnknownReservedTokens, value.TerminalSamples}
	for _, count := range values {
		if count < 0 {
			return nil
		}
	}
	terminal := value.Completed + value.Failed + value.Interrupted + value.Cancelled
	if value.Attempts != value.Accepted+value.Running+value.Checkpointed+terminal || value.TerminalSamples != terminal || value.Resumed > value.Attempts {
		return nil
	}
	if value.TerminalSamples == 0 {
		if value.DurationP50Ms != nil || value.DurationP95Ms != nil {
			return nil
		}
	} else if value.DurationP50Ms == nil || value.DurationP95Ms == nil || math.IsNaN(*value.DurationP50Ms) || math.IsInf(*value.DurationP50Ms, 0) || math.IsNaN(*value.DurationP95Ms) || math.IsInf(*value.DurationP95Ms, 0) || *value.DurationP50Ms < 0 || *value.DurationP95Ms < *value.DurationP50Ms {
		return nil
	}
	return &value
}

// RuntimeMetricsHandler is served only by the loopback private listener. It
// renders current authorities on demand; no metric history or scrape ledger is
// persisted in the application.
func RuntimeMetricsHandler(state string, config llm.Config, origin, token string, source RuntimeMetricsSource) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !authorizePrivateGET(w, r, token) {
			return
		}
		if source == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		metrics, err := source(r.Context())
		if err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		health := readRuntimeHealth(r.Context(), state, config, origin, token)
		thinkingRuns := probeThinkingRunMetrics(r.Context(), origin, token)
		_, _ = w.Write([]byte(formatRuntimeMetrics(health, metrics, thinkingRuns)))
	})
}
