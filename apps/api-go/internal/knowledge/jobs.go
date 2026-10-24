package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Service) sync(ctx context.Context) error {
	st, e := s.load()
	if e != nil {
		return e
	}
	_, e = s.syncWithState(ctx, st)
	return e
}

func (s *Service) maintenanceEligible(st State) bool {
	return st.Settings.Enabled && !st.Settings.Paused && (s.Client != nil || s.QueueOnly) &&
		st.Settings.Model == s.Config.Info() &&
		(st.Settings.ConfigFingerprint == "" || st.Settings.ConfigFingerprint == s.Config.Fingerprint()) &&
		!(s.ExecutorOwner == "pi" && st.Settings.ConfigFingerprint == "")
}

// revisionStamp is a cheap change detector for managed works. Draft writes use
// fsync plus atomic rename, so either the draft directory or the managed
// catalog metadata changes whenever an author can alter the saved heads.
func (s *Service) revisionStamp() (string, error) {
	stamp := func(path string) string {
		info, e := os.Stat(path)
		if os.IsNotExist(e) {
			return "missing"
		}
		if e != nil {
			return "error:" + e.Error()
		}
		return fmt.Sprintf("%t:%d:%d:%d", info.IsDir(), info.Size(), info.ModTime().UnixNano(), info.Mode().Perm())
	}
	catalog := filepath.Join(s.App.State, "works", "catalog-v1.json")
	drafts := filepath.Join(s.App.State, "chapter-drafts", compat.Key(s.App.Project))
	return compat.Hash(strings.Join([]string{s.App.Project, stamp(catalog), stamp(drafts)}, "\x00")), nil
}

// syncWithState performs the full revision scan only when the saved-head stamp
// changed. The legacy Harness has no atomic directory-level mutation protocol,
// so it retains the original full scan.
func (s *Service) syncWithState(ctx context.Context, current State) (bool, error) {
	if !s.maintenanceEligible(current) {
		return false, nil
	}
	if s.App.ProjectionProvider == nil {
		return s.scanRevisions(ctx, "")
	}
	stamp, e := s.revisionStamp()
	if e != nil {
		return false, e
	}
	if stamp == current.ScanStamp {
		if current.ScanComplete {
			return false, nil
		}
		pending := 0
		for _, j := range current.Jobs {
			if j.Status == "pending" || j.Status == "retry" || j.Status == "running" {
				pending++
			}
		}
		// Keep a bounded queue supplied without rescanning on every completion.
		if pending > MaxQueue/4 {
			return false, nil
		}
		if retry, err := time.Parse(time.RFC3339Nano, current.ScanRetryAt); err == nil && time.Now().UTC().Before(retry) {
			return false, nil
		}
	}
	return s.scanRevisions(ctx, stamp)
}

