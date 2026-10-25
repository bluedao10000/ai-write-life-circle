package creative

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
	"strconv"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func (s *Service) timeout() time.Duration {
	if s.Config.Timeout > 0 {
		return s.Config.Timeout
	}
	return 60 * time.Second
}

func terminal(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

func due(j Job, now time.Time) bool {
	t, _ := time.Parse(time.RFC3339Nano, j.Due)
	return (j.Status == "pending" || j.Status == "retry") && !now.Before(t)
}

// eligible serialises work per conversation: a later turn waits for earlier ones
// so revisions of the same idea are proposed in order.
func eligible(st *State, index int) bool {
	j := st.Jobs[index]
	if j.SessionID == "" {
		return true
	}
	for i := 0; i < index; i++ {
		if st.Jobs[i].SessionID == j.SessionID && !terminal(st.Jobs[i].Status) {
			return false
		}
	}
	return true
}

type claimed struct {
	Job      Job
	Snapshot State
	Reserved int
	Day      string
	Started  time.Time
}

// recover returns expired running leases to the retry queue.
func recoverLeases(st *State, now time.Time) bool {
	changed := false
	for i, j := range st.Jobs {
		if j.Status != "running" {
			continue
		}
		deadline, e := time.Parse(time.RFC3339Nano, j.Deadline)
		if e == nil && now.Before(deadline) {
			continue
		}
		st.Jobs[i].Lease = ""
		st.Jobs[i].Failure = "CREATIVE_INTERRUPTED"
		st.Jobs[i].Status = "retry"
		if j.Attempts >= 3 {
			st.Jobs[i].Status = "failed"
			failTurn(st, st.Jobs[i])
		}
		changed = true
	}
	return changed
}

func failTurn(st *State, j Job) {
	if t, ok := st.Turns[j.TurnKey]; ok && t.Status == "queued" && t.JobID == j.ID {
		t.Status, t.Reason, t.UpdatedAt = "failed", j.Failure, compat.Now()
		st.Turns[t.Key] = t
	}
}

func (s *Service) claim(ctx context.Context) (*claimed, error) {
	var out *claimed
	metered := ""
	e := s.transaction(ctx, func(st *State) (bool, error) {
		now := s.now()
		changed := recoverLeases(st, now)
		if !s.runnable(*st) || s.Client == nil {
			return changed, nil
		}
		day := now.Format("2006-01-02")
		if st.BudgetDay != day {
			st.BudgetDay, st.BudgetTokens, st.BudgetAttempts = day, 0, 0
			changed = true
		}
		for i, j := range st.Jobs {
			if !due(j, now) || !eligible(st, i) {
				continue
			}
			if j.Model != st.Settings.Model {
				st.Jobs[i].Status, st.Jobs[i].Failure = "cancelled", "MODEL_REAUTHORIZATION_REQUIRED"
				failTurn(st, st.Jobs[i])
				changed = true
				continue
			}
			reserve := s.reserve()
			if st.BudgetTokens+reserve > st.Settings.DailyTokenBudget || st.BudgetAttempts >= st.Settings.DailyJobBudget {
				return changed, nil
			}
			// AI points: the owner's allowance gates the book's queue as a whole.
			op := meterOp(j.ID, j.Attempts+1)
			if s.App.MeterReserve(ctx, op, "creative", s.reservePoints()) != nil {
				return changed, nil
			}
			metered = op
			st.BudgetTokens += reserve
			st.BudgetAttempts++
			j.AttemptReserve, j.DebitedDay = reserve, day
			j.ReservedTokens += reserve
			j.Attempts++
			j.Status = "running"
			j.Lease = newID()
			j.Deadline = now.Add(s.timeout() + 15*time.Second).Format(time.RFC3339Nano)
			st.Jobs[i] = j
			out = &claimed{Job: j, Reserved: reserve, Day: day, Started: now}
			out.Snapshot = clone(*st)
			return true, nil
		}
		return changed, nil
	})
	if metered != "" && (e != nil || out == nil) {
		s.App.MeterSettle(context.Background(), metered, 0)
	}
	return out, e
}

// Ready reports whether a model call could start now, without claiming.
func (s *Service) Ready(ctx context.Context) (bool, error) {
	st, e := s.load()
	if e != nil || !s.runnable(st) || s.Client == nil {
		return false, e
	}
	now := s.now()
	for i, j := range st.Jobs {
		deadline, _ := time.Parse(time.RFC3339Nano, j.Deadline)
		if (due(j, now) && eligible(&st, i)) || (j.Status == "running" && !now.Before(deadline)) {
			return true, nil
		}
	}
	return false, nil
}

// ProcessOne claims, executes and commits at most one job. Network calls hold no locks.
func (s *Service) ProcessOne(ctx context.Context) (bool, error) {
	c, e := s.claim(ctx)
	if e != nil || c == nil {
		return false, e
	}
	run, cancel := context.WithTimeout(ctx, s.timeout())
	defer cancel()
	var org *organizeContext
	var plan *planContext
	var req llm.Request
	switch c.Job.Kind {
	case "organize":
		org, e = s.prepareOrganize(c.Snapshot, c.Job)
		if org != nil {
			req = org.Request
		}
	case "plan_check":
		plan, e = s.preparePlan(run, c.Snapshot, c.Job)
		if plan != nil {
			req = plan.Request
		}
	default:
		e = errors.New("CREATIVE_UNKNOWN_JOB")
	}
	var resp llm.Response
	sent := false
	if e == nil {
		// Fence again immediately before the paid call: pause, deletion and
		// session cancellation all clear the lease.
		if s.leaseValid(c.Job) {
			sent = true
			resp, e = s.Client.Generate(run, req)
		} else {
			e = errors.New("CREATIVE_LEASE_LOST")
		}
	}
	points := 0
	if sent {
		points = -1
		if resp.Usage != nil {
			points = billing.PointsFor(resp.Usage.InputTokens, resp.Usage.OutputTokens)
		}
	}
	s.App.MeterSettle(context.Background(), meterOp(c.Job.ID, c.Job.Attempts), points)
	return true, s.complete(ctx, c, org, plan, resp, sent, e)
}

func meterOp(job string, attempt int) string { return "creative:" + job + ":" + strconv.Itoa(attempt) }

// reservePoints bounds one organize or plan-check attempt for admission.
func (s *Service) reservePoints() int {
	return billing.PointsFor(s.reserve(), min(max(s.Config.MaxOutputTokens, 1024), 16384))
}

func (s *Service) leaseValid(j Job) bool {
	st, e := s.load()
	if e != nil || !s.runnable(st) {
		return false
	}
	for _, v := range st.Jobs {
		if v.ID == j.ID {
			return v.Lease == j.Lease && v.Status == "running"
		}
	}
	return false
}

func failureCode(e error) string {
	var m *llm.Error
	if errors.As(e, &m) {
		return m.Code
	}
	var d *application.Error
	if errors.As(e, &d) {
		return d.Code
	}
	if e != nil && len(e.Error()) <= 64 {
		return e.Error()
	}
	return "CREATIVE_JOB_FAILED"
}

// retryable distinguishes model/transport failures from permanent input problems.
func retryable(code string) bool {
	switch code {
	case "CREATIVE_TURN_UNAVAILABLE", "CREATIVE_CONTEXT_TOO_LARGE", "CREATIVE_SUPERSEDED", "CREATIVE_NO_PLANS", "CREATIVE_UNKNOWN_JOB", "CREATIVE_LEASE_LOST":
		return false
	}
	return true
}

func (s *Service) complete(ctx context.Context, c *claimed, org *organizeContext, plan *planContext, resp llm.Response, sent bool, runErr error) error {
	j := c.Job
	now := s.stamp()
	receiptRaw, _ := json.Marshal([]any{resp, sent, failureCode(runErr)})
	rec := compat.Hash(string(receiptRaw))
	var result organizeResult
	var divergences []Divergence
	err := runErr
	if err == nil && org != nil {
		var out organizeOutput
		out, err = decodeOrganize(resp.Text)
		if err == nil {
			result = s.buildOrganize(org, j, out, now)
			if len(out.Changes) > 0 && len(result.Proposals) == 0 {
				err = errors.New("LLM_INVALID_EVIDENCE")
			}
		}
	}
	if err == nil && plan != nil {
		divergences, _, err = s.buildPlan(plan, j, resp.Text, now)
	}
	finish := func(st *State) (bool, error) {
		index := -1
		for i, v := range st.Jobs {
			if v.ID == j.ID {
				index = i
			}
		}
		if index < 0 {
			return false, nil
		}
		current := st.Jobs[index]
		if current.CompletionReceipts[j.Lease] == rec {
			return false, nil
		}
		// Settle budget and usage even when the result can no longer be committed.
		if current.DebitedDay == st.BudgetDay {
			if !sent {
				st.BudgetTokens = max(0, st.BudgetTokens-c.Reserved)
				st.BudgetAttempts = max(0, st.BudgetAttempts-1)
			} else if resp.Usage != nil {
				st.BudgetTokens = max(0, st.BudgetTokens+resp.Usage.InputTokens+resp.Usage.OutputTokens-c.Reserved)
			}
		}
		if sent {
			current.ModelCalls++
			if resp.Usage == nil {
				current.UsageIncomplete = true
			} else {
				if current.Usage == nil {
					current.Usage = &llm.Usage{}
				}
				current.Usage.InputTokens += resp.Usage.InputTokens
				current.Usage.OutputTokens += resp.Usage.OutputTokens
			}
		}
		if current.CompletionReceipts == nil {
			current.CompletionReceipts = map[string]string{}
		}
		current.CompletionReceipts[j.Lease] = rec
		deadline, _ := time.Parse(time.RFC3339Nano, current.Deadline)
		live := current.Lease == j.Lease && current.Status == "running" && s.now().Before(deadline) && s.runnable(*st) && st.Settings.Model == j.Model
		if !live {
			// Late, cancelled, paused or superseded attempt: never commit a result.
			if current.Lease == j.Lease {
				current.Lease = ""
			}
			st.Jobs[index] = current
			return true, nil
		}
		current.Lease = ""
		current.CompletedAt = now
		if err == nil && org != nil {
			t, ok := st.Turns[j.TurnKey]
			if !ok || t.Status != "queued" || t.JobID != j.ID {
				err = errors.New("CREATIVE_TURN_UNAVAILABLE")
			} else if len(st.Proposals)+len(result.Proposals) > MaxProposals {
				err = application.Fail(429, "CREATIVE_PROPOSAL_LIMIT", "Proposal history is full.")
			} else {
				commitOrganize(st, &result, now)
				t.ChangeSetID = result.ChangeSet.ID
				t.Status, t.UpdatedAt = "organized", now
				if result.ChangeSet.NoChange {
					t.Status = "no_change"
				}
				st.Turns[t.Key] = t
				pruneExcerpts(st)
			}
		}
		if err == nil && plan != nil {
			for id, d := range st.Divergences {
				if d.ChapterID == j.ChapterID && d.Status != "decided" {
					d.Status = "superseded"
					st.Divergences[id] = d
				}
			}
			for _, d := range divergences {
				if len(st.Divergences) < MaxDivergences {
					st.Divergences[d.ID] = d
				}
			}
		}
		if err == nil {
			current.Status, current.Failure = "completed", ""
		} else {
			current.Failure = failureCode(err)
			current.Status = "retry"
			current.Due = s.now().Add(time.Duration(1<<current.Attempts) * time.Second).Format(time.RFC3339Nano)
			if current.Attempts >= 3 || !retryable(current.Failure) {
				current.Status = "failed"
			}
			if current.Failure == "CREATIVE_SUPERSEDED" || current.Failure == "CREATIVE_TURN_UNAVAILABLE" || current.Failure == "CREATIVE_LEASE_LOST" {
				current.Status = "cancelled"
			}
			if current.Status != "retry" {
				failTurn(st, current)
			}
		}
		st.Jobs[index] = current
		return true, nil
	}
	if plan != nil && err == nil {
		// Commit inside the chapter revision lock so a concurrent save supersedes the result.
		e := s.App.WithReviewRevision(ctx, j.ChapterID, func(head application.StoredRevision) error {
			if head.ID != j.RevisionID || head.Hash != j.ContentHash {
				err = errors.New("CREATIVE_SUPERSEDED")
			}
			return s.transaction(ctx, finish)
		})
		if e == nil {
			return nil
		}
		err = e
	}
	return s.transaction(ctx, finish)
}

// commitOrganize stores the change set and supersedes revised pending proposals.
// A replaced proposal that is no longer pending is not overwritten: the new
// proposal stays independent so the author sees both.
func commitOrganize(st *State, r *organizeResult, now string) {
	for i, p := range r.Proposals {
		if p.Replaces != "" {
			old, ok := st.Proposals[p.Replaces]
			if ok && old.Status == "proposed" {
				old.Status, old.ReplacedBy, old.StatusReason = "superseded", p.ID, "REVISED_IN_LATER_TURN"
				st.Proposals[old.ID] = old
			} else {
				r.Proposals[i].Replaces = ""
			}
		}
		if p.TargetAssetID != "" {
			if a, ok := st.Assets[p.TargetAssetID]; !ok || a.Status == "archived" {
				r.Proposals[i].Status, r.Proposals[i].StatusReason = "expired", "TARGET_UNAVAILABLE"
			}
		}
		st.Proposals[p.ID] = r.Proposals[i]
	}
	st.ChangeSets[r.ChangeSet.ID] = r.ChangeSet
}

// Executor adapts the creative scheduler to the shared Agent Runtime in the
// worker process, which is the only process holding a model credential.
type Executor struct {
	Config  llm.Config
	Client  llm.Client
	Resolve func(bookID string) (*application.Service, error)
}

func (x *Executor) Kind() string { return "creative" }

func (x *Executor) Process(ctx context.Context, book string) (bool, error) {
	app, e := x.Resolve(book)
	if e != nil {
		return false, e
	}
	return New(app, x.Config, x.Client).ProcessOne(ctx)
}

func (x *Executor) Ready(ctx context.Context, book string) (bool, error) {
	app, e := x.Resolve(book)
	if e != nil {
		return false, e
	}
	return New(app, x.Config, x.Client).Ready(ctx)
}
