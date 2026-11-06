package agenttasks

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

// TaskDiagnostics projects persisted execution receipts without source text,
// request payloads, credentials or another authoritative lifecycle.
type TaskDiagnostics struct {
	StepResults   []llm.StepResult   `json:"stepResults,omitempty"`
	ModelSteps    []ModelStepReceipt `json:"modelSteps,omitempty"`
	Audit         []ExecutionAudit   `json:"audit,omitempty"`
	Schema        int                `json:"schemaVersion"`
	TaskID        string             `json:"taskId"`
	BookID        string             `json:"bookId"`
	Kind          string             `json:"kind"`
	Strategy      string             `json:"strategyVersion"`
	OutputSchema  string             `json:"outputSchemaVersion"`
	Epoch         uint64             `json:"executorEpoch"`
	Attempt       int                `json:"attempt"`
	Deadline      string             `json:"deadline"`
	Started       bool               `json:"started"`
	Finished      bool               `json:"finished"`
	Outcome       string             `json:"outcome"`
	CompletedAt   string             `json:"completedAt,omitempty"`
	SourceTaskIDs []string           `json:"sourceTaskIds"`
}

func (s *Service) Diagnostics(ctx context.Context, id string) (TaskDiagnostics, error) {
	if err := ctx.Err(); err != nil {
		return TaskDiagnostics{}, err
	}
	st, err := s.load()
	if err != nil {
		return TaskDiagnostics{}, err
	}
	rec, ok := st.Tasks[id]
	if !ok {
		return TaskDiagnostics{}, application.Fail(404, "NOT_FOUND", "Task receipt not found.")
	}
	t := rec.Task
	outcome := rec.Outcome
	if outcome == "" {
		switch {
		case rec.ResultHash == "expired":
			outcome = "interrupted"
		case rec.Finished:
			outcome = "unknown"
		case rec.Started:
			outcome = "running"
		default:
			outcome = "accepted"
		}
	}
	sources := []string{}
	if rec.Memory != nil {
		sources = append(sources, memoryTaskIDs(*rec.Memory)...)
	}
	return TaskDiagnostics{StepResults: rec.StepResults, ModelSteps: rec.ModelSteps, Audit: rec.Audit, Schema: 1, TaskID: t.ID, BookID: t.Book, Kind: t.Kind, Strategy: t.Strategy, OutputSchema: t.OutputSchema, Epoch: t.Epoch, Attempt: t.Attempt, Deadline: t.Deadline, Started: rec.Started, Finished: rec.Finished, Outcome: outcome, CompletedAt: rec.CompletedAt, SourceTaskIDs: sources}, nil
}
