package knowledge

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"time"
)

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
		if current.ID == j.ID && current.Lease == j.Lease && current.Status == "running" {
			deadline, e := time.Parse(time.RFC3339Nano, current.Deadline)
			if e != nil || !time.Now().Before(deadline) {
				return executorpolicy.ErrFenced
			}
			c, e := s.App.Source(j.ChapterID)
			if e != nil {
				return e
			}
			r, e := s.App.ReviewRevision(ctx, c)
			if e != nil {
				return e
			}
			if r.ID != j.RevisionID || r.Hash != j.Hash {
				return application.Fail(409, "KNOWLEDGE_SUPERSEDED", "Source changed.")
			}
			return nil
		}
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
