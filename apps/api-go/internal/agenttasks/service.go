// Package agenttasks exposes bounded, leased AI task snapshots; all domain writes remain in Go.
package agenttasks

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const Protocol = executorpolicy.Protocol

type Task struct {
	ID           string        `json:"taskId"`
	Kind         string        `json:"kind"`
	Book         string        `json:"bookId"`
	Author       string        `json:"authorId"`
	Lease        string        `json:"leaseToken"`
	Epoch        uint64        `json:"executorEpoch"`
	Attempt      int           `json:"attempt"`
	Deadline     string        `json:"deadline"`
	Strategy     string        `json:"strategyVersion"`
	Revision     string        `json:"revisionId"`
	ContentHash  string        `json:"contentHash"`
	InputHash    string        `json:"inputHash"`
	Model        llm.ModelInfo `json:"model"`
	Config       string        `json:"configFingerprint"`
	OutputSchema string        `json:"outputSchemaVersion"`
	Reserved     int           `json:"reservedTokens"`
	BudgetDay    string        `json:"budgetDay"`
	Consent      any           `json:"consent"`
	Request      llm.Request   `json:"request"`
}
type Record struct {
	Audit       []ExecutionAudit       `json:"audit,omitempty"`
	Outcome     string                 `json:"outcome,omitempty"`
	CompletedAt string                 `json:"completedAt,omitempty"`
	Task        Task                   `json:"task"`
	Instance    string                 `json:"instance"`
	Started     bool                   `json:"started"`
	Finished    bool                   `json:"finished"`
	ResultHash  string                 `json:"resultHash,omitempty"`
	Knowledge   *knowledge.PreparedJob `json:"knowledge,omitempty"`
	Review      *review.ClaimedRun     `json:"review,omitempty"`
	Creative    *creative.PreparedJob  `json:"creative,omitempty"`
	Memory      *PreparedMemory        `json:"memory,omitempty"`
}
type Registry struct {
	Schema int               `json:"schema"`
	Tasks  map[string]Record `json:"tasks"`
	Cursor int               `json:"cursor"`
	// Claims counts claimed tasks; every third claim ignores plan priority.
	Claims int `json:"claims,omitempty"`
}
type Service struct {
	Management *application.Management
	// Tasks run as the owner of their book (Task.Author); there is no
	// process-wide author.
	State  string
	Config llm.Config
	Token  string
	// Priority reports whether an owner's plan gets the first claim on
	// background work (Pro); nil means normal priority for everyone.
	Priority func(ctx context.Context, owner string) bool
	// Memory supplies background consolidation. It owns source validation and
	// candidate publication; this registry remains the task/lease authority.
	Memory MemoryCoordinator
}

// resolveTask opens a task's book as the author recorded at claim time, and
// only while that author still owns it.
func (s *Service) resolveTask(t Task) (*application.Service, error) {
	if t.Author == "" {
		return nil, executorpolicy.ErrFenced
	}
	return s.Management.Resolve(application.Actor{ID: t.Author, Role: "author"}, t.Book)
}

