package review

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"sort"
	"strconv"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type ClaimedRun struct {
	Run Run
}

// Claim atomically leases one queued review. The caller must call Commit with
// the same lease; a lost lease can never mutate another worker's result.
func (s *Service) claim(ctx context.Context) (*ClaimedRun, error) {
	var run *Run
	reserved := ""
	e := s.transaction(ctx, func(st *state) (bool, error) {
		now := time.Now().UTC()
		deadline := now.Add(s.Config.Timeout + 15*time.Second).Format(time.RFC3339Nano)
		ids := make([]string, 0, len(st.Runs))
		for id := range st.Runs {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool {
			a, b := st.Runs[ids[i]], st.Runs[ids[j]]
			if a.StartedAt == b.StartedAt {
				return ids[i] < ids[j]
			}
			return a.StartedAt < b.StartedAt
		})
		for _, i := range ids {
			r := st.Runs[i]
			if s.claimID != "" && r.RunID != s.claimID {
				continue
			}
			if r.Status != "queued" && !(s.claimID != "" && r.Status == "running" && r.Lease == "") {
				continue
			}
			free, e := s.freeAuthor(ctx)
			if e != nil {
				return false, e
			}
			if free && r.Cost == nil {
				// A formerly paid scope requires renewed consent, not an endless queue.
				at := compat.Now()
				code := "REVIEW_CONFIG_CHANGED"
				r.Status = "failed"
				r.CompletedAt = &at
				r.FailureCode = &code
				r.Version++
				st.Runs[i] = r
				return true, nil
			}
			// AI points: a run whose owner has no allowance waits in the queue.
			op := meterOp(r.RunID, r.Attempts+1)
			if s.App.MeterReserve(ctx, op, "review", s.planReserve(r.Plan)) != nil {
				continue
			}
			reserved = op
			r.Status = "running"
			r.CompletedAt = nil
			r.ExecutorOwner = executorpolicy.Owner(s.ExecutorOwner)
			r.ExecutorEpoch = s.claimEpoch
			r.Lease = compat.UUID()
			r.Attempts++
			r.DeadlineAt = deadline
			r.Version++
			st.Runs[i] = r
			run = &r
			return true, nil
		}
		return false, nil
	})
	if e != nil && reserved != "" {
		s.App.MeterSettle(context.Background(), reserved, 0)
	}
	if e != nil || run == nil {
		return nil, e
	}
	return &ClaimedRun{*run}, nil
}

// Prepare returns exactly the author-confirmed source snapshot; no model call occurs here.
func (s *Service) Prepare(ctx context.Context, claimed *ClaimedRun) (llm.Request, error) {
	run := claimed.Run
	if !s.validateCost(run.Plan) || (run.ConfigFingerprint != "" && run.ConfigFingerprint != s.Config.Fingerprint()) || (s.ExecutorOwner == "pi" && run.ConfigFingerprint == "") || run.Model != s.Config.Info() || run.StrategyVersion != StrategyVersion || run.ContextBytes > s.Config.MaxContextBytes {
		return llm.Request{}, failure(409, "REVIEW_CONFIG_CHANGED", "Preview and confirm the current model again.")
	}
	if s.freshen(ctx, run).Stale {
		return llm.Request{}, failure(409, "REVIEW_CONTEXT_CHANGED", "The approved source snapshot changed.")
	}
	request := llm.Request{System: prompt(), Input: promptInput(run.Plan), Schema: CandidateSchema()}
	if run.Cost != nil {
		request.OutputLimit = run.Cost.MaxOutputTokens
	}
	return request, nil
}

// Complete independently validates model candidates and source freshness before the fenced commit.
func (s *Service) complete(claimed *ClaimedRun, response llm.Response, modelErr error) error {
	receipt := completionHash(response, modelErr)
	run := claimed.Run
	var findings []Finding
	var reasons []string
	if modelErr == nil {
		_, modelErr = s.Prepare(context.Background(), claimed)
	}
	if modelErr == nil {
		findings, reasons, modelErr = Validate(run.Plan, response.Text)
	}
	return s.commit(run.Lease, response, findings, reasons, modelErr, receipt)
}