func (s *Service) scanRevisions(ctx context.Context, stamp string) (bool, error) {
	p, e := s.App.Projection()
	if e != nil {
		return false, e
	}
	chapters, e := application.Sources(p)
	if e != nil {
		return false, e
	}
	type target struct {
		c application.Chapter
		r application.StoredRevision
	}
	targets := []target{}
	unreadable := map[string]bool{}
	for _, c := range application.OrderedChapters(chapters) {
		r, e := s.App.ReviewRevision(ctx, c)
		if e != nil {
			// One unresolved draft must not block already-runnable work for every
			// other chapter. Leave the discovery incomplete and retry later.
			if err := ctx.Err(); err != nil {
				return false, err
			}
			unreadable[c.ID] = true
			continue
		}
		targets = append(targets, target{c, r})
	}
	transacted := false
	e = s.transaction(ctx, func(st *State) (bool, error) {
		if !s.maintenanceEligible(*st) {
			return false, nil
		}
		changed := false
		if stamp != "" && st.ScanStamp != stamp {
			st.ScanStamp = stamp
			changed = true
		}
		active := map[string]target{}
		analysable := 0
		for _, t := range targets {
			active[t.c.ID] = t
			if strings.TrimSpace(t.r.Markdown) != "" {
				analysable++
			}
		}
		// Only write when the denominator really changed, so sync does not add
		// Version bumps that would turn author mutations into spurious 409s.
		if st.ChapterTotal != analysable {
			st.ChapterTotal = analysable
			changed = true
		}
		for i, j := range st.Jobs {
			// A read failure is not evidence that the saved revision changed.
			if unreadable[j.ChapterID] {
				continue
			}
			t, ok := active[j.ChapterID]
			if (!ok || t.r.ID != j.RevisionID || t.r.Hash != j.Hash || j.Strategy != Strategy || j.Model != s.Config.Info()) && (j.Status == "pending" || j.Status == "retry" || j.Status == "running") {
				st.Jobs[i].Status = "superseded"
				changed = true
			}
		}
		pending := 0
		for _, j := range st.Jobs {
			if j.Status == "pending" || j.Status == "retry" || j.Status == "running" {
				pending++
			}
		}
		capped := false
		for _, t := range targets {
			if strings.TrimSpace(t.r.Markdown) == "" {
				continue
			}
			exists := false
			for _, j := range st.Jobs {
				if j.ChapterID == t.c.ID && j.RevisionID == t.r.ID && j.Hash == t.r.Hash && j.Strategy == Strategy && j.Model == s.Config.Info() && j.Status != "superseded" && j.Status != "cancelled" {
					exists = true
					break
				}
			}
			if exists {
				continue
			}
			if pending >= MaxQueue {
				capped = true
				continue
			}
			if len(st.Jobs) >= 10000 {
				capped = true
				break
			}
			now := compat.Now()
			due := now
			if savedAt, err := time.Parse(time.RFC3339Nano, t.r.CreatedAt); err == nil && time.Since(savedAt) < s.QuietPeriod {
				due = savedAt.Add(s.QuietPeriod).Format(time.RFC3339Nano)
			}
			st.Jobs = append(st.Jobs, Job{ID: compat.UUID(), ChapterID: t.c.ID, RevisionID: t.r.ID, Hash: t.r.Hash, Strategy: Strategy, Model: s.Config.Info(), Status: "pending", Due: due, CreatedAt: now})
			pending++
			changed = true
		}
		complete := len(unreadable) == 0 && !capped
		if st.ScanComplete != complete {
			st.ScanComplete = complete
			changed = true
		}
		retryAt := ""
		if !complete && !capped {
			retryAt = time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)
		}
		if st.ScanRetryAt != retryAt {
			st.ScanRetryAt = retryAt
			changed = true
		}
		transacted = changed
		return changed, nil
	})
	return e == nil && transacted, e
}

// ProcessOne persists its lease before any network call. Other processes cannot claim
// a second job for this book until completion or the bounded deadline expires.
func (s *Service) ProcessOne(ctx context.Context) error { _, err := s.processOne(ctx); return err }

type ClaimedJob struct {
	Job      Job
	Snapshot State `json:"-"`
	Reserved int
	Day      string
	Started  string
}
type PreparedJob struct {
	Claim    ClaimedJob
	Revision application.StoredRevision
	Allowed  map[string]bool
	Request  llm.Request
}

