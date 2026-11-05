package agentruntime

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type WorkerHealth struct {
	Status    string `json:"status"`
	Readiness bool   `json:"readiness"`
	Enabled   int    `json:"enabledExecutors"`
	Online    int    `json:"onlineExecutors"`
	Pending   *int   `json:"pendingTasks"`
}
type ThinkingHealth struct {
	Status    string          `json:"status"`
	Readiness bool            `json:"readiness"`
	Degraded  bool            `json:"degraded"`
	Counts    *ThinkingCounts `json:"counts"`
}
type ThinkingCounts struct {
	Active      int `json:"activeTasks"`
	Pending     int `json:"pendingAdmissions"`
	Failed      int `json:"failedSessions"`
	Unpublished int `json:"unpublishedSessions"`
	Recovery    int `json:"recoveryPending"`
}
type RuntimeHealth struct {
	Schema    int            `json:"schemaVersion"`
	Liveness  bool           `json:"liveness"`
	Readiness bool           `json:"readiness"`
	Degraded  bool           `json:"degraded"`
	Status    string         `json:"status"`
	API       string         `json:"api"`
	Provider  string         `json:"provider"`
	Worker    WorkerHealth   `json:"worker"`
	Thinking  ThinkingHealth `json:"thinking"`
}

func workerHealth(status UnifiedStatus) WorkerHealth {
	out := WorkerHealth{Status: "disabled"}
	pending, ready := 0, true
	for _, kind := range []string{"review", "knowledge", "creative", "memory"} {
		current := status.Executors[kind]
		if current.ExecutorOwner == "disabled" {
			continue
		}
		out.Enabled++
		if current.Online {
			out.Online++
			pending += current.Counts.Pending
		}
		ready = ready && current.Ready
	}
	if out.Enabled == 0 {
		return out
	}
	out.Readiness = ready
	out.Status = "degraded"
	if out.Online == 0 {
		out.Status = "unavailable"
	}
	if ready {
		out.Status = "ready"
	}
	if out.Online == out.Enabled {
		out.Pending = &pending
	}
	return out
}

func probeThinking(ctx context.Context, origin, token string) ThinkingHealth {
	if origin == "" {
		return ThinkingHealth{Status: "disabled"}
	}
	unavailable := ThinkingHealth{Status: "unavailable"}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/internal/v1/readiness", nil)
	if err != nil {
		return unavailable
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return unavailable
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusServiceUnavailable {
		return unavailable
	}
	invalid := ThinkingHealth{Status: "invalid_response"}
	data, err := io.ReadAll(io.LimitReader(res.Body, 32769))
	if err != nil {
		return unavailable
	}
	if len(data) > 32768 {
		return invalid
	}
	var body struct {
		Schema    int             `json:"schemaVersion"`
		Liveness  bool            `json:"liveness"`
		Readiness *bool           `json:"readiness"`
		Degraded  *bool           `json:"degraded"`
		Status    string          `json:"status"`
		Counts    *ThinkingCounts `json:"counts"`
	}
	if json.Unmarshal(data, &body) != nil || body.Schema != 1 || !body.Liveness || body.Readiness == nil || body.Degraded == nil || body.Counts == nil {
		return invalid
	}
	var fields struct {
		Counts map[string]json.RawMessage `json:"counts"`
	}
	if json.Unmarshal(data, &fields) != nil {
		return invalid
	}
	for _, name := range []string{"activeTasks", "pendingAdmissions", "failedSessions", "unpublishedSessions", "recoveryPending"} {
		if value, ok := fields.Counts[name]; !ok || string(value) == "null" {
			return invalid
		}
	}
	c := body.Counts
	if c.Active < 0 || c.Pending < 0 || c.Failed < 0 || c.Unpublished < 0 || c.Recovery < 0 {
		return invalid
	}
	expected := "not_ready"
	if *body.Readiness {
		expected = "ready"
		if *body.Degraded {
			expected = "degraded"
		}
	}
	if body.Status != expected || (*body.Readiness && res.StatusCode != 200) || (!*body.Readiness && res.StatusCode != 503) {
		return invalid
	}
	return ThinkingHealth{Status: body.Status, Readiness: *body.Readiness, Degraded: *body.Degraded, Counts: c}
}

// RuntimeHealthHandler is served only on the existing private loopback listener.
// It projects current authorities without storing another heartbeat or probing a model.
func RuntimeHealthHandler(state string, config llm.Config, origin, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		supplied := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || subtle.ConstantTimeCompare([]byte(supplied), []byte(token)) != 1 || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "UNAUTHORIZED"})
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		worker := workerHealth(ReadUnifiedStatus(state, config))
		thinking := probeThinking(r.Context(), origin, token)
		ready := (worker.Enabled == 0 || worker.Readiness) && (thinking.Status == "disabled" || thinking.Readiness)
		degraded := !ready || thinking.Degraded
		status := "ready"
		if degraded {
			status = "degraded"
		}
		_ = json.NewEncoder(w).Encode(RuntimeHealth{Schema: 1, Liveness: true, Readiness: ready, Degraded: degraded, Status: status, API: "ready", Provider: "not_probed", Worker: worker, Thinking: thinking})
	})
}
