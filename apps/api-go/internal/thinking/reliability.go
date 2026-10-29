package thinking

import (
	"encoding/json"
	"strings"
)

// Failure is the public recovery policy shared with thinkingFailureSchema.
// Legacy envelope codes remain stable; Code groups them for recovery UX.
type Failure struct {
	Code                string `json:"code"`
	Retryable           bool   `json:"retryable"`
	AutoRecoverable     bool   `json:"autoRecoverable"`
	UserAction          string `json:"userAction"`
	ContextRetained     bool   `json:"contextRetained"`
	MayHaveIncurredCost bool   `json:"mayHaveIncurredCost"`
	RetryMayIncurCost   bool   `json:"retryMayIncurCost"`
	Message             string `json:"message"`
}

func recoveryFailure(code, detail string) Failure {
	f := Failure{Code: "INTERNAL_ERROR", UserAction: "contact_support", ContextRetained: true, RetryMayIncurCost: true, Message: detail}
	switch {
	case strings.Contains(code, "TOOL_TIMEOUT"):
		f.Code = "TOOL_TIMEOUT"
		f.UserAction = "retry"
	case strings.Contains(code, "TIMEOUT") || code == "DURATION_EXCEEDED":
		f.Code = "PROVIDER_TIMEOUT"
		f.UserAction = "retry"
	case code == "RATE_LIMITED" || code == "AGENT_BUSY":
		f.Code = "RATE_LIMITED"
		f.UserAction = "retry"
	case code == "CONTEXT_OVERFLOW" || code == "INPUT_BUDGET_EXCEEDED" || code == "CONTINUATION_CONTEXT_REQUIRED":
		f.Code = "CONTEXT_OVERFLOW"
		f.UserAction = "provide_context"
	case strings.Contains(code, "BUDGET_EXCEEDED"):
		f.Code = "BUDGET_EXCEEDED"
		f.UserAction = "new_session"
	case code == "TOOL_EXECUTION_FAILED":
		f.Code = "TOOL_EXECUTION_FAILED"
		f.UserAction = "retry"
	case code == "NOT_FOUND" || code == "SESSION_HISTORY_LIMIT" || code == "SESSION_EXPIRED":
		f.Code = "SESSION_EXPIRED"
		f.UserAction = "new_session"
	case strings.Contains(code, "AUTHORIZATION") || code == "SCOPE_FORBIDDEN":
		f.Code = "AUTHORIZATION_REQUIRED"
		f.UserAction = "reauthorize"
	case strings.Contains(code, "MODEL_"):
		f.Code = "MODEL_CONFIGURATION_ERROR"
		f.UserAction = "reauthorize"
	case code == "SESSION_INTERRUPTED" || code == "AGENT_RESTARTED":
		f.Code = "SESSION_INTERRUPTED"
		f.UserAction = "continue"
	case code == "THINKING_UNAVAILABLE" || code == "PROVIDER_UNAVAILABLE":
		f.Code = "PROVIDER_UNAVAILABLE"
		f.UserAction = "retry"
	}
	f.Retryable = f.UserAction == "retry" || f.UserAction == "continue" || f.UserAction == "provide_context"
	// A failed RPC can have been accepted remotely. Never describe it as free.
	f.MayHaveIncurredCost = code == "THINKING_UNAVAILABLE" || code == "SESSION_INTERRUPTED" || code == "PROVIDER_TIMEOUT"
	return f
}

// A cancel recorded while Pi was offline must still be visible after Pi restart.
func cancelledSessionView(raw json.RawMessage) json.RawMessage {
	var view map[string]json.RawMessage
	if json.Unmarshal(raw, &view) != nil {
		return raw
	}
	var run map[string]any
	if json.Unmarshal(view["run"], &run) != nil || run["status"] == "completed" {
		return raw
	}
	run["status"] = "cancelled"
	run["resumable"] = false
	view["run"], _ = json.Marshal(run)
	var messages []map[string]any
	if json.Unmarshal(view["messages"], &messages) == nil && len(messages) > 0 {
		last := messages[len(messages)-1]
		if last["role"] == "assistant" && last["status"] != "completed" {
			last["status"] = "cancelled"
			last["errorCode"] = "CANCELLED"
		}
		view["messages"], _ = json.Marshal(messages)
	}
	view["status"] = json.RawMessage(`"idle"`)
	result, e := json.Marshal(view)
	if e != nil {
		return raw
	}
	return result
}
