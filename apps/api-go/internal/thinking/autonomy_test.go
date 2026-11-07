package thinking

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

func TestValidateAutonomyAdmission(t *testing.T) {
	toolCalling := true
	deadline := 4000
	model := Model{
		ToolCalling: &toolCalling,
		Limits:      Limits{Turns: 4, Tools: 3, Duration: 5000},
	}
	valid := Message{
		Text: "核对连续性",
		Autonomy: &Autonomy{
			CompletionCriteria: "给出结论并说明依据",
			ApproveReadOnly:    true,
			MaxSteps:           1,
			DeadlineMs:         &deadline,
		},
	}
	if err := validateAutonomy(valid, model, []string{"chapters"}); err != nil {
		t.Fatalf("valid autonomy rejected: %v", err)
	}
	if err := validateAutonomy(Message{Text: valid.Text}, model, []string{"chapters"}); err != nil {
		t.Fatalf("ordinary message rejected: %v", err)
	}
	model.Limits.Tools = 1
	if err := validateAutonomy(valid, model, []string{"chapters"}); err != nil {
		t.Fatalf("one evidence call must fit the exact one-tool budget: %v", err)
	}

	tests := []struct {
		name   string
		input  Message
		scopes []string
		model  Model
		code   string
	}{
		{
			name:   "missing approval",
			input:  Message{Autonomy: &Autonomy{CompletionCriteria: "给出结论", MaxSteps: 1}},
			scopes: []string{"knowledge"},
			model:  model,
			code:   "VALIDATION_FAILED",
		},
		{
			name:   "no readable scope",
			input:  valid,
			scopes: nil,
			model:  model,
			code:   "AUTONOMY_LIMIT_EXCEEDED",
		},
		{
			name:   "selection would read before plan",
			input:  Message{Autonomy: valid.Autonomy, Selection: &Selection{Chapter: "ch-1"}},
			scopes: []string{"chapters"},
			model:  model,
			code:   "VALIDATION_FAILED",
		},
		{
			name:   "step overflow",
			input:  Message{Autonomy: &Autonomy{CompletionCriteria: "给出结论", ApproveReadOnly: true, MaxSteps: 2}},
			scopes: []string{"knowledge"},
			model:  model,
			code:   "AUTONOMY_LIMIT_EXCEEDED",
		},
		{
			name:   "deadline overflow",
			input:  Message{Autonomy: &Autonomy{CompletionCriteria: "给出结论", ApproveReadOnly: true, MaxSteps: 1, DeadlineMs: ptr(5001)}},
			scopes: []string{"knowledge"},
			model:  model,
			code:   "AUTONOMY_LIMIT_EXCEEDED",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateAutonomy(test.input, test.model, test.scopes)
			if err == nil || application.AsError(err).Code != test.code {
				t.Fatalf("got %v, want %s", err, test.code)
			}
		})
	}
}

