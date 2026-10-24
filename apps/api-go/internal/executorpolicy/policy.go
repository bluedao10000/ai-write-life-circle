// Package executorpolicy serializes executor ownership with domain lease claims.
// It stores no manuscript or model credentials. Switching is an explicit drain operation.
package executorpolicy

import (
	"context"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
	"time"
)

const Protocol = "agent-tasks-v1"

type Lease struct {
	Owner    string `json:"owner"`
	Epoch    uint64 `json:"epoch"`
	Deadline string `json:"deadline"`
	Started  bool   `json:"started"`
}
type Assignment struct {
	Owner    string           `json:"owner"`
	Epoch    uint64           `json:"epoch"`
	Draining bool             `json:"draining"`
	Leases   map[string]Lease `json:"leases"`
}
type State struct {
	Schema int                   `json:"schema"`
	Kinds  map[string]Assignment `json:"kinds"`
}
type Controller struct{ State string }

var ErrFenced = errors.New("EXECUTOR_FENCED")

func (c Controller) path() string {
	return filepath.Join(c.State, "agent-runtime", "executors-v1.json")
}
func (c Controller) Read() (State, error) {
	s := State{}
	found, e := storage.Read(c.path(), &s)
	if e != nil {
		return s, e
	}
	if !found {
		s = State{Schema: 1, Kinds: map[string]Assignment{}}
	}
	if s.Schema != 1 || s.Kinds == nil {
		return s, errors.New("invalid executor registry")
	}
	for _, kind := range []string{"review", "knowledge"} {
		if _, ok := s.Kinds[kind]; !ok {
			s.Kinds[kind] = Assignment{Owner: "go", Epoch: 1, Leases: map[string]Lease{}}
		}
	}
	for _, a := range s.Kinds {
		if (a.Owner != "go" && a.Owner != "pi" && a.Owner != "disabled") || a.Epoch < 1 || a.Leases == nil {
			return s, errors.New("invalid executor assignment")
		}
	}
	return s, nil
}
func (c Controller) update(ctx context.Context, kind string, fn func(*Assignment) error) error {
	if kind != "review" && kind != "knowledge" {
		return errors.New("invalid executor kind")
	}
	return storage.Lock(ctx, c.path()+".lock", func() error {
		s, e := c.Read()
		if e != nil {
			return e
		}
		a := s.Kinds[kind]
		if e = fn(&a); e != nil {
			return e
		}
		s.Kinds[kind] = a
		return storage.Write(ctx, c.path(), s)
	})
}
func Owner(v string) string {
	if v == "" {
		return "go"
	}
	return v
}

// Claim holds the policy lock through the short domain claim transaction. No network calls are permitted.
func (c Controller) Claim(ctx context.Context, kind, owner string, fn func(uint64) (string, string, error)) error {
	return c.update(ctx, kind, func(a *Assignment) error {
		if a.Owner != Owner(owner) || a.Draining {
			return ErrFenced
		}
		id, deadline, e := fn(a.Epoch)
		if e != nil {
			return e
		}
		if id != "" {
			a.Leases[id] = Lease{Owner: a.Owner, Epoch: a.Epoch, Deadline: deadline}
		}
		return nil
	})
}
func (c Controller) Guard(ctx context.Context, kind, owner string, epoch uint64, id string, finish bool, fn func() error) error {
	return c.update(ctx, kind, func(a *Assignment) error {
		l, ok := a.Leases[id]
		deadline, e := time.Parse(time.RFC3339Nano, l.Deadline)
		if a.Owner != Owner(owner) || a.Epoch != epoch || !ok || l.Epoch != epoch || l.Owner != Owner(owner) || e != nil || !time.Now().Before(deadline) {
			return ErrFenced
		}
		if e = fn(); e != nil {
			return e
		}
		if finish {
			delete(a.Leases, id)
		} else {
			l.Started = true
			a.Leases[id] = l
		}
		return nil
	})
}
func (c Controller) Valid(kind, owner string, epoch uint64, id string) bool {
	s, e := c.Read()
	if e != nil {
		return false
	}
	a := s.Kinds[kind]
	l, ok := a.Leases[id]
	deadline, e := time.Parse(time.RFC3339Nano, l.Deadline)
	return ok && a.Owner == Owner(owner) && a.Epoch == epoch && l.Owner == Owner(owner) && l.Epoch == epoch && e == nil && time.Now().Before(deadline)
}
func (c Controller) Drain(ctx context.Context, kind string) error {
	return c.update(ctx, kind, func(a *Assignment) error { a.Draining = true; return nil })
}

// Switch refuses live leases. An expired worker remains fenced even if it later wakes up.
func (c Controller) Switch(ctx context.Context, kind, owner string) error {
	if owner != "go" && owner != "pi" && owner != "disabled" {
		return errors.New("invalid executor owner")
	}
	return c.update(ctx, kind, func(a *Assignment) error {
		if !a.Draining {
			return errors.New("drain executor before switching")
		}
		for _, l := range a.Leases {
			deadline, e := time.Parse(time.RFC3339Nano, l.Deadline)
			if e != nil || time.Now().Before(deadline) {
				return errors.New("executor leases still active")
			}
		}
		a.Owner = owner
		a.Epoch++
		a.Draining = false
		a.Leases = map[string]Lease{}
		return nil
	})
}
