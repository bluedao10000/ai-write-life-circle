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
		if r.URL.Path != "/internal/v1/readiness" || r.Header.Get("Authorization") != "Bearer private-service-token" {
			t.Error("wrong Thinking probe contract")
		}
		_, _ = w.Write([]byte(`{"schemaVersion":1,"liveness":true,"readiness":true,"degraded":false,"status":"ready","counts":{"activeTasks":2,"pendingAdmissions":1,"failedSessions":3,"unpublishedSessions":4,"recoveryPending":5}}`))
	}))
	defer thinking.Close()

	state := t.TempDir()
	config := llm.Config{Model: "fixture"}
	policy := executorpolicy.Controller{State: state}
	for _, kind := range []string{"review", "knowledge", "creative", "memory"} {
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
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q\n%s", want, body)
		}
	}
	if strings.Contains(body, "private-task") || strings.Contains(body, "private-role") || strings.Contains(body, "private-service-token") || strings.Contains(body, thinking.URL) {
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