func (s *Service) path() string { return filepath.Join(s.State, "agent-runtime/tasks-v1.json") }
func (s *Service) load() (Registry, error) {
	st := Registry{}
	found, e := storage.Read(s.path(), &st)
	if e != nil {
		return st, e
	}
	if !found {
		st = Registry{Schema: 1, Tasks: map[string]Record{}}
	}
	for id, r := range st.Tasks {
		validKind := r.Task.Kind == "review.execute" || r.Task.Kind == "knowledge.extract" || r.Task.Kind == "creative.organize" || r.Task.Kind == "creative.plan_check" || r.Task.Kind == "memory.consolidate"
		validPayload := (r.Task.Kind == "review.execute" && r.Review != nil && r.Knowledge == nil && r.Creative == nil && r.Memory == nil) ||
			(r.Task.Kind == "knowledge.extract" && r.Review == nil && r.Knowledge != nil && r.Creative == nil && r.Memory == nil) ||
			((r.Task.Kind == "creative.organize" || r.Task.Kind == "creative.plan_check") && r.Review == nil && r.Knowledge == nil && r.Creative != nil && r.Memory == nil) ||
			(r.Task.Kind == "memory.consolidate" && r.Review == nil && r.Knowledge == nil && r.Creative == nil && r.Memory != nil)
		if id != r.Task.ID || r.Task.Book == "" || !validKind || !validPayload {
			return st, errors.New("invalid persisted task identity")
		}
	}
	if st.Schema != 1 || st.Tasks == nil {
		return st, errors.New("invalid task registry")
	}
	return st, nil
}
func (s *Service) transaction(ctx context.Context, fn func(*Registry) error) error {
	return storage.Lock(ctx, s.path()+".lock", func() error {
		st, e := s.load()
		if e != nil {
			return e
		}
		if e = fn(&st); e != nil {
			return e
		}
		return storage.Write(ctx, s.path(), st)
	})
}
func (s *Service) review(app *application.Service) *review.Service {
	r := review.New(app, s.Config, nil)
	r.ExecutorOwner = "pi"
	r.MemoryChapters = knowledge.New(app, s.Config, nil).RelatedChapters
	return r
}
func (s *Service) knowledge(app *application.Service) *knowledge.Service {
	k := knowledge.New(app, s.Config, nil)
	k.QueueOnly = true
	k.ExecutorOwner = "pi"
	k.QuietPeriod = 2 * time.Second
	return k
}
func (s *Service) creative(app *application.Service) *creative.Service {
	c := creative.New(app, s.Config, nil)
	c.QueueOnly = true
	c.ExecutorOwner = "pi"
	return c
}
func (s *Service) Claim(ctx context.Context, instance, config string, kinds ...string) (*Task, error) {
	if s.Config.ValidatePublic() != nil {
		return nil, application.Fail(503, "LLM_NOT_CONFIGURED", "Task execution configuration is unavailable.")
	}
	if len(instance) < 1 || len(instance) > 128 || config != s.Config.Fingerprint() {
		return nil, application.Fail(409, "AGENT_CONFIG_CHANGED", "Worker capability must match before claiming a source snapshot.")
	}
	books, e := s.Management.OwnedBooks()
	if e != nil {
		return nil, e
	}
	// Fair rotation over book/kind pairs. Review is first, historical work gets a bounded turn.
	var out *Task
	e = s.transaction(ctx, func(st *Registry) error {
		expire(st)
		domains := []string{"review", "knowledge", "creative"}
		if s.Memory != nil {
			domains = append(domains, "memory")
		}
		total := len(books) * len(domains)
		if total == 0 {
			return nil
		}
		attempted := []PreparedMemory{}
		for _, rec := range st.Tasks {
			if rec.Memory != nil {
				attempted = append(attempted, *rec.Memory)
			}
		}
		active := 0
		for _, rec := range st.Tasks {
			if !rec.Finished && (executorpolicy.Controller{State: s.State}).Valid(domain(rec.Task.Kind), "pi", rec.Task.Epoch, rec.Task.Lease) {
				active++
			}
		}
		if active >= 2 {
			return nil
		}
		policy, e := (executorpolicy.Controller{State: s.State}).Read()
		if e != nil {
			return e
		}
		// Pro books get the first claim, except on every third claim, so a
		// busy priority author cannot starve everyone else. Priority claims
		// leave the rotation cursor alone.
		priority := map[string]bool{}
		if s.Priority != nil && st.Claims%3 != 2 {
			for _, b := range books {
				if _, seen := priority[b.Owner.ID]; !seen {
					priority[b.Owner.ID] = s.Priority(ctx, b.Owner.ID)
				}
			}
		}
		for _, i := range compat.PriorityOrder(total, st.Cursor, func(i int) bool { return priority[books[i/len(domains)].Owner.ID] }) {
			kind := domains[i%len(domains)]
			if len(kinds) > 0 {
				supported := false
				for _, k := range kinds {
					if k == kind {
						supported = true
					}
				}
				if !supported {
					continue
				}
			}
			assignment := policy.Kinds[kind]
			if assignment.Owner != "pi" || assignment.Draining {
				continue
			}
			owner := books[i/len(domains)].Owner
			app, e := s.Management.Resolve(owner, books[i/len(domains)].Book.ID)
			if e != nil {
				continue
			}
			rec := Record{Instance: instance}
			task := Task{ID: compat.UUID(), Kind: taskKind(kind), Book: app.Project, Author: owner.ID, Model: s.Config.Info(), Config: s.Config.Fingerprint(), OutputSchema: kind + "-candidates-v1"}
			if kind == "review" {
				r := s.review(app)
				claim, e := r.Claim(ctx)
				if e != nil {
					return e
				}
				if claim == nil {
					continue
				}
				request, e := r.Prepare(ctx, claim)
				r.Close()
				if e != nil {
					_ = r.Complete(claim, llm.Response{}, e)
					continue
				}
				run := claim.Run
				task.Lease = run.Lease
				task.Epoch = run.ExecutorEpoch
				task.Attempt = run.Attempts
				task.Deadline = run.DeadlineAt
				task.Strategy = run.StrategyVersion
				task.Revision = run.RevisionID
				task.ContentHash = run.ContentHash
				task.Reserved = run.BudgetBytes + 20000 + s.Config.MaxOutputTokens
				if request.OutputLimit > 0 {
					task.Reserved = run.BudgetBytes + 20000 + request.OutputLimit
				}
				task.Consent = run.Plan
				task.Request = request
				rec.Review = claim
			} else if kind == "knowledge" {
				k := s.knowledge(app)
				claim, e := k.Claim(ctx)
				if e != nil {
					return e
				}
				if claim == nil {
					continue
				}
				prepared, e := k.Prepare(ctx, claim)
				if e != nil {
					_ = k.Complete(ctx, prepared, llm.Response{}, false, e)
					continue
				}
				j := claim.Job
				task.Lease = j.Lease
				task.Epoch = j.ExecutorEpoch
				task.Attempt = j.Attempts
				task.Deadline = j.Deadline
				task.Strategy = j.Strategy
				task.Revision = j.RevisionID
				task.ContentHash = j.Hash
				task.Reserved = claim.Reserved
				task.BudgetDay = claim.Day
				task.Consent = claim.Snapshot.Settings
				task.Request = prepared.Request
				rec.Knowledge = prepared
			} else if kind == "creative" {
				c := s.creative(app)
				claim, e := c.Claim(ctx)
				if e != nil {
					return e
				}
				if claim == nil {
					continue
				}
				prepared, e := c.Prepare(ctx, claim)
				if e != nil {
					_ = c.Complete(ctx, prepared, llm.Response{}, false, e)
					continue
				}
				j := claim.Job
				task.Kind = "creative." + j.Kind
				task.OutputSchema = "creative-" + j.Kind + "-candidates-v1"
				if j.Strategy == creative.PlanStrategyReadonly {
					task.OutputSchema = creative.PlanOutputReadonly
				}
				task.Lease = j.Lease
				task.Epoch = j.ExecutorEpoch
				task.Attempt = j.Attempts
				task.Deadline = j.Deadline
				task.Strategy = j.Strategy
				task.Revision = j.RevisionID
				task.ContentHash = j.ContentHash
				task.Reserved = claim.Reserved
				task.BudgetDay = claim.Day
				task.Consent = claim.Snapshot.Settings
				task.Request = prepared.Request
				rec.Creative = prepared
			} else {
				task.Lease = compat.UUID()
				task.Attempt = 1
				timeout := s.Config.Timeout
				if timeout <= 0 {
					timeout = 60 * time.Second
				}
				task.Deadline = time.Now().Add(timeout + 15*time.Second).UTC().Format(time.RFC3339Nano)
				var prepared *PreparedMemory
				e = (executorpolicy.Controller{State: s.State}).Claim(ctx, "memory", "pi", func(epoch uint64) (string, string, error) {
					prepared, e = s.Memory.Prepare(ctx, app, attempted)
					if e != nil || prepared == nil {
						return "", "", e
					}
					task.Epoch = epoch
					task.Kind = "memory.consolidate"
					task.OutputSchema = "memory-candidate-v1"
					task.Strategy = prepared.Strategy
					task.ContentHash = strings.Join(memoryTaskIDs(*prepared), ",")
					task.Reserved = prepared.ReservedTokens
					task.BudgetDay = prepared.BudgetDay
					task.Consent = map[string]any{"backgroundMemoryConsolidation": true}
					task.Request = prepared.Request
					rec.Memory = prepared
					return task.Lease, task.Deadline, nil
				})
				if e != nil {
					return e
				}
				if prepared == nil {
					continue
				}
			}
			raw, _ := json.Marshal(task.Request)
			task.InputHash = compat.Hash(string(raw))
			rec.Task = task
			rec.audit("claimed", "")
			st.Tasks[task.ID] = rec
			if !priority[owner.ID] {
				st.Cursor = (i + 1) % total
			}
			st.Claims = (st.Claims + 1) % 3000
			out = &task
			return nil
		}
		return nil
	})
	return out, e
}