func (s *Service) commit(lease string, response llm.Response, findings []Finding, reasons []string, modelErr error, receipt string) error {
	finish, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	err := s.transaction(finish, func(st *state) (bool, error) {
		for _, current := range st.Runs {
			if current.Lease != lease {
				continue
			}
			if current.Status != "running" {
				return false, nil
			}
			deadline, err := time.Parse(time.RFC3339Nano, current.DeadlineAt)
			if err != nil || time.Now().After(deadline) {
				return false, nil
			}
			at := compat.Now()
			current.CompletedAt = &at
			current.Version++
			current.Usage = response.Usage
			if modelErr != nil {
				code := "LLM_FAILED"
				var modelError *llm.Error
				var appError *application.Error
				if errors.As(modelErr, &modelError) {
					code = modelError.Code
				} else if errors.As(modelErr, &appError) {
					code = appError.Code
				}
				current.Status = "failed"
				if code == "REVIEW_INTERRUPTED" && current.Attempts < 3 {
					current.Status = "queued"
					current.CompletedAt = nil
				}
				current.FailureCode = &code
			} else {
				current.Status = "completed"
				current.FailureCode = nil
				current.Findings = findings
				current.RejectedCount = len(reasons)
				current.RejectionReasons = reasons
			}
			if current.CompletionReceipts == nil {
				current.CompletionReceipts = map[string]string{}
			}
			current.CompletionReceipts[lease] = receipt
			current.Lease = ""
			st.Runs[current.RunID] = current
			return true, nil
		}
		return false, nil // cancelled, reclaimed, or already committed; stale results are inert
	})
	return err
}

func (s *Service) Claim(ctx context.Context) (*ClaimedRun, error) { return s.claimRun(ctx, "") }
func (s *Service) claimRun(ctx context.Context, target string) (out *ClaimedRun, err error) {
	err = (executorpolicy.Controller{State: s.App.State}).Claim(ctx, "review", s.ExecutorOwner, func(epoch uint64) (string, string, error) {
		copy := New(s.App, s.Config, s.Client)
		defer copy.Close()
		copy.ExecutorOwner = s.ExecutorOwner
		copy.MemoryChapters = s.MemoryChapters
		copy.write = s.write
		copy.claimEpoch = epoch
		copy.claimID = target
		var e error
		out, e = copy.claim(ctx)
		if e != nil || out == nil {
			return "", "", e
		}
		return out.Run.Lease, out.Run.DeadlineAt, nil
	})
	if errors.Is(err, executorpolicy.ErrFenced) {
		err = nil
	}
	return
}
func (s *Service) Complete(claimed *ClaimedRun, response llm.Response, modelErr error) error {
	r := claimed.Run
	// The model cost is incurred whether or not the fenced commit wins.
	defer s.App.MeterSettle(context.Background(), meterOp(r.RunID, r.Attempts), settlePoints(response, modelErr))
	if s.Completed(claimed, response, modelErr) {
		return nil
	}
	return (executorpolicy.Controller{State: s.App.State}).Guard(context.Background(), "review", r.ExecutorOwner, r.ExecutorEpoch, r.Lease, true, func() error { return s.complete(claimed, response, modelErr) })
}

func completionHash(response llm.Response, e error) string {
	code := ""
	if e != nil {
		code = e.Error()
	}
	b, _ := json.Marshal([]any{response, code})
	return compat.Hash(string(b))
}
func (s *Service) Completed(c *ClaimedRun, response llm.Response, e error) bool {
	st, err := s.load()
	if err != nil {
		return false
	}
	return st.Runs[c.Run.RunID].CompletionReceipts[c.Run.Lease] == completionHash(response, e)
}

func meterOp(run string, attempt int) string { return "review:" + run + ":" + strconv.Itoa(attempt) }

// reservePoints bounds one review attempt for admission; settlement uses the
// reported usage.
func (s *Service) reservePoints() int {
	return billing.PointsFor(s.Config.MaxContextBytes+20000, min(s.Config.MaxOutputTokens, 16384))
}

// settlePoints charges reported usage; without usage it releases attempts
// that failed before any model call (application errors from Prepare) and
// otherwise charges the reservation.
func settlePoints(response llm.Response, e error) int {
	if response.Usage != nil {
		return billing.PointsFor(response.Usage.InputTokens, response.Usage.OutputTokens, response.Usage.CachedInputTokens)
	}
	var appError *application.Error
	if e != nil && errors.As(e, &appError) {
		return 0
	}
	return -1
}
