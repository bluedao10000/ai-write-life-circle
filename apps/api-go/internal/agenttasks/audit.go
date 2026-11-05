package agenttasks

import "time"

// ExecutionAudit contains only fixed lifecycle metadata. It shares the task
// receipt transaction and never retains provider output or request arguments.
type ExecutionAudit struct {
	Action string `json:"action"`
	At     string `json:"at"`
	Reason string `json:"reason,omitempty"`
}

func (r *Record) audit(action, reason string) {
	for _, event := range r.Audit {
		if event.Action == action {
			return
		}
	}
	if reason != "" && !failureAllowed(reason) && reason != "TASK_DEADLINE_EXPIRED" {
		reason = "TASK_REJECTED"
	}
	r.Audit = append(r.Audit, ExecutionAudit{Action: action, At: time.Now().UTC().Format(time.RFC3339Nano), Reason: reason})
}
