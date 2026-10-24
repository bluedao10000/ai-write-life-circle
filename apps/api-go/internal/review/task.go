package review

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"time"
)

func (s *Service) Check(ctx context.Context, c *ClaimedRun) error {
	st, e := s.load()
	if e != nil {
		return e
	}
	r, ok := st.Runs[c.Run.RunID]
	deadline, e := time.Parse(time.RFC3339Nano, r.DeadlineAt)
	if !ok || r.Lease != c.Run.Lease || r.Status != "running" || e != nil || !time.Now().Before(deadline) {
		return executorpolicy.ErrFenced
	}
	_, e = s.Prepare(ctx, c)
	return e
}

func (s *Service) Outcome(c *ClaimedRun) (string, string) {
	st, e := s.load()
	if e != nil {
		return "", ""
	}
	r := st.Runs[c.Run.RunID]
	at := ""
	if r.CompletedAt != nil {
		at = *r.CompletedAt
	}
	return r.Status, at
}
