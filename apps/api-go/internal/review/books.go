package review

import (
	"context"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

// BookDiscoverer lists every author's books for the background executor.
// Each job is later resolved as the book's own author (see ResolveOwned).
type BookDiscoverer struct {
	Management Management
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