func (s *Service) claim(ctx context.Context) (*ClaimedJob, error) {
	st, e := s.load()
	if e != nil {
		return nil, e
	}
	now := time.Now().UTC()
	runnable := false
	for _, j := range st.Jobs {
		due, _ := time.Parse(time.RFC3339Nano, j.Due)
		deadline, _ := time.Parse(time.RFC3339Nano, j.Deadline)
		if ((j.Status == "pending" || j.Status == "retry") && !now.Before(due)) || (j.Status == "running" && !now.Before(deadline)) {
			runnable = true
			break
		}
	}
	if !runnable {
		if _, e = s.syncWithState(ctx, st); e != nil {
			return nil, e
		}
		st, e = s.load()
		if e != nil {
			return nil, e
		}
	}
	var chosen *Job
	reservedThisAttempt := 0
	debitedDay := ""
	var snapshot State
	e = s.transaction(ctx, func(st *State) (bool, error) {
		if !st.Settings.Enabled || st.Settings.Paused || (s.Client == nil && !s.QueueOnly) || st.Settings.Model != s.Config.Info() || (st.Settings.ConfigFingerprint != "" && st.Settings.ConfigFingerprint != s.Config.Fingerprint()) || (s.ExecutorOwner == "pi" && st.Settings.ConfigFingerprint == "") {
			return false, nil
		}
		now := time.Now().UTC()
		changed := false
		policy, policyErr := (executorpolicy.Controller{State: s.App.State}).Read()
		for i, j := range st.Jobs {
			leased := j.Status == "running" || ((j.Status == "cancelled" || j.Status == "superseded") && j.Lease != "")
			if leased {
				deadline, deadlineErr := time.Parse(time.RFC3339Nano, j.Deadline)
				if deadlineErr == nil && now.Before(deadline) {
					return false, nil
				}
			}
			if j.Status == "running" {
				refundUnstartedExpiredLease(st, &st.Jobs[i], policy, policyErr, now)
				st.Jobs[i].Status = "retry"
				st.Jobs[i].Failure = "KNOWLEDGE_INTERRUPTED"
				if j.Attempts >= 3 {
					st.Jobs[i].Status = "failed"
				}
				st.Jobs[i].Lease = ""
				changed = true
				continue
			}
			if (j.Status == "cancelled" || j.Status == "superseded") && j.Lease != "" {
				refundUnstartedExpiredLease(st, &st.Jobs[i], policy, policyErr, now)
				st.Jobs[i].Lease = ""
				changed = true
			}
		}
		day := now.Format("2006-01-02")
		if st.BudgetDay != day {
			st.BudgetDay = day
			st.BudgetTokens = 0
			st.BudgetAttempts = 0
			changed = true
		}
		spent, count := st.BudgetTokens, st.BudgetAttempts
		for i, j := range st.Jobs {
			due, _ := time.Parse(time.RFC3339Nano, j.Due)
			if (j.Status != "pending" && j.Status != "retry") || now.Before(due) {
				continue
			}
			// Conservative per-attempt debit remains charged even if usage is unavailable.
			reserve := s.reserve()
			if spent+reserve > st.Settings.DailyTokenBudget || count >= st.Settings.DailyJobBudget {
				return changed, nil
			}
			reservedThisAttempt = reserve
			debitedDay = st.BudgetDay
			st.BudgetTokens += reserve
			st.BudgetAttempts++
			j.AttemptReserve = reserve
			j.DebitedDay = debitedDay
			j.ReservedTokens += reserve
			j.Attempts++
			j.Status = "running"
			j.ExecutorOwner = executorpolicy.Owner(s.ExecutorOwner)
			j.ExecutorEpoch = s.claimEpoch
			j.Lease = compat.UUID()
			j.Deadline = now.Add(s.timeout() + 15*time.Second).Format(time.RFC3339Nano)
			st.Jobs[i] = j
			chosen = &j
			snapshot = *st
			return true, nil
		}
		return changed, nil
	})
	if e != nil || chosen == nil {
		return nil, e
	}
	agentruntime.TaskEvent("task_claimed", "knowledge", s.App.Project, chosen.ID, chosen.Model.Model, chosen.Attempts, time.Now(), nil, "")
	if chosen.Attempts > 1 {
		agentruntime.TaskEvent("task_retried", "knowledge", s.App.Project, chosen.ID, chosen.Model.Model, chosen.Attempts, time.Now(), nil, "")
	}
	return &ClaimedJob{Job: *chosen, Snapshot: snapshot, Reserved: reservedThisAttempt, Day: debitedDay, Started: compat.Now()}, nil
}

// refundUnstartedExpiredLease releases the conservative reservation only when
// the durable executor marker proves the model request never started. Clearing
// the domain marker makes this settlement idempotent across process restarts.
func refundUnstartedExpiredLease(st *State, j *Job, policy executorpolicy.State, policyErr error, now time.Time) bool {
	marker, known := policy.Kinds["knowledge"].Leases[j.Lease]
	if policyErr != nil || !known || marker.Started || j.AttemptReserve <= 0 || j.DebitedDay != st.BudgetDay || st.BudgetDay != now.Format("2006-01-02") {
		return false
	}
	st.BudgetTokens = max(0, st.BudgetTokens-j.AttemptReserve)
	st.BudgetAttempts = max(0, st.BudgetAttempts-1)
	j.AttemptReserve = 0
	j.DebitedDay = ""
	return true
}

