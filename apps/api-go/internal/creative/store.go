package creative

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

// Service is constructed per resolved book. Client is nil in the API process;
// only the Agent Worker holds a model credential.
type Service struct {
	App    *application.Service
	Config llm.Config
	Client llm.Client
	// Clock is replaceable in tests.
	Clock func() time.Time
}

func New(app *application.Service, c llm.Config, client llm.Client) *Service {
	return &Service{App: app, Config: c, Client: client}
}

func (s *Service) now() time.Time {
	if s.Clock != nil {
		return s.Clock().UTC()
	}
	return time.Now().UTC()
}
func (s *Service) stamp() string { return s.now().Format("2006-01-02T15:04:05.000Z") }

func newID() string { return compat.UUID() }

func (s *Service) path() string {
	return filepath.Join(s.App.State, "creative", compat.Key(s.App.Project), "state-v1.json")
}

func empty(book string) State {
	return State{
		BookID: book, SchemaVersion: SchemaVersion,
		Settings:    Settings{DailyTokenBudget: 2000000, DailyJobBudget: 200, AutoOrganize: true},
		Assets:      map[string]Asset{},
		Versions:    map[string][]Version{},
		Links:       map[string]Link{},
		Proposals:   map[string]Proposal{},
		ChangeSets:  map[string]ChangeSet{},
		Turns:       map[string]Turn{},
		Jobs:        []Job{},
		Divergences: map[string]Divergence{},
		Requests:    map[string]receipt{},
	}
}

func invalid(detail string) error {
	return application.Fail(500, "CREATIVE_STORAGE_INVALID", detail)
}

func (s *Service) load() (State, error) {
	st := State{}
	found, e := storage.Read(s.path(), &st)
	if e != nil {
		return st, e
	}
	if !found {
		return empty(s.App.Project), nil
	}
	if st.BookID != s.App.Project || st.SchemaVersion != SchemaVersion || st.Version < 0 {
		return st, invalid("Creative state does not belong to this book.")
	}
	if st.Assets == nil || st.Versions == nil || st.Links == nil || st.Proposals == nil || st.ChangeSets == nil || st.Turns == nil || st.Divergences == nil || st.Requests == nil {
		return st, invalid("Creative state is incomplete.")
	}
	if st.Jobs == nil {
		st.Jobs = []Job{}
	}
	for id, a := range st.Assets {
		if id != a.ID || a.BookID != st.BookID || Kinds[a.Kind] == "" || !AssetStatuses[a.Status] || a.Version < 1 {
			return st, invalid("Invalid creative asset.")
		}
	}
	for id, l := range st.Links {
		if id != l.ID {
			return st, invalid("Invalid link.")
		}
		if _, ok := st.Assets[l.From]; !ok {
			return st, invalid("Link references a missing asset.")
		}
		if l.To.Type == "asset" {
			if _, ok := st.Assets[l.To.ID]; !ok {
				return st, invalid("Link references a missing asset.")
			}
		}
	}
	for id, p := range st.Proposals {
		if id != p.ID || p.BookID != st.BookID || !Operations[p.Operation] || !Stances[p.Stance] || p.Source.Type != "conversation" {
			return st, invalid("Invalid proposal.")
		}
	}
	return st, nil
}

// transaction serialises every creative write for the book. Commits pass the
// book-deletion fence so late workers cannot resurrect deleted books.
func (s *Service) transaction(ctx context.Context, fn func(*State) (bool, error)) error {
	return s.App.StateLock(ctx, s.path()+".lock", func() error {
		st, e := s.load()
		if e != nil {
			return e
		}
		changed, e := fn(&st)
		if e != nil {
			return e
		}
		if !changed {
			return nil
		}
		st.Version++
		return s.App.CommitBookState(ctx, func() error { return storage.Write(ctx, s.path(), st) })
	})
}

// idempotent runs fn once per (key, fingerprint) and replays the stored result.
func (s *Service) idempotent(ctx context.Context, a application.Actor, op, key string, input any, out any, fn func(*State) error) error {
	if a.Role != "author" {
		return application.Fail(403, "AUTHOR_DECISION_REQUIRED", "Only the owning author may change creative assets.")
	}
	if !application.SafeKey(key) {
		return application.Fail(422, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key required.")
	}
	raw, _ := json.Marshal([]any{a.ID, op, input})
	fp := compat.Hash(string(raw))
	rk := compat.Hash(a.ID + "\x00" + key)
	return s.transaction(ctx, func(st *State) (bool, error) {
		if prior, ok := st.Requests[rk]; ok {
			if prior.Fingerprint != fp {
				return false, application.Fail(422, "IDEMPOTENCY_KEY_REUSED", "Key reused for a different operation.")
			}
			if out != nil && len(prior.Result) > 0 {
				return false, json.Unmarshal([]byte(prior.Result), out)
			}
			return false, nil
		}
		if len(st.Requests) >= 20000 {
			return false, application.Fail(429, "CREATIVE_REQUEST_LIMIT", "Creative request history is full.")
		}
		if e := rateLimit(st, s.now()); e != nil {
			return false, e
		}
		// Work on a copy: a failed operation must not leave partial changes.
		next := clone(*st)
		if e := fn(&next); e != nil {
			return false, e
		}
		result := ""
		if out != nil {
			b, _ := json.Marshal(out)
			result = string(b)
		}
		next.Requests[rk] = receipt{Fingerprint: fp, Result: result}
		*st = next
		return true, nil
	})
}

func rateLimit(st *State, now time.Time) error {
	recent := []string{}
	for _, at := range st.MutationTimes {
		t, e := time.Parse(time.RFC3339Nano, at)
		if e == nil && now.Sub(t) < time.Minute {
			recent = append(recent, at)
		}
	}
	if len(recent) >= 60 {
		return application.Fail(429, "CREATIVE_RATE_LIMIT", "Too many creative actions. Try again shortly.")
	}
	st.MutationTimes = append(recent, now.Format(time.RFC3339Nano))
	return nil
}

func clone(st State) State {
	b, _ := json.Marshal(st)
	var out State
	_ = json.Unmarshal(b, &out)
	if out.Jobs == nil {
		out.Jobs = []Job{}
	}
	return out
}

// Decode is a strict single-object JSON decoder for author inputs.
func Decode(data []byte, v any) error {
	if !json.Valid(data) || strings.TrimSpace(string(data)) == "null" {
		return application.Fail(422, "VALIDATION_FAILED", "A JSON object is required.")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		return application.Fail(422, "VALIDATION_FAILED", "Request does not match the creative asset contract.")
	}
	if d.Decode(new(any)) != io.EOF {
		return application.Fail(422, "VALIDATION_FAILED", "Exactly one JSON object is required.")
	}
	return nil
}