func TestAutonomyDoesNotQueueCreativeIntake(t *testing.T) {
	s, rec, _ := fixture(t)
	toolCalling := true
	model := Model{
		Provider:    "fixture",
		Model:       "synthetic",
		Endpoint:    "http://127.0.0.1",
		Protocol:    Protocol,
		ToolCalling: &toolCalling,
		Limits:      Limits{Tools: 3, Turns: 4, Duration: 10000},
	}
	rec.Model = model
	if err := s.tx(context.Background(), func(st *registry) error {
		st.Sessions[rec.ID] = rec
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/internal/v1/health":
			_ = json.NewEncoder(w).Encode(map[string]any{"protocol": Protocol, "model": model})
		case r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "idle",
				"model":  model,
				"scopes": rec.Scopes,
				"usage":  map[string]any{"input": 0, "output": 0, "charged": 0, "incomplete": false},
				"run": map[string]any{
					"runId":                "11111111-1111-4111-8111-111111111111",
					"messageId":            "msg-autonomy",
					"authorizationVersion": 0,
					"status":               "failed",
					"resumable":            true,
					"failure":              map[string]any{"retryable": true},
				},
				"messages": []map[string]any{{
					"id":       "msg-autonomy",
					"role":     "user",
					"autonomy": map[string]any{"status": "failed"},
				}},
			})
		case r.Method == http.MethodPost && (strings.HasSuffix(r.URL.Path, "/messages") || strings.HasSuffix(r.URL.Path, "/resume")):
			_, _ = w.Write([]byte(`{"messageId":"msg-autonomy"}`))
		default:
			t.Error(r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer node.Close()
	s.Origin = node.URL
	s.ServiceToken = strings.Repeat("t", 64)
	s.ResolveActor = func(*http.Request) *application.Actor {
		return &application.Actor{ID: rec.Owner, Role: "author"}
	}
	intakes := 0
	s.OnMessageAccepted = func(context.Context, Record, string) error {
		intakes++
		return nil
	}
	request := func(action, key, body string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/v1/studio/books/"+rec.Book+"/thinking/sessions/"+rec.ID+"/"+action, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		s.PublicHandler().ServeHTTP(w, r)
		if w.Code != http.StatusAccepted {
			t.Fatalf("%s: %d %s", key, w.Code, w.Body.String())
		}
	}
	request("messages", "ordinary", `{"text":"普通讨论"}`)
	request("messages", "autonomy", `{"text":"只读核对连续性","autonomy":{"completionCriteria":"给出结论并说明依据","approveReadOnlyTools":true,"maxSteps":1}}`)
	request("resume", "autonomy-resume", `{"runId":"11111111-1111-4111-8111-111111111111","confirmAdditionalCost":true}`)
	request("resume", "autonomy-resume", `{"runId":"11111111-1111-4111-8111-111111111111","confirmAdditionalCost":true}`)
	if intakes != 1 {
		t.Fatalf("autonomy, its resume, or a resume replay entered creative intake: %d hook calls", intakes)
	}
	st, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Sessions[rec.ID].Intake) != 0 {
		t.Fatalf("autonomy left durable creative intake: %v", st.Sessions[rec.ID].Intake)
	}
}

func TestLegacyThinkingResponseStripsAutonomyOnly(t *testing.T) {
	raw := []byte(`{"sessionId":"th-1","messages":[{"id":"q1","autonomy":{"status":"completed"}},{"id":"a1"}],"run":{"runId":"r"}}`)
	legacy := httptest.NewRequest("GET", "/v1/studio/books/b/thinking/sessions/th-1", nil)
	var view struct {
		Messages []map[string]any `json:"messages"`
		Run      any              `json:"run"`
	}
	if err := json.Unmarshal(publicSessionView(legacy, raw), &view); err != nil {
		t.Fatal(err)
	}
	if view.Messages[0]["autonomy"] != nil || view.Run != nil {
		t.Fatalf("legacy view leaked additive fields: %+v", view)
	}

	negotiated := httptest.NewRequest("GET", "/v1/studio/books/b/thinking/sessions/th-1", nil)
	negotiated.Header.Set("X-Writer-Agent-Thinking", "reliability-v1")
	if string(publicSessionView(negotiated, raw)) != string(raw) {
		t.Fatal("negotiated client lost autonomy state")
	}
}

func TestAutonomyFailuresKeepTheirPublicRecoveryCategory(t *testing.T) {
	tests := []struct {
		code   string
		action string
	}{
		{code: "AUTONOMY_INCOMPLETE", action: "continue"},
		{code: "AUTONOMY_LIMIT_EXCEEDED", action: "new_session"},
		{code: "AUTONOMY_PLAN_REJECTED", action: "new_session"},
	}
	for _, test := range tests {
		t.Run(test.code, func(t *testing.T) {
			failure := recoveryFailure(test.code, "detail")
			if failure.Code != test.code || failure.UserAction != test.action {
				t.Fatalf("got %+v", failure)
			}
		})
	}
}

func ptr(value int) *int { return &value }
