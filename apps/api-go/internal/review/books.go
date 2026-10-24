package review

import (
	"context"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

type BookDiscoverer struct {
	Management Management
	Owner      application.Actor
}

type Management interface {
	List(application.Actor) ([]application.ManagedBook, error)
	Resolve(application.Actor, string) (*application.Service, error)
}

func (d BookDiscoverer) Books(ctx context.Context) ([]string, error) {
	works, e := d.Management.List(d.Owner)
	if e != nil {
		return nil, e
	}
	out := make([]string, 0, len(works))
	for _, work := range works {
		out = append(out, work.ID)
	}
	return out, nil
}
