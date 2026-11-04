// Package procedural stores author-reviewed operating experience, never story canon.
package procedural

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agenttasks"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

type Record struct {
	Extractions []Extraction              `json:"extractions,omitempty"`
	ID          string                    `json:"id"`
	Content     string                    `json:"content,omitempty"`
	Status      string                    `json:"status"`
	Version     int                       `json:"version"`
	Evidence    []agenttasks.TaskEvidence `json:"provenance,omitempty"`
	CreatedAt   string                    `json:"createdAt"`
	UpdatedAt   string                    `json:"updatedAt"`
	ExpiresAt   string                    `json:"expiresAt,omitempty"`
	ReviewedBy  string                    `json:"reviewedBy,omitempty"`
}
type Extraction struct {
	SessionID            string `json:"sessionId"`
	RunID                string `json:"runId"`
	Provider             string `json:"provider"`
	Model                string `json:"model"`
	PromptVersion        string `json:"promptVersion"`
	AuthorizationVersion int    `json:"authorizationVersion"`
}
type Input struct {
	Content   string   `json:"content"`
	TaskIDs   []string `json:"taskIds"`
	ExpiresAt string   `json:"expiresAt,omitempty"`
}
type Decision struct {
	BaseVersion int    `json:"baseVersion"`
	Action      string `json:"action"`
}
type View struct {
	Record
	Available         bool   `json:"available"`
	UnavailableReason string `json:"unavailableReason,omitempty"`
}
type receipt struct {
	ID        string `json:"id"`
	Operation string `json:"operation"`
	Input     string `json:"input,omitempty"`
	Result    Record `json:"result"`
}
type state struct {
	Schema   int                `json:"schema"`
	Book     string             `json:"bookId"`
	Owner    string             `json:"authorId"`
	Records  map[string]Record  `json:"records"`
	Requests map[string]receipt `json:"requests"`
}
type Service struct {
	App                *application.Service
	Tasks              *agenttasks.Service
	Clock              func() time.Time
	ValidateExtraction func(context.Context, application.Actor, string, Extraction) error
}

