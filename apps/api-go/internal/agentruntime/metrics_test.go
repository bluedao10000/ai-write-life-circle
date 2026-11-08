package agentruntime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

func TestRuntimeMetricsHandlerProjectsAuthoritiesAndRejectsUnauthorizedReads(t *testing.T) {
	ctx := context.Background()
	var thinkingCalls atomic.Int32
	thinking := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		thinkingCalls.Add(1)
		if r.Header.Get("Authorization") != "Bearer private-service-token" {
			t.Error("wrong Thinking probe contract")
		}
		switch r.URL.Path {
		case "/internal/v1/readiness":
			_, _ = w.Write([]byte(`{"schemaVersion":1,"liveness":true,"readiness":true,"degraded":false,"status":"ready","counts":{"activeTasks":2,"pendingAdmissions":1,"failedSessions":3,"unpublishedSessions":4,"recoveryPending":5}}`))
		case "/internal/v1/diagnostics":
			_, _ = w.Write([]byte(`{"metrics":{"persisted":{"thinkingRuns":{"schemaVersion":1,"attempts":4,"accepted":1,"running":0,"checkpointed":0,"completed":1,"failed":1,"interrupted":1,"cancelled":0,"resumed":1,"modelCalls":7,"knownUsageRequests":3,"unknownUsageRequests":1,"inputTokens":900,"outputTokens":250,"unknownReservedTokens":4096,"terminalSamples":3,"durationP50Ms":12,"durationP95Ms":90}}}}`))
		default:
			t.Errorf("unexpected Thinking path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer thinking.Close()

	state := t.TempDir()
	config := llm.Config{Model: "fixture"}
	policy := executorpolicy.Controller{State: state}
	for _, kind := range []string{"review", "knowledge", "creative", "memory", "analysis"} {
		if err := policy.Drain(ctx, kind); err != nil {
			t.Fatal(err)
		}
		if err := policy.Switch(ctx, kind, "disabled"); err != nil {
			t.Fatal(err)
		}
	}
	if err := policy.Drain(ctx, "review"); err != nil {
		t.Fatal(err)
	}
	if err := policy.Switch(ctx, "review", "pi"); err != nil {
		t.Fatal(err)
	}
	worker := PiWorkerStatus{
		Status: Status{Protocol: executorpolicy.Protocol, At: time.Now().UTC().Format(time.RFC3339Nano), Online: true, Config: config.Fingerprint(), Counts: Counts{Pending: 2}},
		Ready:  true,
		Kinds:  []string{"review"},
		ByKind: map[string]Counts{"review": {Pending: 2, Running: 1, Completed: 7}},
	}
	if err := storage.Write(ctx, PiStatusPath(state), worker); err != nil {
		t.Fatal(err)
	}

	var sourceCalls atomic.Int32
	source := func(context.Context) (RuntimeTaskMetrics, error) {
		sourceCalls.Add(1)
		return RuntimeTaskMetrics{
			SchemaVersion: 1,
			Tasks:         2,
			Samples:       5,
			TaskKinds: []RuntimeTaskKindMetric{
				{Kind: "review.execute", Tasks: 2, Completed: 1, Failed: 1, ClaimToStartedP50Ms: floatPointer(12), ClaimToStartedP95Ms: floatPointer(20)},
				{Kind: `private-task",state="injected`, Completed: 99},
			},
			Roles: []RuntimeRoleMetric{
				{Role: "creative.plan.researcher", CallIndex: 2, Admissions: 2, Results: 2, Completed: 1, Failed: 1, KnownUsage: 1, InputTokens: 100, OutputTokens: 20, CachedInputTokens: 30, DurationP50Ms: floatPointer(40), DurationP95Ms: floatPointer(50)},
				{Role: `private-role",state="injected`, Admissions: 99},
			},
			Windows: []RuntimeTaskMetricWindow{
				{
					Window: "24h",
					TaskKinds: []RuntimeTaskKindWindowMetric{
						{Kind: "review.execute", Claimed: 4, Started: 3, Completed: 2, Failed: 1, ClaimToStartedSamples: 2, ClaimToStartedP50Ms: floatPointer(12), ClaimToStartedP95Ms: floatPointer(20), StartedToTerminalSamples: 2, StartedToTerminalP50Ms: floatPointer(30), StartedToTerminalP95Ms: floatPointer(80)},
						{Kind: `private-task",state="injected`, Claimed: 99},
					},
					Roles: []RuntimeRoleWindowMetric{
						{Role: "creative.plan.researcher", Admissions: 3, Results: 2, Completed: 1, Failed: 1, KnownUsage: 1, UnknownUsage: 1, ReservedTokens: 1200, UnknownReservedTokens: 800, InputTokens: 100, OutputTokens: 20, CachedInputTokens: 30, DurationSamples: 2, DurationP50Ms: floatPointer(40), DurationP95Ms: floatPointer(70)},
						{Role: `private-role",state="injected`, Admissions: 99},
					},
				},
				{Window: `private-window",state="injected`},
			},
		}, nil
	}
	handler := RuntimeMetricsHandler(state, config, thinking.URL, "private-service-token", source)

	for _, auth := range []string{"", "private-service-token", "Bearer wrong"} {
		req := httptest.NewRequest(http.MethodGet, "/internal/v1/runtime/metrics", nil)
		req.Header.Set("Authorization", auth)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != http.StatusUnauthorized {
			t.Fatalf("auth %q: %d", auth, res.Code)
		}
	}
	if sourceCalls.Load() != 0 || thinkingCalls.Load() != 0 {
		t.Fatal("unauthorized scrape read authorities")
	}

	req := httptest.NewRequest(http.MethodGet, "/internal/v1/runtime/metrics", nil)
	req.Header.Set("Authorization", "Bearer private-service-token")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	body := res.Body.String()
	if res.Code != http.StatusOK || res.Header().Get("Content-Type") != "text/plain; version=0.0.4; charset=utf-8" || res.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unexpected response: %d %q %q", res.Code, res.Header().Get("Content-Type"), body)
	}
	for _, want := range []string{
		"writer_agent_runtime_liveness 1\n",
		"writer_agent_runtime_ready 1\n",
		"writer_agent_runtime_degraded 0\n",
		`writer_agent_worker_executors{state="enabled"} 1`,
		`writer_agent_worker_executors{state="online"} 1`,
		"writer_agent_worker_pending_tasks 2",
		`writer_agent_thinking_tasks{state="recovery_pending"} 5`,
		"writer_agent_worker_projection_tasks 2",
		"writer_agent_worker_projection_samples 5",
		`writer_agent_worker_task_receipts{kind="review.execute",state="completed"} 1`,
		`writer_agent_worker_task_transition_ms{kind="review.execute",transition="claim_to_started",quantile="0.95"} 20`,
		`writer_agent_worker_role_steps{role="creative.plan.researcher",state="admission"} 2`,
		`writer_agent_worker_role_tokens{role="creative.plan.researcher",type="cached_input"} 30`,
		`writer_agent_worker_role_duration_ms{role="creative.plan.researcher",quantile="0.95"} 50`,
		`writer_agent_worker_window_task_events{window="24h",kind="review.execute",state="claimed"} 4`,
		`writer_agent_worker_window_task_transition_samples{window="24h",kind="review.execute",transition="claim_to_started"} 2`,
		`writer_agent_worker_window_task_transition_ms{window="24h",kind="review.execute",transition="started_to_terminal",quantile="0.95"} 80`,
		`writer_agent_worker_window_role_events{window="24h",role="creative.plan.researcher",state="unknown_usage"} 1`,
		`writer_agent_worker_window_role_tokens{window="24h",role="creative.plan.researcher",type="reserved"} 1200`,
		`writer_agent_worker_window_role_tokens{window="24h",role="creative.plan.researcher",type="unknown_reserved"} 800`,
		`writer_agent_worker_window_role_duration_samples{window="24h",role="creative.plan.researcher"} 2`,
		`writer_agent_worker_window_role_duration_ms{window="24h",role="creative.plan.researcher",quantile="0.95"} 70`,
		`writer_agent_thinking_run_attempts{state="accepted"} 1`,
		`writer_agent_thinking_run_attempts{state="failed"} 1`,
		"writer_agent_thinking_run_resumptions 1",
		"writer_agent_thinking_run_model_calls 7",
		`writer_agent_thinking_model_requests{state="settled"} 3`,
		`writer_agent_thinking_model_requests{state="unknown"} 1`,
		`writer_agent_thinking_model_tokens{type="input"} 900`,
		`writer_agent_thinking_model_tokens{type="output"} 250`,
		"writer_agent_thinking_model_unknown_reserved_tokens 4096",
		"writer_agent_thinking_run_terminal_samples 3",
		`writer_agent_thinking_run_duration_ms{quantile="0.95"} 90`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q\n%s", want, body)
		}
	}
	if strings.Contains(body, "private-task") || strings.Contains(body, "private-role") || strings.Contains(body, "private-window") || strings.Contains(body, "private-service-token") || strings.Contains(body, thinking.URL) {
		t.Fatal("private label or credential leaked")
	}

	req = httptest.NewRequest(http.MethodPost, "/internal/v1/runtime/metrics", nil)
	req.Header.Set("Authorization", "Bearer private-service-token")
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusMethodNotAllowed || res.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("mutation accepted: %d", res.Code)
	}
}

