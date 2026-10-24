package knowledge

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
	"os"
	"time"
)

func knowledgeCounts(st State) agentruntime.Counts {
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
		if j.Failure == "" && (j.Status == "completed" || j.Status == "superseded") && j.CompletedAt > counts.LastSuccess {
			counts.LastSuccess = j.CompletedAt
		}
		if j.Attempts > 1 {
			counts.Retried += j.Attempts - 1
		}
		if j.Failure == "KNOWLEDGE_INTERRUPTED" {
			counts.Interrupted++
		}
	}
	return counts
}

func (x *Executor) Inspect(ctx context.Context, id string) (agentruntime.Counts, error) {
	app, err := x.Resolve(id)
	if err != nil {
		return agentruntime.Counts{}, err
	}
	st, err := x.readControl(New(app, x.Config, nil))
	if err != nil {
		return agentruntime.Counts{}, err
	}
	return knowledgeCounts(st), nil
}

func (x *Executor) Ready(ctx context.Context, id string) (bool, error) {
	app, err := x.Resolve(id)
	if err != nil {
		return false, err
	}
	s := New(app, x.Config, x.Client)
	s.QuietPeriod = 2 * time.Second
	st, err := x.readControl(s)
	if err != nil {
		return false, err
	}
	changed, err := s.syncWithState(ctx, st)
	if err != nil {
		return false, err
	}
	if changed {
		st, err = x.readControl(s)
		if err != nil {
			return false, err
		}
	}
	if !st.Settings.Enabled || st.Settings.Paused || st.Settings.Model != x.Config.Info() {
		return false, nil
	}
	now := time.Now().UTC()
	if st.BudgetDay == now.Format("2006-01-02") && (st.BudgetTokens+s.reserve() > st.Settings.DailyTokenBudget || st.BudgetAttempts >= st.Settings.DailyJobBudget) {
		return false, nil
	}
	for _, j := range st.Jobs {
		due, _ := time.Parse(time.RFC3339Nano, j.Due)
		deadline, _ := time.Parse(time.RFC3339Nano, j.Deadline)
		if (j.Status == "pending" || j.Status == "retry") && !now.Before(due) || j.Status == "running" && now.After(deadline) {
			return true, nil
		}
	}
	return false, nil
}

// controlSnapshot holds only scheduling metadata, never entities, assertions or
// quoted prose. All writers replace index-v1.json atomically. Retaining one
// file identity avoids decoding the unchanged full index on every idle tick.
type controlSnapshot struct {
	path  string
	info  os.FileInfo
	state State
}

func (x *Executor) readControl(s *Service) (State, error) {
	x.controlMu.Lock()
	defer x.controlMu.Unlock()
	path := s.path()
	before, err := os.Stat(path)
	if err != nil && !os.IsNotExist(err) {
		return State{}, err
	}
	if err == nil && x.control != nil && x.control.path == path &&
		os.SameFile(before, x.control.info) && before.Size() == x.control.info.Size() &&
		before.ModTime().Equal(x.control.info.ModTime()) {
		return x.control.state, nil
	}
	x.control = nil
	st, err := s.load()
	if err != nil {
		return State{}, err
	}
	control := State{
		Settings: st.Settings, Jobs: st.Jobs,
		ScanStamp: st.ScanStamp, ScanComplete: st.ScanComplete, ScanRetryAt: st.ScanRetryAt,
		BudgetDay: st.BudgetDay, BudgetTokens: st.BudgetTokens, BudgetAttempts: st.BudgetAttempts,
	}
	after, statErr := os.Stat(path)
	if statErr == nil && before != nil && os.SameFile(before, after) &&
		before.Size() == after.Size() && before.ModTime().Equal(after.ModTime()) {
		x.control = &controlSnapshot{path: path, info: after, state: control}
	}
	return control, nil
}