// Envelope is an exact echo of immutable execution identity, not a writable task definition.
type Envelope struct {
	Lease     string       `json:"leaseToken"`
	Epoch     uint64       `json:"executorEpoch"`
	Attempt   int          `json:"attempt"`
	Kind      string       `json:"kind"`
	InputHash string       `json:"inputHash"`
	Instance  string       `json:"instance"`
	Response  llm.Response `json:"response"`
	Failure   string       `json:"failureCode,omitempty"`
}

func (s *Service) check(ctx context.Context, rec Record) error {
	t := rec.Task
	if !(executorpolicy.Controller{State: s.State}).Valid(domain(t.Kind), "pi", t.Epoch, t.Lease) {
		return executorpolicy.ErrFenced
	}
	app, e := s.resolveTask(t)
	if e != nil {
		return e
	}
	if rec.Knowledge != nil {
		return s.knowledge(app).Check(ctx, rec.Knowledge)
	}
	if rec.Creative != nil {
		return s.creative(app).Check(ctx, rec.Creative)
	}
	if rec.Memory != nil {
		return s.Memory.Check(ctx, app, *rec.Memory)
	}
	r := s.review(app)
	defer r.Close()
	return r.Check(ctx, rec.Review)
}
func (s *Service) Action(ctx context.Context, id, action string, in Envelope) error {
	var denied error
	err := s.transaction(ctx, func(st *Registry) error {
		rec, ok := st.Tasks[id]
		t := rec.Task
		if !ok || in.Lease != t.Lease || in.Epoch != t.Epoch || in.Attempt != t.Attempt || in.Kind != t.Kind || in.InputHash != t.InputHash || in.Instance != rec.Instance {
			return executorpolicy.ErrFenced
		}
		raw, _ := json.Marshal(in)
		fp := compat.Hash(string(raw))
		if rec.Finished && rec.ResultHash != "expired" {
			if (action == "complete" || action == "fail") && fp == rec.ResultHash {
				return nil
			}
			return executorpolicy.ErrFenced
		}
		// A domain receipt is the commit authority if the API crashed after the
		// domain rename and before acknowledging the task-registry receipt.
		if action == "complete" || action == "fail" {
			app, e := s.resolveTask(t)
			if e != nil {
				return e
			}
			var outcome error
			if action == "fail" {
				if !failureAllowed(in.Failure) {
					return llm.Fail("LLM_INVALID_FAILURE")
				}
				outcome = llm.Fail(in.Failure)
			}
			completed := false
			if rec.Memory != nil {
				completed = false
			} else if rec.Knowledge != nil {
				completed = s.knowledge(app).Completed(rec.Knowledge, in.Response, rec.Started, outcome)
			} else if rec.Creative != nil {
				completed = s.creative(app).Completed(rec.Creative, in.Response, rec.Started, outcome)
			} else {
				r := s.review(app)
				completed = r.Completed(rec.Review, in.Response, outcome)
				r.Close()
			}
			if completed {
				s.recordOutcome(&rec, app)
				rec.scrub()
				rec.Finished = true
				rec.ResultHash = fp
				st.Tasks[id] = rec
				return nil
			}
		}
		if rec.Finished {
			return executorpolicy.ErrFenced
		}
		var memoryDenied error
		if rec.Memory != nil && (action == "complete" || action == "fail") {
			// Revocation prevents publication, but a live lease may still report
			// terminal usage. Unknown costs remain reserved after execution starts.
			if !(executorpolicy.Controller{State: s.State}).Valid("memory", "pi", t.Epoch, t.Lease) {
				return executorpolicy.ErrFenced
			}
			app, err := s.resolveTask(t)
			if err != nil {
				return err
			}
			memoryDenied = s.Memory.Check(ctx, app, *rec.Memory)
		} else if e := s.check(ctx, rec); e != nil {
			return e
		}
		switch action {
		case "started":
			if rec.Memory != nil && !rec.Started {
				app, err := s.resolveTask(t)
				if err != nil {
					return err
				}
				if err = s.Memory.Start(ctx, app, id, rec.Memory); err != nil {
					return err
				}
			}
			if rec.Review != nil {
				app, err := s.resolveTask(t)
				if err != nil {
					return err
				}
				op := "review:" + rec.Review.Run.RunID + ":" + strconv.Itoa(rec.Review.Run.Attempts)
				if err := app.MeterAuthorize(ctx, op, "review"); err != nil {
					if rec.Started {
						return err
					}
					r := s.review(app)
					completeErr := r.Complete(rec.Review, llm.Response{}, err)
					r.Close()
					if completeErr != nil {
						return completeErr
					}
					s.recordOutcome(&rec, app)
					rec.scrub()
					rec.Finished, rec.ResultHash = true, fp
					st.Tasks[id] = rec
					denied = err
					return nil
				}
			}
			if rec.Started {
				return nil
			}
			if e := (executorpolicy.Controller{State: s.State}).Guard(ctx, domain(t.Kind), "pi", t.Epoch, t.Lease, false, func() error { return nil }); e != nil {
				return e
			}
			rec.Started = true
			rec.audit("started", "")
		case "heartbeat":
			return nil
		case "complete", "fail":
			if !rec.Started && action == "complete" {
				return application.Fail(409, "TASK_NOT_STARTED", "Record execution start before model execution.")
			}
			limit := 64 * 1024
			if t.Kind == "knowledge.extract" {
				limit = knowledge.CandidateBytes
			}
			if t.Kind == "creative.organize" {
				limit = 256 * 1024
			}
			if len(in.Response.Text) > limit {
				return llm.Fail("LLM_RESPONSE_TOO_LARGE")
			}
			calls := in.Response.ModelCalls
			if calls == 0 {
				calls = 1
			}
			if !validModelCalls(t.Kind, t.Strategy, action, calls) {
				return llm.Fail("LLM_INVALID_USAGE")
			}
			if in.Response.Usage != nil && (in.Response.Usage.CachedInputTokens < 0 || in.Response.Usage.CachedInputTokens > in.Response.Usage.InputTokens || in.Response.Usage.InputTokens < 0 || in.Response.Usage.InputTokens > 1000000 || in.Response.Usage.OutputTokens < 0 || in.Response.Usage.OutputTokens > s.Config.MaxOutputTokens) {
				return llm.Fail("LLM_INVALID_USAGE")
			}
			var modelErr error
			if action == "fail" {
				if !failureAllowed(in.Failure) {
					return llm.Fail("LLM_INVALID_FAILURE")
				}
				modelErr = llm.Fail(in.Failure)
			}
			app, e := s.resolveTask(t)
			if e != nil {
				return e
			}
			if rec.Memory != nil {
				if memoryDenied != nil {
					modelErr = memoryDenied
				}
				e = s.Memory.Complete(ctx, app, id, *rec.Memory, in.Response, rec.Started, modelErr)
				if modelErr != nil {
					rec.Outcome = "failed"
				} else {
					rec.Outcome = "completed"
				}
				rec.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
			} else if rec.Knowledge != nil {
				e = s.knowledge(app).Complete(ctx, rec.Knowledge, in.Response, rec.Started, modelErr)
			} else if rec.Creative != nil {
				e = s.creative(app).Complete(ctx, rec.Creative, in.Response, rec.Started, modelErr)
			} else {
				r := s.review(app)
				e = r.Complete(rec.Review, in.Response, modelErr)
				r.Close()
			}
			if e != nil {
				return e
			}
			reason := in.Failure
			if memoryDenied != nil {
				reason = "TASK_REJECTED"
			}
			rec.audit("terminal", reason)
			s.recordOutcome(&rec, app)
			rec.scrub()
			rec.Finished = true
			rec.ResultHash = fp
		default:
			return application.Fail(404, "NOT_FOUND", "Unknown task operation.")
		}
		st.Tasks[id] = rec
		return nil
	})
	if err != nil {
		return err
	}
	return denied
}
func failureAllowed(code string) bool {
	switch code {
	case "LLM_TIMEOUT", "LLM_NETWORK_ERROR", "LLM_HTTP_ERROR", "LLM_INVALID_RESPONSE", "LLM_INCOMPLETE_OUTPUT", "LLM_RESPONSE_TOO_LARGE", "LLM_INVALID_OUTPUT", "LLM_INVALID_USAGE", "LLM_BUDGET_EXCEEDED", "LLM_REFUSED", "LLM_TOOL_OUTPUT_FORBIDDEN", "KNOWLEDGE_INTERRUPTED", "REVIEW_INTERRUPTED", "CREATIVE_INTERRUPTED", "MEMORY_INTERRUPTED", "MEMORY_SOURCE_CHANGED", "CREATIVE_CONTEXT_TOO_LARGE", "CREATIVE_NO_PLANS", "CREATIVE_SUPERSEDED", "CREATIVE_TURN_UNAVAILABLE", "CREATIVE_LEASE_LOST", "CREATIVE_UNKNOWN_JOB":
		return true
	}
	return false
}