func TestProbeThinkingRunMetricsOmitsInvalidOrUnavailableProjection(t *testing.T) {
	for _, body := range []string{
		`{"metrics":{"persisted":{"thinkingRuns":{"schemaVersion":1,"attempts":2,"accepted":0,"running":0,"checkpointed":0,"completed":1,"failed":0,"interrupted":0,"cancelled":0,"resumed":0,"modelCalls":1,"knownUsageRequests":1,"unknownUsageRequests":0,"inputTokens":10,"outputTokens":5,"unknownReservedTokens":0,"terminalSamples":1,"durationP50Ms":20,"durationP95Ms":10}}}}`,
		`{"metrics":{"persisted":{"thinkingRuns":{"schemaVersion":2}}}}`,
		`{"metrics":{"persisted":{"thinkingRuns":{"schemaVersion":1}}}}`,
		`{"metrics":{"persisted":{}}}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) }))
		if got := probeThinkingRunMetrics(context.Background(), server.URL, "token"); got != nil {
			t.Fatalf("invalid projection accepted: %+v", got)
		}
		server.Close()
	}
	if got := probeThinkingRunMetrics(context.Background(), "", "token"); got != nil {
		t.Fatalf("missing Thinking origin returned metrics: %+v", got)
	}
}

func TestRuntimeMetricsHandlerFailsClosedWithoutLeakingSourceError(t *testing.T) {
	handler := RuntimeMetricsHandler(t.TempDir(), llm.Config{}, "", "private-service-token", func(context.Context) (RuntimeTaskMetrics, error) {
		return RuntimeTaskMetrics{}, context.DeadlineExceeded
	})
	req := httptest.NewRequest(http.MethodGet, "/internal/v1/runtime/metrics", nil)
	req.Header.Set("Authorization", "Bearer private-service-token")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusServiceUnavailable || res.Body.Len() != 0 {
		t.Fatalf("source failure exposed: %d %q", res.Code, res.Body.String())
	}
}

func floatPointer(value float64) *float64 {
	return &value
}
