// Package agentruntime owns the worker-side scheduling loop shared by the
// Knowledge and Review executors. It holds no manuscript write authority.
package agentruntime

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"log/slog"
	"sync"
	"time"
)

// Executor processes one unit of durable work. Implementations must be
// idempotent at the commit point and safe against a stale lease.
type Executor interface {
	Kind() string
	// Process advances at most one task for the given book. It returns
	// didWork=true when a task was claimed or completed, and never blocks on
	// a model call longer than the supplied context allows.
	Process(ctx context.Context, bookID string) (didWork bool, err error)
}

type Readiness interface {
	Ready(context.Context, string) (bool, error)
}

// Prioritizer is optionally implemented by a Discoverer.
type Prioritizer interface {
	// PriorityBooks returns the books whose owners' plans get first claim on
	// free slots (Pro). Missing entries mean normal priority.
	PriorityBooks(ctx context.Context, books []string) map[string]bool
}

// Discoverer lists book IDs eligible for work. It is read-only with respect
// to author manuscripts.
type Discoverer interface {
	Books(context.Context) ([]string, error)
}

// Runtime runs a bounded set of executors against discovered books.
type Runtime struct {
	Executors []Executor
	Discover  Discoverer
	Poll      time.Duration
	Slots     int
	Logger    *slog.Logger
	version   string
	Report    func(Status) error
	Model     llm.Config
	Instance  string
	// InspectInterval bounds expensive control-plane counters independently from
	// the queue poll. Heartbeats remain frequent; task totals may be a few
	// seconds old.
	InspectInterval time.Duration
}

func New(version string, discover Discoverer, executors []Executor, slots int, logger *slog.Logger) *Runtime {
	if logger == nil {
		logger = slog.Default()
	}
	if slots < 1 {
		slots = 2
	}
	if discover == nil {
		discover = noBooks{}
	}
	return &Runtime{Executors: executors, Discover: discover, Poll: time.Second, Slots: slots, Logger: logger, version: version, InspectInterval: 5 * time.Second}
}

func (r *Runtime) Version() string { return r.version }

// Run blocks until ctx is cancelled. It stops claiming new work immediately on
// cancellation and waits for in-flight processors within the bounded shutdown
// window before returning.
func (r *Runtime) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.Poll)
	defer ticker.Stop()

	var wg sync.WaitGroup
	var mu sync.Mutex
	busy := map[string]bool{}
	active := 0
	previousByKind := map[string]Counts{}
	previousCounts := Counts{}
	previousSuccess := map[string]string{}
	nextInspect := time.Now()
	report := func(books []string, online bool) {
		mu.Lock()
		snapshot := Status{SuccessByKind: map[string]string{}, ByKind: map[string]Counts{}, Protocol: Protocol, Version: r.version, Instance: r.Instance, At: time.Now().UTC().Format(time.RFC3339Nano), Online: online, Model: r.Model.Info(), Config: r.Model.Fingerprint(), Active: active}
		mu.Unlock()
		if online && len(books) > 0 && !time.Now().Before(nextInspect) {
			previousByKind, previousCounts, previousSuccess = map[string]Counts{}, Counts{}, map[string]string{}
			for _, book := range books {
				for _, ex := range r.Executors {
					if inspector, ok := ex.(Inspector); ok {
						counts, err := inspector.Inspect(ctx, book)
						if err != nil {
							continue
						}
						if counts.LastSuccess > previousSuccess[ex.Kind()] {
							previousSuccess[ex.Kind()] = counts.LastSuccess
						}
						if counts.LastSuccess > snapshot.LastSuccess {
							snapshot.LastSuccess = counts.LastSuccess
						}
						by := previousByKind[ex.Kind()]
						by.Pending += counts.Pending
						by.Running += counts.Running
						by.Completed += counts.Completed
						by.Failed += counts.Failed
						by.Cancelled += counts.Cancelled
						by.Retried += counts.Retried
						by.Interrupted += counts.Interrupted
						previousByKind[ex.Kind()] = by
						previousCounts.Pending += counts.Pending
						previousCounts.Running += counts.Running
						previousCounts.Completed += counts.Completed
						previousCounts.Failed += counts.Failed
						previousCounts.Cancelled += counts.Cancelled
						previousCounts.Retried += counts.Retried
						previousCounts.Interrupted += counts.Interrupted
					}
				}
			}
			nextInspect = time.Now().Add(r.InspectInterval)
		}
		for kind, counts := range previousByKind {
			snapshot.ByKind[kind] = counts
			if success := previousSuccess[kind]; success > snapshot.SuccessByKind[kind] {
				snapshot.SuccessByKind[kind] = success
			}
		}
		for _, success := range previousSuccess {
			if success > snapshot.LastSuccess {
				snapshot.LastSuccess = success
			}
		}
		snapshot.Counts = previousCounts
		if r.Report != nil {
			if err := r.Report(snapshot); err != nil {
				r.Logger.Warn("worker heartbeat write failed")
			}
		}
	}
	defer func() {
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			r.Logger.Warn("agent runtime shutdown window exceeded")
		}
		report(nil, false)
	}()
	cursor := 0
	claimingScans := 0
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			books, err := r.Discover.Books(ctx)
			if err != nil {
				r.Logger.Warn("agent discovery failed")
				report(nil, true)
				continue
			}
			report(books, true)
			// Review is first in each book's initial visit. A rotating cursor
			// over book/kind pairs gives backfill a bounded scheduling turn.
			// Books on a priority plan get the first claim on free slots.
			total := len(books) * len(r.Executors)
			// Every third claiming scan ignores priority so a busy priority
			// author cannot starve everyone else.
			var priority map[string]bool
			if p, ok := r.Discover.(Prioritizer); ok && total > 0 && claimingScans%3 != 2 {
				priority = p.PriorityBooks(ctx, books)
			}
			order := compat.PriorityOrder(total, cursor, func(i int) bool { return priority[books[i/len(r.Executors)]] })
			claimed := false
			for _, i := range order {
				if ctx.Err() != nil {
					return nil
				}
				book := books[i/len(r.Executors)]
				ex := r.Executors[i%len(r.Executors)]
				mu.Lock()
				if active >= r.Slots {
					mu.Unlock()
					break
				}
				if busy[book] {
					mu.Unlock()
					continue
				}
				mu.Unlock()
				if checker, ok := ex.(Readiness); ok {
					ready, err := checker.Ready(ctx, book)
					if err != nil || !ready {
						continue
					}
				}
				mu.Lock()
				active++
				busy[book] = true
				mu.Unlock()
				claimed = true
				// Priority claims leave the rotation cursor alone, so the
				// normal rotation keeps advancing through everyone else.
				if !priority[book] {
					cursor = (i + 1) % total
				}
				// Fix this scan's starting position while preserving next tick's cursor.
				wg.Add(1)
				go func(ex Executor, id string) {
					defer wg.Done()
					_, e := ex.Process(ctx, id)
					mu.Lock()
					active--
					delete(busy, id)
					mu.Unlock()
					if e != nil && ctx.Err() == nil {
						r.Logger.Warn("agent task failed", "kind", ex.Kind())
					}
				}(ex, book)
			}
			if claimed {
				claimingScans++
			}
		}
	}
}

type noBooks struct{}

func (noBooks) Books(context.Context) ([]string, error) { return nil, nil }
