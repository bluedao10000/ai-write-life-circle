package knowledge

import (
	"context"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

// processOneForTest preserves the pre-migration in-process executor for domain
// tests. Production code only exposes Claim/Prepare/Complete to the Pi worker.
func processOneForTest(ctx context.Context, s *Service) error {
	if s.Client == nil {
		return s.sync(ctx)
	}
	claim, e := s.Claim(ctx)
	if e != nil || claim == nil {
		return e
	}
	j := claim.Job
	timeout, cancel := context.WithTimeout(ctx, s.timeout())
	defer cancel()
	watchDone := make(chan struct{})
	defer close(watchDone)
	go func() {
		tick := time.NewTicker(200 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-watchDone:
				return
			case <-timeout.Done():
				return
			case <-tick.C:
				current, e := s.load()
				if e != nil {
					cancel()
					return
				}
				active := false
				for _, v := range current.Jobs {
					if v.ID == j.ID && v.Lease == j.Lease && v.Status == "running" {
						active = true
					}
				}
				if !(executorpolicy.Controller{State: s.App.State}).Valid("knowledge", j.ExecutorOwner, j.ExecutorEpoch, j.Lease) || current.Settings.Paused || current.Settings.Model != j.Model || !active {
					cancel()
					return
				}
			}
		}
	}()
	p, err := s.Prepare(timeout, claim)
	var response llm.Response
	sent := false
	if err == nil {
		err = (executorpolicy.Controller{State: s.App.State}).Guard(timeout, "knowledge", j.ExecutorOwner, j.ExecutorEpoch, j.Lease, false, func() error { return nil })
		if err == nil {
			sent = true
			response, err = s.Client.Generate(timeout, p.Request)
		}
	}
	return s.Complete(ctx, p, response, sent, err)
}
