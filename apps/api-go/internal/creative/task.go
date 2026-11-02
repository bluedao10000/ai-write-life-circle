package creative

import (
	"context"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
)

// Check validates that the claimed job is still current before a Pi executor
// may start, heartbeat or finish it.
func (s *Service) Check(ctx context.Context, p *PreparedJob) error {
	st, e := s.load()
	if e != nil {
		return e
	}
	j := p.Claim.Job
	if st.Settings.ConfigFingerprint != s.Config.Fingerprint() || !st.Settings.Enabled || st.Settings.Paused || st.Settings.Model != j.Model || j.Model != s.Config.Info() {
		return executorpolicy.ErrFenced
	}
	for _, current := range st.Jobs {
		if current.ID != j.ID {
			continue
		}
		deadline, e := time.Parse(time.RFC3339Nano, current.Deadline)
		if e != nil || !s.now().Before(deadline) || current.Lease != j.Lease || current.Status != "running" {
			return executorpolicy.ErrFenced
		}
		if current.Kind != "plan_check" {
			return nil
		}
		source, e := s.App.Source(current.ChapterID)
		if e != nil {
			return e
		}
		head, e := s.App.ReviewRevision(ctx, source)
		if e != nil {
			return e
		}
		if head.ID != current.RevisionID || head.Hash != current.ContentHash {
			return application.Fail(409, "CREATIVE_SUPERSEDED", "Source changed.")
		}
		return nil
	}
	return executorpolicy.ErrFenced
}

func (s *Service) Outcome(p *PreparedJob) (string, string) {
	st, e := s.load()
	if e != nil {
		return "", ""
	}
	for _, j := range st.Jobs {
		if j.ID == p.Claim.Job.ID {
			return j.Status, j.CompletedAt
		}
	}
	return "", ""
}
