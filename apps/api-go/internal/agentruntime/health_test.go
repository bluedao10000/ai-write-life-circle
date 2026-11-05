package agentruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestWorkerHealthUsesEnabledExecutorsAndFreshCounts(t *testing.T) {
	statuses := map[string]ExecutionStatus{"review": {ExecutorOwner: "pi", Ready: true, Status: Status{Online: true, Counts: Counts{Pending: 3}}}, "knowledge": {ExecutorOwner: "disabled"}, "creative": {ExecutorOwner: "disabled"}, "memory": {ExecutorOwner: "disabled"}}
	h := workerHealth(UnifiedStatus{Executors: statuses})
	if !h.Readiness || h.Pending == nil || *h.Pending != 3 || h.Enabled != 1 {
		t.Fatalf("%+v", h)
	}
	statuses["knowledge"] = ExecutionStatus{ExecutorOwner: "pi", Status: Status{Counts: Counts{Pending: 42}}}
	h = workerHealth(UnifiedStatus{Executors: statuses})
	if h.Readiness || h.Status != "degraded" || h.Pending != nil {
		t.Fatalf("stale counts reported as current: %+v", h)
	}
	for k := range statuses {
		statuses[k] = ExecutionStatus{ExecutorOwner: "disabled"}
	}
	h = workerHealth(UnifiedStatus{Executors: statuses})
	if h.Status != "disabled" || h.Pending != nil || h.Enabled != 0 {
		t.Fatalf("%+v", h)
	}
}

func TestRuntimeHealthAuthenticationAndProjection(t *testing.T) {
	var calls atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/internal/v1/readiness" || r.Header.Get("Authorization") != "Bearer private-service-token" {
			t.Error("wrong probe contract")
		}
		_, _ = w.Write([]byte(`{"schemaVersion":1,"liveness":true,"readiness":true,"degraded":true,"status":"degraded","counts":{"activeTasks":2,"pendingAdmissions":1,"failedSessions":1,"unpublishedSessions":1,"recoveryPending":3},"secret":"NEVER_RELAY","components":{"provider":"not_probed"}}`))
	}))
	defer backend.Close()
	handler := RuntimeHealthHandler(t.TempDir(), llm.Config{}, backend.URL, "private-service-token")
	for _, auth := range []string{"", "private-service-token", "Bearer wrong"} {
		req := httptest.NewRequest("GET", "/internal/v1/runtime/health", nil)
		req.Header.Set("Authorization", auth)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != 401 {
			t.Fatal(res.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("unauthorized request probed backend")
	}
	req := httptest.NewRequest("GET", "/internal/v1/runtime/health", nil)
	req.Header.Set("Authorization", "Bearer private-service-token")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	var got RuntimeHealth
	if json.Unmarshal(res.Body.Bytes(), &got) != nil || res.Code != 200 || !got.Liveness || !got.Degraded || got.Thinking.Status != "degraded" || got.Thinking.Counts.Recovery != 3 || got.Provider != "not_probed" {
		t.Fatal(res.Body.String())
	}
	if strings.Contains(res.Body.String(), "NEVER_RELAY") || strings.Contains(res.Body.String(), "private-service-token") || res.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("unsafe response")
	}
	req.Method = "POST"
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != 405 || calls.Load() != 1 {
		t.Fatal("mutation allowed")
	}
}

func TestThinkingProbeUnavailableMalformedAndNotReady(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		body string
		want string
	}{
		{"not-ready", 503, `{"schemaVersion":1,"liveness":true,"readiness":false,"degraded":false,"status":"not_ready","counts":{"activeTasks":0,"pendingAdmissions":0,"failedSessions":0,"unpublishedSessions":0,"recoveryPending":0}}`, "not_ready"},
		{"auth", 401, `{"secret":"private"}`, "unavailable"},
		{"malformed", 200, `{`, "invalid_response"},
		{"empty-counts", 200, `{"schemaVersion":1,"liveness":true,"readiness":true,"degraded":false,"status":"ready","counts":{}}`, "invalid_response"},
		{"missing", 200, `{"schemaVersion":1,"liveness":true}`, "invalid_response"},
		{"oversized", 200, strings.Repeat("x", 32769), "invalid_response"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.code); _, _ = w.Write([]byte(tc.body)) }))
			defer server.Close()
			h := probeThinking(context.Background(), server.URL, "token")
			if h.Status != tc.want || h.Readiness {
				t.Fatalf("%+v", h)
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	h := probeThinking(ctx, server.URL, "token")
	if h.Status != "unavailable" || h.Counts != nil || h.Readiness || time.Since(start) > time.Second {
		t.Fatalf("probe failed to honor deadline: %+v", h)
	}
}
