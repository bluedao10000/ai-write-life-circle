package review

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"sort"
	"sync"
	"time"
)

type Service struct {
	ExecutorOwner  string
	claimEpoch     uint64
	claimID        string
	MemoryChapters func(context.Context, string) ([]string, error)
	// DisableLocalExecution is set only by the business API process. Queued work
	// is then claimed by the independent Agent Worker. Embedded deployments keep
	// the existing single-process executor so local behavior is unchanged.
	DisableLocalExecution bool
	App                   *application.Service
	Config                llm.Config
	Client                llm.Client
	root                  context.Context
	stop                  context.CancelFunc
	mu                    sync.Mutex
	jobs                  map[string]context.CancelFunc
	persistenceFailures   map[string]bool
	wg                    sync.WaitGroup
	write                 func(context.Context, string, any) error
}

func New(app *application.Service, c llm.Config, client llm.Client) *Service {
	root, stop := context.WithCancel(context.Background())
	return &Service{App: app, Config: c, Client: client, root: root, stop: stop, jobs: map[string]context.CancelFunc{}, persistenceFailures: map[string]bool{}, write: storage.Write}
}
func (s *Service) Close() {
	s.stop()
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}
func fingerprint(v any) string { b, _ := json.Marshal(v); return compat.Hash(string(b)) }
func keyOK(key string) error {
	if !application.SafeKey(key) {
		return failure(422, "VALIDATION_FAILED", "A valid Idempotency-Key is required.")
	}
	return nil
}
func (s *Service) Preview(ctx context.Context, a application.Actor, id string, in Input) (Plan, error) {
	if e := author(a); e != nil {
		return Plan{}, e
	}
	// Check account quota before building the explicit sending scope.
	if e := s.App.MeterAllow(ctx, "review"); e != nil {
		return Plan{}, e
	}
	return s.BuildPlan(ctx, id, in)
}
func (s *Service) Start(ctx context.Context, a application.Actor, chapterID, key string, in CreateInput) (Run, error) {
	if e := author(a); e != nil {
		return Run{}, e
	}
	if e := keyOK(key); e != nil {
		return Run{}, e
	}
	normalized, e := normalize(in.Input)
	if e != nil {
		return Run{}, e
	}
	in.Input = normalized
	if !in.Consent.Confirmed || !validHash(in.Consent.PlanHash) {
		return Run{}, failure(422, "REVIEW_CONSENT_REQUIRED", "Confirm the displayed model and exact source scope before reviewing.")
	}
	fp := fingerprint(struct {
		Actor, Chapter string
		Input          CreateInput
	}{a.ID, chapterID, in})
	var existing *Run
	e = s.transaction(ctx, func(st *state) (bool, error) {
		if r, ok := st.Requests[key]; ok {
			if r.Fingerprint != fp || r.Action != "create" {
				return false, failure(422, "IDEMPOTENCY_KEY_REUSED", "The review key was used for a different request.")
			}
			value, ok := st.Runs[r.RunID]
			if !ok {
				return false, storageFailure()
			}
			existing = &value
		}
		return false, nil
	})
	if e != nil {
		return Run{}, e
	}
	// A replay of an accepted request succeeds even after account quota changes.
	if existing == nil {
		if e := s.App.MeterAllow(ctx, "review"); e != nil {
			return Run{}, e
		}
	}
	if existing != nil {
		return s.freshen(ctx, *existing), nil
	}
	plan, e := s.BuildPlan(ctx, chapterID, in.Input)
	if e != nil {
		return Run{}, e
	}
	if plan.PlanHash != in.Consent.PlanHash {
		return Run{}, failure(409, "REVIEW_CONTEXT_CHANGED", "The model or source scope changed. Preview and confirm the scope again.")
	}
	var created bool
	reserved := ""
	var run Run
	e = s.transaction(ctx, func(st *state) (bool, error) {
		if rec, ok := st.Requests[key]; ok {
			if rec.Fingerprint != fp || rec.Action != "create" {
				return false, failure(422, "IDEMPOTENCY_KEY_REUSED", "The review key was used for a different request.")
			}
			run = st.Runs[rec.RunID]
			return false, nil
		}
		if len(st.Requests) >= 10000 {
			return false, failure(409, "REVIEW_HISTORY_FULL", "The bounded review request history is full.")
		}
		for _, prior := range st.Runs {
			if prior.PlanHash == plan.PlanHash && prior.CreatedBy == a.ID && (prior.Status == "running" || prior.Status == "queued") {
				run = prior
				st.Requests[key] = requestRecord{fp, run.RunID, "create"}
				return true, nil
			}
		}
		for _, prior := range st.Runs {
			if prior.Status == "running" || prior.Status == "queued" {
				return false, failure(409, "REVIEW_BUSY", "This project already has an active review. Wait or cancel it.")
			}
		}
		if len(st.Runs) >= 200 || len(st.Requests) >= 10000 {
			return false, failure(409, "REVIEW_HISTORY_FULL", "The bounded review history is full. Export/archive application review state before starting more runs.")
		}
		now := compat.Now()
		deadline := time.Now().UTC().Add(s.Config.Timeout + 10*time.Second).Format(time.RFC3339Nano)
		run = Run{Plan: plan, RunID: compat.UUID(), CreatedBy: a.ID, Version: 1, Status: "queued", StartedAt: now, DeadlineAt: deadline, Findings: []Finding{}, RejectionReasons: []string{}, StaleReasons: []string{}}
		if plan.Cost != nil {
			op := meterOp(run.RunID, 1)
			if e := s.App.MeterReserve(ctx, op, "review", s.planReserve(plan)); e != nil {
				return false, e
			}
			reserved = op
		}
		st.Runs[run.RunID] = run
		st.Requests[key] = requestRecord{fp, run.RunID, "create"}
		created = true
		return true, nil
	})
	if e != nil {
		if reserved != "" {
			s.App.MeterSettle(context.Background(), reserved, 0)
		}
		return Run{}, e
	}
	if created {
		agentruntime.TaskEvent("task_created", "review", s.App.Project, run.RunID, run.Model.Model, 0, time.Time{}, nil, "")
		if s.DisableLocalExecution {
			return s.freshen(ctx, run), nil
		}
		jobCtx, cancel := context.WithCancel(s.root)
		s.mu.Lock()
		s.jobs[run.RunID] = cancel
		s.mu.Unlock()
		s.wg.Add(1)
		go s.execute(jobCtx, cancel, run)
	}
	return s.freshen(ctx, run), nil
}