func (s *Service) now() time.Time {
	if s.Clock != nil {
		return s.Clock().UTC()
	}
	return time.Now().UTC()
}
func (s *Service) path() string {
	return filepath.Join(s.App.State, "creative", compat.Key(s.App.Project), "procedural-memory-v1.json")
}
func problem(status int, code, detail string) error { return application.Fail(status, code, detail) }
func (s *Service) load(actor application.Actor) (state, error) {
	st := state{Schema: 1, Book: s.App.Project, Owner: actor.ID, Records: map[string]Record{}, Requests: map[string]receipt{}}
	found, e := storage.Read(s.path(), &st)
	if e != nil {
		return st, e
	}
	if found && (st.Schema != 1 || st.Book != s.App.Project || st.Owner != actor.ID || st.Records == nil || st.Requests == nil) {
		return st, problem(500, "MEMORY_STATE_INVALID", "Invalid procedural state.")
	}
	for id, r := range st.Records {
		if r.ID != id || r.Version < 1 || !map[string]bool{"candidate": true, "confirmed": true, "rejected": true, "deleted": true}[r.Status] {
			return st, problem(500, "MEMORY_STATE_INVALID", "Invalid procedural record.")
		}
	}
	return st, nil
}
func (s *Service) authorized(actor application.Actor) error {
	if actor.Role != "author" {
		return problem(403, "AUTHOR_DECISION_REQUIRED", "Author identity required.")
	}
	_, e := s.Tasks.Management.Resolve(actor, s.App.Project)
	return e
}
func (s *Service) mutate(ctx context.Context, actor application.Actor, key, op string, input any, change func(*state) (Record, error)) (Record, error) {
	var out Record
	if e := s.authorized(actor); e != nil {
		return out, e
	}
	if !application.SafeKey(key) {
		return out, problem(422, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key required.")
	}
	raw, e := json.Marshal(input)
	if e != nil {
		return out, e
	}
	e = s.App.StateLock(ctx, s.path()+".lock", func() error {
		st, e := s.load(actor)
		if e != nil {
			return e
		}
		if prior, ok := st.Requests[key]; ok {
			if st.Records[prior.ID].Status == "deleted" && op != "delete" {
				return problem(410, "MEMORY_DELETED", "Memory was deleted.")
			}
			if prior.Operation != op || prior.Input != string(raw) {
				return problem(422, "IDEMPOTENCY_KEY_REUSED", "Key reused for a different operation.")
			}
			out = prior.Result
			return nil
		}
		if len(st.Requests) >= 10000 {
			return problem(429, "MEMORY_STORAGE_LIMIT", "Memory request limit reached.")
		}
		out, e = change(&st)
		if e != nil {
			return e
		}
		st.Records[out.ID] = out
		if out.Status == "deleted" {
			for k, r := range st.Requests {
				if r.ID == out.ID {
					r.Input = ""
					r.Result = out
					st.Requests[k] = r
				}
			}
		}
		st.Requests[key] = receipt{out.ID, op, string(raw), out}
		encoded, e := compat.Marshal(st, true)
		if e != nil {
			return e
		}
		if len(encoded) > 8*1024*1024 {
			return problem(429, "MEMORY_STORAGE_LIMIT", "Procedural storage budget exceeded.")
		}
		return s.App.CommitBookState(ctx, func() error { return storage.Write(ctx, s.path(), st) })
	})
	return out, e
}
func (s *Service) Create(ctx context.Context, actor application.Actor, key string, in Input) (Record, error) {
	return s.create(ctx, actor, key, in, nil)
}
func (s *Service) CreateExtracted(ctx context.Context, actor application.Actor, key string, in Input, extraction Extraction) (Record, error) {
	return s.create(ctx, actor, key, in, &extraction)
}
func (s *Service) create(ctx context.Context, actor application.Actor, key string, in Input, extraction *Extraction) (Record, error) {
	var identity any = in
	if extraction != nil {
		identity = struct {
			Input
			Extraction *Extraction
		}{in, extraction}
	}
	return s.mutate(ctx, actor, key, "create", identity, func(st *state) (Record, error) {
		content := strings.TrimSpace(in.Content)
		if len(content) == 0 || len(content) > 4000 || len(st.Records) >= 1000 {
			return Record{}, problem(422, "INVALID_MEMORY", "Content or record limit exceeded.")
		}
		evidence, e := s.Tasks.Evidence(ctx, actor, s.App.Project, in.TaskIDs)
		if e != nil {
			return Record{}, e
		}
		now := s.now()
		expires := now.Add(30 * 24 * time.Hour)
		if in.ExpiresAt != "" {
			expires, e = time.Parse(time.RFC3339, in.ExpiresAt)
			if e != nil || !expires.After(now) || expires.After(now.Add(90*24*time.Hour)) {
				return Record{}, problem(422, "INVALID_MEMORY_EXPIRY", "Expiry must be within 90 days.")
			}
		}
		stamp := now.Format(time.RFC3339Nano)
		origins := []Extraction(nil)
		if extraction != nil {
			origins = []Extraction{*extraction}
		}
		return Record{Extractions: origins, ID: "pm-" + compat.UUID(), Content: content, Status: "candidate", Version: 1, Evidence: evidence, CreatedAt: stamp, UpdatedAt: stamp, ExpiresAt: expires.UTC().Format(time.RFC3339Nano)}, nil
	})
}
func ids(r Record) []string {
	out := []string{}
	for _, e := range r.Evidence {
		out = append(out, e.TaskID)
	}
	return out
}
func independent(evidence []agenttasks.TaskEvidence) bool {
	if len(evidence) < 2 {
		return false
	}
	seen := map[string]bool{}
	for _, e := range evidence {
		if e.Kind != evidence[0].Kind || e.Strategy != evidence[0].Strategy || seen[e.InputHash] {
			return false
		}
		seen[e.InputHash] = true
	}
	return true
}
func (s *Service) Decide(ctx context.Context, actor application.Actor, key, id string, in Decision) (Record, error) {
	return s.mutate(ctx, actor, key, in.Action, struct {
		ID string
		Decision
	}{id, in}, func(st *state) (Record, error) {
		r, ok := st.Records[id]
		if !ok {
			return Record{}, problem(404, "NOT_FOUND", "Memory not found.")
		}
		if r.Status == "deleted" {
			return Record{}, problem(410, "MEMORY_DELETED", "Memory was deleted.")
		}
		if r.Version != in.BaseVersion {
			return Record{}, problem(409, "MEMORY_VERSION_CONFLICT", "Read the current memory before deciding.")
		}
		switch in.Action {
		case "confirm":
			if e := s.validateExtractions(ctx, actor, r); e != nil {
				return Record{}, e
			}
			if r.Status != "candidate" {
				return Record{}, problem(409, "MEMORY_NOT_PENDING", "Only a candidate can be confirmed.")
			}
			expiry, e := time.Parse(time.RFC3339Nano, r.ExpiresAt)
			if e != nil || !expiry.After(s.now()) {
				return Record{}, problem(409, "MEMORY_EXPIRED", "Candidate expired.")
			}
			evidence, e := s.Tasks.Evidence(ctx, actor, s.App.Project, ids(r))
			if e != nil {
				return Record{}, e
			}
			if !independent(evidence) {
				return Record{}, problem(422, "MEMORY_EVIDENCE_INSUFFICIENT", "Two independent successful inputs with the same execution strategy are required.")
			}
			r.Evidence = evidence
			r.Status = "confirmed"
			r.ReviewedBy = actor.ID
		case "reject":
			if r.Status != "candidate" && r.Status != "confirmed" {
				return Record{}, problem(409, "MEMORY_NOT_PENDING", "Memory is already rejected.")
			}
			r.Status = "rejected"
			r.ReviewedBy = actor.ID
		case "delete":
			r.Extractions = nil
			r.Content = ""
			r.Evidence = nil
			r.ExpiresAt = ""
			r.ReviewedBy = ""
			r.Status = "deleted"
		default:
			return Record{}, problem(422, "INVALID_MEMORY_DECISION", "Choose confirm, reject or delete.")
		}
		r.Version++
		r.UpdatedAt = s.now().Format(time.RFC3339Nano)
		return r, nil
	})
}
func (s *Service) List(ctx context.Context, actor application.Actor) ([]View, error) {
	if e := s.authorized(actor); e != nil {
		return nil, e
	}
	st, e := s.load(actor)
	if e != nil {
		return nil, e
	}
	out := []View{}
	snapshot, e := s.Tasks.MemoryEvidence(ctx, actor, s.App.Project)
	if e != nil {
		return nil, e
	}
	for _, r := range st.Records {
		if r.Status == "deleted" {
			continue
		}
		v := View{Record: r}
		expiry, e := time.Parse(time.RFC3339Nano, r.ExpiresAt)
		if e != nil || !expiry.After(s.now()) {
			v.UnavailableReason = "expired"
		} else if err := s.validateExtractions(ctx, actor, r); err != nil {
			if application.AsError(err).Status >= 500 {
				return nil, err
			}
			v.UnavailableReason = "source_unavailable"
		} else if r.Status != "confirmed" {
			v.UnavailableReason = "not_confirmed"
		} else {
			evidence, e := snapshot.Lookup(ids(r))
			if e != nil {
				a := application.AsError(e)
				if a.Status >= 500 {
					return nil, e
				}
				v.UnavailableReason = "source_unavailable"
			} else if !independent(evidence) {
				v.UnavailableReason = "source_unavailable"
			} else {
				v.Available = true
			}
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt != out[j].UpdatedAt {
			return out[i].UpdatedAt > out[j].UpdatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (s *Service) validateExtractions(ctx context.Context, actor application.Actor, r Record) error {
	for _, origin := range r.Extractions {
		if s.ValidateExtraction == nil {
			return problem(503, "MEMORY_UNAVAILABLE", "Extraction validation unavailable.")
		}
		if e := s.ValidateExtraction(ctx, actor, s.App.Project, origin); e != nil {
			return e
		}
	}
	return nil
}
