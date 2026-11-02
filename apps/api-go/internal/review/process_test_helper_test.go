package review

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

var testWG sync.WaitGroup

// Process preserves the pre-migration in-process executor for domain tests.
// Production review execution only happens through Prepare/Complete + Pi.
func (s *Service) Process(ctx context.Context, claimed *ClaimedRun) error {
	if claimed == nil || claimed.Run.Lease == "" {
		return llm.Fail("REVIEW_LEASE_INVALID")
	}
	run := claimed.Run
	callCtx, cancel := context.WithTimeout(ctx, s.Config.Timeout)
	defer cancel()
	request, prepErr := s.Prepare(callCtx, claimed)
	if prepErr != nil {
		if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
			prepErr = llm.Fail("LLM_TIMEOUT")
		} else if callCtx.Err() != nil {
			prepErr = llm.Fail("REVIEW_INTERRUPTED")
		}
		return s.Complete(claimed, llm.Response{}, prepErr)
	}
	st, err := s.load()
	if err != nil {
		return err
	}
	current := st.Runs[run.RunID]
	deadline, err := time.Parse(time.RFC3339Nano, current.DeadlineAt)
	if err != nil || current.Status != "running" || current.Lease != run.Lease || time.Now().After(deadline) {
		s.App.MeterSettle(context.Background(), meterOp(run.RunID, run.Attempts), -1)
		return nil
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-callCtx.Done():
				return
			case <-ticker.C:
				state, err := s.load()
				active := state.Runs[run.RunID]
				if err != nil || active.Status != "running" || active.Lease != claimed.Run.Lease || !(executorpolicy.Controller{State: s.App.State}).Valid("review", active.ExecutorOwner, active.ExecutorEpoch, active.Lease) {
					cancel()
					return
				}
			}
		}
	}()

	e := (executorpolicy.Controller{State: s.App.State}).Guard(callCtx, "review", run.ExecutorOwner, run.ExecutorEpoch, run.Lease, false, func() error { return nil })
	var response llm.Response
	if e == nil {
		e = s.App.MeterAuthorize(callCtx, meterOp(run.RunID, run.Attempts), "review")
	}
	if e == nil {
		response, e = s.Client.Generate(callCtx, request)
	}
	if callCtx.Err() != nil {
		if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
			e = llm.Fail("LLM_TIMEOUT")
		} else {
			e = llm.Fail("REVIEW_INTERRUPTED")
		}
	}
	return s.Complete(claimed, response, e)
}

func (s *Service) executeForTest(ctx context.Context, cancel context.CancelFunc, run Run) {
	defer testWG.Done()
	defer cancel()
	if ctx.Err() != nil {
		return
	}
	claim, e := s.claimRun(ctx, run.RunID)
	if e == nil && claim != nil {
		_ = s.Process(ctx, claim)
	}
}

// startForTest launches the same asynchronous behavior the old embedded
// executor had, without keeping that path in production code.
func startForTest(s *Service, r Run) {
	testWG.Add(1)
	go s.executeForTest(context.Background(), func() {}, r)
}
