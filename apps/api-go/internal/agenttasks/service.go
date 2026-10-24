// Package agenttasks exposes bounded, leased AI task snapshots; all domain writes remain in Go.
package agenttasks

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
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
	Outcome     string                 `json:"outcome,omitempty"`
	CompletedAt string                 `json:"completedAt,omitempty"`
	Task        Task                   `json:"task"`
	Instance    string                 `json:"instance"`
	Started     bool                   `json:"started"`
	Finished    bool                   `json:"finished"`
	ResultHash  string                 `json:"resultHash,omitempty"`
	Knowledge   *knowledge.PreparedJob `json:"knowledge,omitempty"`
	Review      *review.ClaimedRun     `json:"review,omitempty"`
}
type Registry struct {
	Schema int               `json:"schema"`
	Tasks  map[string]Record `json:"tasks"`
	Cursor int               `json:"cursor"`
}
type Service struct {
	Management *application.Management
	Actor      application.Actor
	State      string
	Config     llm.Config
	Token      string
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
		if id != r.Task.ID || r.Task.Book == "" || (r.Task.Kind != "review.execute" && r.Task.Kind != "knowledge.extract") || (r.Task.Kind == "review.execute" && r.Review == nil) || (r.Task.Kind == "knowledge.extract" && r.Knowledge == nil) {
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
	r.DisableLocalExecution = true
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
func (s *Service) Claim(ctx context.Context, instance, config string, kinds ...string) (*Task, error) {
	if s.Config.ValidatePublic() != nil {
		return nil, application.Fail(503, "LLM_NOT_CONFIGURED", "Task execution configuration is unavailable.")
	}
	if len(instance) < 1 || len(instance) > 128 || config != s.Config.Fingerprint() {
		return nil, application.Fail(409, "AGENT_CONFIG_CHANGED", "Worker capability must match before claiming a source snapshot.")
	}
	books, e := s.Management.List(s.Actor)
	if e != nil {
		return nil, e
	}
	// Fair rotation over book/kind pairs. Review is first, historical work gets a bounded turn.
	var out *Task
	e = s.transaction(ctx, func(st *Registry) error {
		expire(st)
		total := len(books) * 2
		if total == 0 {
			return nil
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
		start := st.Cursor % total
		policy, e := (executorpolicy.Controller{State: s.State}).Read()
		if e != nil {
			return e
		}
		for n := 0; n < total; n++ {
			i := (start + n) % total
			kind := []string{"review", "knowledge"}[i%2]
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
			app, e := s.Management.Resolve(s.Actor, books[i/2].ID)
			if e != nil {
				continue
			}
			rec := Record{Instance: instance}
			task := Task{ID: compat.UUID(), Kind: taskKind(kind), Book: app.Project, Author: s.Actor.ID, Model: s.Config.Info(), Config: s.Config.Fingerprint(), OutputSchema: kind + "-candidates-v1"}
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
				task.Reserved = s.Config.MaxContextBytes + 20000 + s.Config.MaxOutputTokens
				task.Consent = run.Plan
				task.Request = request
				rec.Review = claim
			} else {
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
			}
			raw, _ := json.Marshal(task.Request)
			task.InputHash = compat.Hash(string(raw))
			rec.Task = task
			st.Tasks[task.ID] = rec
			st.Cursor = (i + 1) % total
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
	app, e := s.Management.Resolve(s.Actor, t.Book)
	if e != nil {
		return e
	}
	if rec.Knowledge != nil {
		return s.knowledge(app).Check(ctx, rec.Knowledge)
	}
	r := s.review(app)
	defer r.Close()
	return r.Check(ctx, rec.Review)
}
func (s *Service) Action(ctx context.Context, id, action string, in Envelope) error {
	return s.transaction(ctx, func(st *Registry) error {
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
			app, e := s.Management.Resolve(s.Actor, t.Book)
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
			if rec.Knowledge != nil {
				completed = s.knowledge(app).Completed(rec.Knowledge, in.Response, rec.Started, outcome)
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
		if e := s.check(ctx, rec); e != nil {
			return e
		}
		switch action {
		case "started":
			if rec.Started {
				return nil
			}
			if e := (executorpolicy.Controller{State: s.State}).Guard(ctx, domain(t.Kind), "pi", t.Epoch, t.Lease, false, func() error { return nil }); e != nil {
				return e
			}
			rec.Started = true
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
			if len(in.Response.Text) > limit {
				return llm.Fail("LLM_RESPONSE_TOO_LARGE")
			}
			if in.Response.Usage != nil && (in.Response.Usage.InputTokens < 0 || in.Response.Usage.InputTokens > 1000000 || in.Response.Usage.OutputTokens < 0 || in.Response.Usage.OutputTokens > s.Config.MaxOutputTokens) {
				return llm.Fail("LLM_INVALID_USAGE")
			}
			var modelErr error
			if action == "fail" {
				if !failureAllowed(in.Failure) {
					return llm.Fail("LLM_INVALID_FAILURE")
				}
				modelErr = llm.Fail(in.Failure)
			}
			app, e := s.Management.Resolve(s.Actor, t.Book)
			if e != nil {
				return e
			}
			if rec.Knowledge != nil {
				e = s.knowledge(app).Complete(ctx, rec.Knowledge, in.Response, rec.Started, modelErr)
			} else {
				r := s.review(app)
				e = r.Complete(rec.Review, in.Response, modelErr)
				r.Close()
			}
			if e != nil {
				return e
			}
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
}
func failureAllowed(code string) bool {
	switch code {
	case "LLM_TIMEOUT", "LLM_NETWORK_ERROR", "LLM_HTTP_ERROR", "LLM_INVALID_RESPONSE", "LLM_INCOMPLETE_OUTPUT", "LLM_RESPONSE_TOO_LARGE", "LLM_INVALID_OUTPUT", "LLM_REFUSED", "LLM_TOOL_OUTPUT_FORBIDDEN", "KNOWLEDGE_INTERRUPTED", "REVIEW_INTERRUPTED":
		return true
	}
	return false
}

func taskKind(kind string) string {
	if kind == "review" {
		return "review.execute"
	}
	return "knowledge.extract"
}
func domain(kind string) string {
	if kind == "review.execute" {
		return "review"
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
			rec.scrub()
			st.Tasks[id] = rec
		}
	}

}
func (s *Service) Sweep(ctx context.Context) error {
	return s.transaction(ctx, func(st *Registry) error { expire(st); return nil })
}

func (s *Service) recordOutcome(r *Record, app *application.Service) {
	if r.Knowledge != nil {
		r.Outcome, r.CompletedAt = s.knowledge(app).Outcome(r.Knowledge)
	} else {
		review := s.review(app)
		r.Outcome, r.CompletedAt = review.Outcome(r.Review)
		review.Close()
	}
}
