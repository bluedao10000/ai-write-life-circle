package agentruntime

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type countingExecutor struct {
	books []string
	calls atomic.Int32
}

func (e *countingExecutor) Kind() string { return "count" }
func (e *countingExecutor) Process(context.Context, string) (bool, error) {
	e.calls.Add(1)
	return false, nil
}

type staticBooks struct{ books []string }

func (s staticBooks) Books(context.Context) ([]string, error) { return s.books, nil }

func TestRuntimeProcessesDiscoveredBooksWithoutBlocking(t *testing.T) {
	executor := &countingExecutor{}
	r := New("test", staticBooks{[]string{"book"}}, []Executor{executor}, 1, slog.New(slog.DiscardHandler))
	r.Poll = time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if e := r.Run(ctx); e != nil {
		t.Fatal(e)
	}
	if executor.calls.Load() == 0 {
		t.Fatal("executor never ran")
	}
}

type schedulingState struct {
	mu      sync.Mutex
	active  map[string]int
	seen    map[string]bool
	overlap bool
}
type fairExecutor struct {
	kind  string
	state *schedulingState
}

func (e fairExecutor) Kind() string { return e.kind }
func (e fairExecutor) Process(ctx context.Context, book string) (bool, error) {
	e.state.mu.Lock()
	e.state.active[book]++
	if e.state.active[book] > 1 {
		e.state.overlap = true
	}
	e.state.seen[book+e.kind] = true
	e.state.mu.Unlock()
	select {
	case <-ctx.Done():
	case <-time.After(3 * time.Millisecond):
	}
	e.state.mu.Lock()
	e.state.active[book]--
	e.state.mu.Unlock()
	return true, nil
}
func TestRuntimeRotatesBooksAndKindsWithoutPerBookOverlap(t *testing.T) {
	state := &schedulingState{active: map[string]int{}, seen: map[string]bool{}}
	r := New("test", staticBooks{[]string{"a", "b", "c"}}, []Executor{fairExecutor{"review", state}, fairExecutor{"knowledge", state}}, 2, nil)
	r.Poll = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	timeout := time.NewTimer(time.Second)
	defer timeout.Stop()
	for {
		select {
		case <-ticker.C:
			if allSeen(state) {
				cancel()
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				state.mu.Lock()
				defer state.mu.Unlock()
				if state.overlap {
					t.Fatal("same book ran concurrently")
				}
				return
			}
		case <-timeout.C:
			cancel()
			<-done
			t.Fatal("book/kind rotation did not complete")
		}
	}
}

func allSeen(state *schedulingState) bool {
	state.mu.Lock()
	defer state.mu.Unlock()
	return len(state.seen) == 6
}

type idleInspector struct {
	checks      int
	inspections int
}

func (e *idleInspector) Kind() string { return "idle" }
func (e *idleInspector) Process(context.Context, string) (bool, error) {
	panic("idle executor must not run")
}
func (e *idleInspector) Ready(context.Context, string) (bool, error) {
	e.checks++
	return false, nil
}
func (e *idleInspector) Inspect(context.Context, string) (Counts, error) {
	e.inspections++
	return Counts{Completed: 3, LastSuccess: "2026-10-23T08:17:13Z"}, nil
}
func TestIdleRuntimeKeepsHeartbeatsWithoutRepeatedInspection(t *testing.T) {
	e := &idleInspector{}
	r := New("test", staticBooks{[]string{"book"}}, []Executor{e}, 1, nil)
	r.Poll = time.Millisecond
	r.InspectInterval = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reports := 0
	r.Report = func(s Status) error {
		if !s.Online {
			return nil
		}
		reports++
		if s.Counts.Completed != 3 || s.LastSuccess != "2026-10-23T08:17:13Z" || s.SuccessByKind["idle"] != s.LastSuccess {
			t.Error("cached inspection lost task totals or last success")
		}
		if reports == 8 {
			cancel()
		}
		return nil
	}
	if err := r.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if reports != 8 || e.inspections != 1 || e.checks == 0 {
		t.Fatalf("idle inspection was not throttled: reports=%d inspections=%d checks=%d", reports, e.inspections, e.checks)
	}
}

type priorityBooks struct {
	staticBooks
	first map[string]bool
}

func (p priorityBooks) PriorityBooks(context.Context, []string) map[string]bool { return p.first }

type orderExecutor struct {
	mu    *sync.Mutex
	order *[]string
}

func (e orderExecutor) Kind() string { return "order" }
func (e orderExecutor) Process(ctx context.Context, book string) (bool, error) {
	e.mu.Lock()
	*e.order = append(*e.order, book)
	e.mu.Unlock()
	time.Sleep(2 * time.Millisecond)
	return true, nil
}

func TestRuntimeGivesPriorityBooksTheFirstFreeSlot(t *testing.T) {
	var mu sync.Mutex
	order := []string{}
	discover := priorityBooks{staticBooks{[]string{"a", "b", "c", "d"}}, map[string]bool{"c": true}}
	r := New("test", discover, []Executor{orderExecutor{&mu, &order}}, 1, nil)
	r.Poll = time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if e := r.Run(ctx); e != nil {
		t.Fatal(e)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(order) < 4 || order[0] != "c" {
		t.Fatalf("priority book must be claimed first: %v", order)
	}
	// Priority books go first whenever a slot frees, yet others still run.
	seen := map[string]bool{}
	for _, b := range order {
		seen[b] = true
	}
	if !seen["a"] || !seen["b"] || !seen["d"] {
		t.Fatalf("normal books starved: %v", order)
	}
}