// Embedded compatibility mode uses exactly the durable worker phases as well.
func (s *Service) execute(ctx context.Context, cancel context.CancelFunc, run Run) {
	defer s.wg.Done()
	defer cancel()
	defer func() { s.mu.Lock(); delete(s.jobs, run.RunID); s.mu.Unlock() }()
	if ctx.Err() != nil {
		return
	}
	claim, e := s.claimRun(ctx, run.RunID)
	if e == nil && claim != nil {
		e = s.Process(ctx, claim)
	}
	if e != nil && !errors.Is(e, executorpolicy.ErrFenced) && ctx.Err() == nil {
		s.mu.Lock()
		s.persistenceFailures[run.RunID] = true
		s.mu.Unlock()
	}
}
func (s *Service) Get(ctx context.Context, a application.Actor, id string) (Run, error) {
	if e := author(a); e != nil {
		return Run{}, e
	}
	s.mu.Lock()
	failed := s.persistenceFailures[id]
	s.mu.Unlock()
	if failed {
		return Run{}, storageFailure()
	}
	var run Run
	e := s.transaction(ctx, func(st *state) (bool, error) {
		var ok bool
		run, ok = st.Runs[id]
		if !ok {
			return false, failure(404, "NOT_FOUND", "Review run was not found in this project.")
		}
		return false, nil
	})
	if e != nil {
		return Run{}, e
	}
	return s.freshen(ctx, run), nil
}
func (s *Service) List(ctx context.Context, a application.Actor, chapter string) ([]Run, error) {
	if e := author(a); e != nil {
		return nil, e
	}
	items := []Run{}
	e := s.transaction(ctx, func(st *state) (bool, error) {
		for _, r := range st.Runs {
			if r.ChapterID == chapter {
				items = append(items, r)
			}
		}
		return false, nil
	})
	if e != nil {
		return nil, e
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].StartedAt == items[j].StartedAt {
			return items[i].RunID > items[j].RunID
		}
		return items[i].StartedAt > items[j].StartedAt
	})
	for i, r := range items {
		s.mu.Lock()
		failed := s.persistenceFailures[r.RunID]
		s.mu.Unlock()
		if failed {
			return nil, storageFailure()
		}
		items[i] = s.freshen(ctx, r)
	}
	return items, nil
}
func (s *Service) Cancel(ctx context.Context, a application.Actor, id, key string) (Run, error) {
	if e := author(a); e != nil {
		return Run{}, e
	}
	if e := keyOK(key); e != nil {
		return Run{}, e
	}
	var run Run
	fp := fingerprint([]string{"cancel", id, a.ID})
	e := s.transaction(ctx, func(st *state) (bool, error) {
		value, ok := st.Runs[id]
		if !ok {
			return false, failure(404, "NOT_FOUND", "Review run was not found.")
		}
		run = value
		if rec, ok := st.Requests[key]; ok {
			if rec.Fingerprint != fp || rec.Action != "cancel" {
				return false, failure(422, "IDEMPOTENCY_KEY_REUSED", "The review key was used for a different request.")
			}
			return false, nil
		}
		if len(st.Requests) >= 10000 {
			return false, failure(409, "REVIEW_HISTORY_FULL", "The bounded review request history is full.")
		}
		if run.Status != "running" && run.Status != "queued" && run.Status != "cancelled" {
			return false, failure(409, "REVIEW_NOT_RUNNING", "This review already finished.")
		}
		at := compat.Now()
		if run.Status != "cancelled" {
			run.Status = "cancelled"
			run.CompletedAt = &at
			run.Version++
		}
		st.Runs[id] = run
		st.Requests[key] = requestRecord{fp, id, "cancel"}
		return true, nil
	})
	if e != nil {
		return Run{}, e
	}
	if meter, ok := s.App.Meter.(interface {
		ReleaseUnstartedReview(context.Context, string, string) error
	}); ok {
		if e := meter.ReleaseUnstartedReview(ctx, s.App.Owner, meterOp(run.RunID, max(1, run.Attempts))); e != nil {
			return Run{}, e
		}
	}

	s.mu.Lock()
	cancel := s.jobs[id]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return s.freshen(ctx, run), nil
}
func (s *Service) Feedback(ctx context.Context, a application.Actor, id, findingID, key string, in FeedbackInput) (Run, error) {
	if e := author(a); e != nil {
		return Run{}, e
	}
	if e := keyOK(key); e != nil {
		return Run{}, e
	}
	if !contains([]string{"useful", "false_positive", "intentional", "ignored"}, in.Choice) || in.BaseVersion < 1 {
		return Run{}, failure(422, "VALIDATION_FAILED", "Feedback requires a supported choice and current run version.")
	}
	fp := fingerprint(struct {
		Run, Finding, Actor string
		Input               FeedbackInput
	}{id, findingID, a.ID, in})
	var run Run
	e := s.transaction(ctx, func(st *state) (bool, error) {
		r, ok := st.Runs[id]
		if !ok {
			return false, failure(404, "NOT_FOUND", "Review run was not found.")
		}
		run = r
		if rec, ok := st.Requests[key]; ok {
			if rec.Fingerprint != fp || rec.Action != "feedback" {
				return false, failure(422, "IDEMPOTENCY_KEY_REUSED", "The review key was used for a different request.")
			}
			return false, nil
		}
		if run.Status != "completed" {
			return false, failure(409, "REVIEW_NOT_COMPLETED", "Only a completed review can receive finding feedback.")
		}
		if run.Version != in.BaseVersion {
			return false, failure(409, "REVIEW_VERSION_CONFLICT", "The review feedback changed. Reload before deciding again.")
		}
		if len(st.Requests) >= 10000 || len(st.Feedback) >= 10000 {
			return false, failure(409, "REVIEW_HISTORY_FULL", "The bounded feedback history is full.")
		}
		index := -1
		for i, f := range run.Findings {
			if f.FindingID == findingID {
				index = i
				break
			}
		}
		if index < 0 {
			return false, failure(404, "NOT_FOUND", "Finding was not found in this review.")
		}
		run.Version++
		value := Feedback{findingID, in.Choice, a.ID, compat.Now(), run.Version}
		run.Findings[index].Feedback = &value
		st.Feedback = append(st.Feedback, value)
		st.Runs[id] = run
		st.Requests[key] = requestRecord{fp, id, "feedback"}
		return true, nil
	})
	if e != nil {
		return Run{}, e
	}
	return s.freshen(ctx, run), nil
}
