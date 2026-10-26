package review

import (
	"context"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

// BookDiscoverer lists every author's books for the background executor.
// Each job is later resolved as the book's own author (see ResolveOwned).
type BookDiscoverer struct {
	Management Management
	// Priority reports whether an owner's plan gets priority background
	// work; nil means every book has normal priority.
	Priority func(ctx context.Context, owner string) bool
}

type Management interface {
	OwnedBooks() ([]application.OwnedBook, error)
}

func (d BookDiscoverer) Books(ctx context.Context) ([]string, error) {
	works, e := d.Management.OwnedBooks()
	if e != nil {
		return nil, e
	}
	out := make([]string, 0, len(works))
	for _, work := range works {
		out = append(out, work.Book.ID)
	}
	return out, nil
}

// PriorityBooks implements agentruntime.Prioritizer.
func (d BookDiscoverer) PriorityBooks(ctx context.Context, books []string) map[string]bool {
	if d.Priority == nil {
		return nil
	}
	works, e := d.Management.OwnedBooks()
	if e != nil {
		return nil
	}
	wanted := make(map[string]bool, len(books))
	for _, id := range books {
		wanted[id] = true
	}
	out := map[string]bool{}
	owners := map[string]bool{}
	for _, work := range works {
		if !wanted[work.Book.ID] {
			continue
		}
		owner := work.Owner.ID
		priority, seen := owners[owner]
		if !seen {
			priority = d.Priority(ctx, owner)
			owners[owner] = priority
		}
		if priority {
			out[work.Book.ID] = true
		}
	}
	return out
}
