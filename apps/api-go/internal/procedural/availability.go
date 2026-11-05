package procedural

import (
	"context"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agenttasks"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

type availabilityResolver struct {
	service  *Service
	ctx      context.Context
	actor    application.Actor
	state    state
	snapshot agenttasks.EvidenceSnapshot
	now      time.Time
	cache    map[string]*availabilityEntry
}

type availabilityEntry struct {
	view     View
	ready    bool
	visiting bool
	cause    error
}

func newAvailabilityResolver(ctx context.Context, service *Service, actor application.Actor, st state, snapshot agenttasks.EvidenceSnapshot) *availabilityResolver {
	return &availabilityResolver{
		service: service, ctx: ctx, actor: actor, state: st, snapshot: snapshot,
		now: service.now(), cache: map[string]*availabilityEntry{},
	}
}

func (r *availabilityResolver) evaluate(id string) (View, error) {
	if entry, ok := r.cache[id]; ok {
		if entry.ready || entry.visiting {
			if entry.visiting {
				return View{Record: r.state.Records[id], UnavailableReason: "source_unavailable"}, nil
			}
			return entry.view, nil
		}
	}
	record, ok := r.state.Records[id]
	if !ok || record.Status == "deleted" {
		return View{Record: record, UnavailableReason: "source_unavailable"}, nil
	}
	entry := &availabilityEntry{view: View{Record: record}, visiting: true}
	r.cache[id] = entry
	finish := func() (View, error) {
		entry.visiting = false
		entry.ready = true
		return entry.view, nil
	}

	expiry, err := time.Parse(time.RFC3339Nano, record.ExpiresAt)
	switch {
	case record.SupersededBy != "":
		entry.view.UnavailableReason = "superseded"
	case err != nil || !expiry.After(r.now):
		entry.view.UnavailableReason = "expired"
	default:
		if e := r.validateOrigins(record); e != nil {
			if application.AsError(e).Status >= 500 {
				return View{}, e
			}
			entry.cause = e
			entry.view.UnavailableReason = "source_unavailable"
			break
		}
		if record.Status != "confirmed" {
			entry.view.UnavailableReason = "not_confirmed"
			break
		}
		evidence, e := r.snapshot.Lookup(ids(record))
		if e != nil {
			if application.AsError(e).Status >= 500 {
				return View{}, e
			}
			entry.cause = e
			entry.view.UnavailableReason = "source_unavailable"
			break
		}
		if !independent(evidence) {
			entry.view.UnavailableReason = "source_unavailable"
			break
		}
		entry.view.Available = true
	}
	return finish()
}

func (r *availabilityResolver) validateOrigins(record Record) error {
	for _, origin := range record.Extractions {
		if r.service.ValidateExtraction == nil {
			return problem(503, "MEMORY_UNAVAILABLE", "Extraction validation unavailable.")
		}
		if err := r.service.ValidateExtraction(r.ctx, r.actor, r.service.App.Project, origin); err != nil {
			return err
		}
		for _, relation := range origin.Relations {
			target, ok := r.state.Records[relation.MemoryID]
			if !ok || target.Version != relation.MemoryVersion || relation.MemoryID == record.ID {
				return problem(409, "MEMORY_SOURCE_CHANGED", "A compared experience changed.")
			}
			view, err := r.evaluate(relation.MemoryID)
			if err != nil {
				return err
			}
			if !view.Available || view.Content == "" {
				return problem(409, "MEMORY_SOURCE_CHANGED", "A compared experience changed.")
			}
		}
	}
	return nil
}