// Prepare constructs a bounded immutable model request without sending prose.
func (s *Service) Prepare(ctx context.Context, claim *ClaimedJob) (*PreparedJob, error) {
	p := &PreparedJob{Claim: *claim, Allowed: map[string]bool{}}
	c, err := s.App.Source(claim.Job.ChapterID)
	if err != nil {
		return p, err
	}
	p.Revision, err = s.App.ReviewRevision(ctx, c)
	if err != nil {
		return p, err
	}
	if p.Revision.ID != claim.Job.RevisionID || p.Revision.Hash != claim.Job.Hash {
		return p, application.Fail(409, "KNOWLEDGE_SUPERSEDED", "Source changed.")
	}
	p.Request, err = s.prepareRequest(ctx, claim.Job, p.Revision, claim.Snapshot, p.Allowed)
	return p, err
}
func (s *Service) processOne(ctx context.Context) (bool, error) {
	if s.Client == nil {
		return false, s.sync(ctx)
	}
	claim, e := s.Claim(ctx)
	if e != nil || claim == nil {
		return false, e
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
	return true, s.Complete(ctx, p, response, sent, err)
}

// Complete is the sole evidence-validation and domain commit path for both executors.
func (s *Service) complete(ctx context.Context, p *PreparedJob, response llm.Response, sent bool, err error) error {
	started, _ := time.Parse(time.RFC3339Nano, p.Claim.Started)
	receipt := completionHash(response, sent, err)
	j, rev, allowedEntities := p.Claim.Job, p.Revision, p.Allowed
	defer func() {
		st, e := s.load()
		if e == nil {
			for _, v := range st.Jobs {
				if v.ID == j.ID && v.Lease == "" && v.Attempts == j.Attempts {
					agentruntime.TaskEvent("task_"+v.Status, "knowledge", s.App.Project, v.ID, v.Model.Model, v.Attempts, started, v.Usage, v.Failure)
				}
			}
		}
	}()
	reservedThisAttempt, debitedDay := p.Claim.Reserved, p.Claim.Day
	var output Output
	var discarded ValidationDiscards
	var e error
	if err == nil {
		var raw Output
		raw, err = Decode(response.Text)
		if err == nil {
			output, discarded = ValidateCandidates(rev, raw)
			if (len(raw.Entities) > 0 || len(raw.Assertions) > 0) && len(output.Assertions) == 0 {
				// Preserve the old fail-closed behavior when no assertion in the
				// response has valid evidence. An empty model response is still a
				// valid extraction and may deliberately retire earlier claims.
				err = errors.New("LLM_INVALID_EVIDENCE")
			}
		}
		if err == nil {
			for _, entity := range output.Entities {
				if entity.ExistingID != "" && !allowedEntities[entity.ExistingID] {
					err = application.Fail(502, "LLM_INVALID_ENTITY_REFERENCE", "Model linked an entity outside the supplied context.")
					break
				}
			}
		}
	}
	if err == nil {
		for _, a := range output.Assertions {
			if _, e := evidence(s.App.Project, j.ChapterID, rev, a); e != nil {
				err = e
				break
			}
		}
	}
	recordUsage := func(current Job) Job {
		current.DurationMS += time.Since(started).Milliseconds()
		if !sent {
			return current
		}
		current.ModelCalls++
		if response.Usage == nil {
			current.UsageIncomplete = true
		} else {
			if current.Usage == nil {
				current.Usage = &llm.Usage{}
			}
			current.Usage.InputTokens += response.Usage.InputTokens
			current.Usage.OutputTokens += response.Usage.OutputTokens
		}
		return current
	}
	recordDiscards := func(current Job) Job {
		current.DiscardedAliases += discarded.Aliases
		current.DiscardedAssertions += discarded.Assertions
		current.DiscardedEntities += discarded.Entities
		return current
	}
	settleBudget := func(st *State) {
		if st.BudgetDay == debitedDay && !sent {
			st.BudgetTokens -= reservedThisAttempt
			st.BudgetAttempts--
			return
		}
		if st.BudgetDay == debitedDay && response.Usage != nil {
			st.BudgetTokens += response.Usage.InputTokens + response.Usage.OutputTokens - reservedThisAttempt
		}
	}
	finish := func(st *State) (bool, error) {
		for i, current := range st.Jobs {
			deadline, parseErr := time.Parse(time.RFC3339Nano, current.Deadline)
			if current.ID == j.ID && current.Lease == j.Lease && (parseErr != nil || time.Now().After(deadline)) {
				return false, nil
			}
			if current.ID == j.ID && current.Lease == j.Lease && (current.Status == "cancelled" || current.Status == "superseded") {
				current = recordUsage(current)
				current = recordDiscards(current)
				settleBudget(st)
				current.Deadline = compat.Now()
				current.Lease = ""
				if current.CompletionReceipts == nil {
					current.CompletionReceipts = map[string]string{}
				}
				current.CompletionReceipts[j.Lease] = receipt
				st.Jobs[i] = current
				return true, nil
			}
			if current.ID != j.ID || current.Lease != j.Lease || current.Status != "running" {
				continue
			}
			if st.Settings.Paused || !st.Settings.Enabled || st.Settings.Model != j.Model {
				return false, nil
			}
			current = recordDiscards(recordUsage(current))
			settleBudget(st)
			current.CompletedAt = compat.Now()
			if err == nil {
				data, _ := json.Marshal(st)
				var next State
				_ = json.Unmarshal(data, &next)
				if e := apply(&next, j, rev, output); e != nil {
					err = e
				} else {
					*st = next
				}
			}
			if err == nil {
				current.Status = "completed"
				current.Failure = ""
				if discarded.Total() > 0 {
					current.Failure = "PARTIAL_EXTRACTION"
				}
			} else {
				current.Failure = "KNOWLEDGE_EXTRACTION_FAILED"
				var modelError *llm.Error
				if errors.As(err, &modelError) {
					current.Failure = modelError.Code
				}
				var domainError *application.Error
				if errors.As(err, &domainError) {
					current.Failure = domainError.Code
				}
				if err.Error() == "LLM_INVALID_EVIDENCE" || err.Error() == "LLM_INVALID_OUTPUT" || err.Error() == "LLM_UNSUPPORTED_ENTITY" || err.Error() == "KNOWLEDGE_CHAPTER_TOO_LARGE" {
					current.Failure = err.Error()
				}
				current.Status = "retry"
				current.Due = time.Now().UTC().Add(time.Duration(1<<current.Attempts) * time.Second).Format(time.RFC3339Nano)
				if current.Attempts >= 3 || !sent {
					current.Status = "failed"
				}
				if current.Failure == "KNOWLEDGE_SUPERSEDED" {
					current.Status = "superseded"
				}
			}
			current.Lease = ""
			if current.CompletionReceipts == nil {
				current.CompletionReceipts = map[string]string{}
			}
			current.CompletionReceipts[j.Lease] = receipt
			st.Jobs[i] = current
			return true, nil
		}
		return false, nil
	}
	// Consistent with publication: keep the source lock through the knowledge commit.
	// No network calls occur inside these locks.
	if err == nil {
		e = s.App.WithReviewRevision(ctx, j.ChapterID, func(head application.StoredRevision) error {
			if head.ID != j.RevisionID || head.Hash != j.Hash {
				err = application.Fail(409, "KNOWLEDGE_SUPERSEDED", "Source changed before knowledge commit.")
			}
			return s.transaction(ctx, finish)
		})
		if e != nil {
			err = e
			return s.transaction(ctx, finish)
		}
		return nil
	}
	return s.transaction(ctx, finish)
}
func (s *Service) timeout() time.Duration {
	if s.Config.Timeout > 0 {
		return s.Config.Timeout
	}
	return 60 * time.Second
}

func (s *Service) Claim(ctx context.Context) (out *ClaimedJob, err error) {
	err = (executorpolicy.Controller{State: s.App.State}).Claim(ctx, "knowledge", s.ExecutorOwner, func(epoch uint64) (string, string, error) {
		copy := *s
		copy.claimEpoch = epoch
		var e error
		out, e = copy.claim(ctx)
		if e != nil || out == nil {
			return "", "", e
		}
		return out.Job.Lease, out.Job.Deadline, nil
	})
	if errors.Is(err, executorpolicy.ErrFenced) {
		err = nil
	}
	return
}
func (s *Service) Complete(ctx context.Context, p *PreparedJob, response llm.Response, sent bool, modelErr error) error {
	j := p.Claim.Job
	if s.Completed(p, response, sent, modelErr) {
		return nil
	}
	return (executorpolicy.Controller{State: s.App.State}).Guard(ctx, "knowledge", j.ExecutorOwner, j.ExecutorEpoch, j.Lease, true, func() error { return s.complete(ctx, p, response, sent, modelErr) })
}

func completionHash(response llm.Response, sent bool, e error) string {
	code := ""
	if e != nil {
		code = e.Error()
	}
	b, _ := json.Marshal([]any{response, sent, code})
	return compat.Hash(string(b))
}
func (s *Service) Completed(p *PreparedJob, response llm.Response, sent bool, e error) bool {
	st, err := s.load()
	if err != nil {
		return false
	}
	for _, j := range st.Jobs {
		if j.ID == p.Claim.Job.ID {
			return j.CompletionReceipts[p.Claim.Job.Lease] == completionHash(response, sent, e)
		}
	}
	return false
}