func validModelCalls(kind, strategy, action string, calls int) bool {
	expected := 1
	if kind == "creative.plan_check" && strategy == creative.PlanStrategyReadonly {
		expected = creative.PlanCheckModelCalls
	}
	return calls >= 1 && calls <= expected && (action != "complete" || calls == expected)
}

func taskKind(kind string) string {
	if kind == "review" {
		return "review.execute"
	}
	if kind == "creative" {
		return "creative.organize"
	}
	if kind == "memory" {
		return "memory.consolidate"
	}
	return "knowledge.extract"
}
func domain(kind string) string {
	if kind == "review.execute" {
		return "review"
	}
	if kind == "creative.organize" || kind == "creative.plan_check" {
		return "creative"
	}
	if kind == "memory.consolidate" {
		return "memory"
	}
	return "knowledge"
}

// Retain only domain identity/receipt metadata after execution, never a second permanent prose archive.
func (r *Record) scrub() {
	r.Task.Request = llm.Request{}
	r.Task.Consent = nil
	if r.Knowledge != nil {
		r.Knowledge.Revision = application.StoredRevision{}
		r.Knowledge.Allowed = nil
		r.Knowledge.Request = llm.Request{}
		r.Knowledge.Claim.Snapshot = knowledge.State{}
	}
	if r.Review != nil {
		r.Review.Run.Sources = nil
	}
	if r.Creative != nil {
		r.Creative.Request = llm.Request{}
		r.Creative.Organize = nil
		r.Creative.Plan = nil
		r.Creative.Claim.Snapshot = creative.State{}
	}
	if r.Memory != nil {
		r.Memory.Request = llm.Request{}
	}
}
func (s *Service) CleanupBook(ctx context.Context, book string) error {
	return s.transaction(ctx, func(st *Registry) error {
		for id, r := range st.Tasks {
			if r.Task.Book == book {
				delete(st.Tasks, id)
			}
		}
		return nil
	})
}

