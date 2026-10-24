package review

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
	"time"
)

func (x *Executor) Inspect(ctx context.Context, id string) (agentruntime.Counts, error) {
	app, err := x.Resolve(id)
	if err != nil {
		return agentruntime.Counts{}, err
	}
	st, err := New(app, x.Config, nil).load()
	if err != nil {
		return agentruntime.Counts{}, err
	}
	var counts agentruntime.Counts
	for _, j := range st.Runs {
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
		if j.Status == "completed" && j.CompletedAt != nil && *j.CompletedAt > counts.LastSuccess {
			counts.LastSuccess = *j.CompletedAt
		}
		if j.Attempts > 1 {
			counts.Retried += j.Attempts - 1
		}
		if j.FailureCode != nil && *j.FailureCode == "REVIEW_INTERRUPTED" {
			counts.Interrupted++
		}
	}
	return counts, nil
}

func (x *Executor) Ready(ctx context.Context, id string) (bool, error) {
	app, err := x.Resolve(id)
	if err != nil {
		return false, err
	}
	st, err := New(app, x.Config, nil).load()
	if err != nil {
		return false, err
	}
	for _, r := range st.Runs {
		if r.Status == "queued" {
			return true, nil
		}
		deadline, e := time.Parse(time.RFC3339Nano, r.DeadlineAt)
		if r.Status == "running" && (e != nil || time.Now().After(deadline)) {
			return true, nil
		}
	}
	return false, nil
}
