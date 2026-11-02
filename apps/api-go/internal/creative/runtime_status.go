package creative

import (
	"context"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func Counts(st State) agentruntime.Counts {
	var counts agentruntime.Counts
	for _, j := range st.Jobs {
		switch j.Status {
		case "queued", "pending", "retry":
			counts.Pending++
		case "running":
			counts.Running++
		case "completed":
			counts.Completed++
		case "failed":
			counts.Failed++
		case "cancelled":
			counts.Cancelled++
		}
		if j.Failure == "" && j.Status == "completed" && j.CompletedAt > counts.LastSuccess {
			counts.LastSuccess = j.CompletedAt
		}
		if j.Attempts > 1 {
			counts.Retried += j.Attempts - 1
		}
		if j.Failure == "CREATIVE_INTERRUPTED" {
			counts.Interrupted++
		}
	}
	return counts
}

func Inspect(ctx context.Context, app *application.Service, config llm.Config) (agentruntime.Counts, error) {
	st, err := New(app, config, nil).load()
	if err != nil {
		return agentruntime.Counts{}, err
	}
	return Counts(st), nil
}