func expire(st *Registry) {
	for id, rec := range st.Tasks {
		deadline, e := time.Parse(time.RFC3339Nano, rec.Task.Deadline)
		if !rec.Finished && (e != nil || !time.Now().Before(deadline)) {
			rec.Finished = true
			rec.ResultHash = "expired"
			rec.audit("terminal", "TASK_DEADLINE_EXPIRED")
			if rec.Memory != nil {
				rec.Outcome = "interrupted"
				rec.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
			}
			rec.scrub()
			st.Tasks[id] = rec
		}
	}

}
func (s *Service) Sweep(ctx context.Context) error {
	return s.transaction(ctx, func(st *Registry) error { expire(st); return nil })
}

func (s *Service) recordOutcome(r *Record, app *application.Service) {
	r.audit("terminal", "")
	if r.Knowledge != nil {
		r.Outcome, r.CompletedAt = s.knowledge(app).Outcome(r.Knowledge)
	} else if r.Creative != nil {
		r.Outcome, r.CompletedAt = s.creative(app).Outcome(r.Creative)
	} else if r.Memory != nil {
		if r.Outcome == "" {
			r.Outcome = "completed"
		}
		if r.CompletedAt == "" {
			r.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
	} else {
		review := s.review(app)
		r.Outcome, r.CompletedAt = review.Outcome(r.Review)
		review.Close()
	}
}
