package knowledge

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"sync"
	"time"
)

// Manager discovers consented books on startup and polls durable saved heads. It has
// two global model slots and one worker per book, with no goroutine per chapter.
type Manager struct {
	Management *application.Management
	Owner      application.Actor
	Config     llm.Config
	Client     llm.Client
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

func (m *Manager) For(app *application.Service) *Service {
	s := New(app, m.Config, m.Client)
	s.QuietPeriod = 2 * time.Second
	return s
}
func (m *Manager) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		slots := make(chan struct{}, 2)
		var mu sync.Mutex
		busy := map[string]bool{}
		rotation := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				books, e := m.Management.List(m.Owner)
				if e != nil {
					continue
				}
				if len(books) == 0 {
					continue
				}
				rotation = (rotation + 1) % len(books)
				for index := range books {
					b := books[(index+rotation)%len(books)]

					mu.Lock()
					occupied := busy[b.ID]
					mu.Unlock()
					if occupied {
						continue
					}
					app, e := m.Management.Resolve(m.Owner, b.ID)
					if e != nil {
						continue
					}
					s := m.For(app)
					st, e := s.load()
					if e != nil || !st.Settings.Enabled || st.Settings.Paused {
						continue
					}
					// Poll durable heads without occupying a model slot. Completed
					// books must not starve newly enabled books later in the registry.
					if s.sync(ctx) != nil {
						continue
					}
					st, e = s.load()
					if e != nil {
						continue
					}
					ready := false
					now := time.Now().UTC()
					for _, job := range st.Jobs {
						due, _ := time.Parse(time.RFC3339Nano, job.Due)
						deadline, _ := time.Parse(time.RFC3339Nano, job.Deadline)
						if (job.Status == "pending" || job.Status == "retry") && !now.Before(due) || job.Status == "running" && now.After(deadline) {
							ready = true
						}
					}
					reserve := s.reserve()
					if st.BudgetDay == now.Format("2006-01-02") && (st.BudgetTokens+reserve > st.Settings.DailyTokenBudget || st.BudgetAttempts >= st.Settings.DailyJobBudget) {
						continue
					}
					if !ready {
						continue
					}
					select {
					case slots <- struct{}{}:
					default:
						continue
					}
					mu.Lock()
					busy[b.ID] = true
					mu.Unlock()
					m.wg.Add(1)
					go func(id string) {
						defer m.wg.Done()
						defer func() { <-slots; mu.Lock(); delete(busy, id); mu.Unlock() }()
						_ = s.ProcessOne(ctx)
					}(b.ID)
				}
			}
		}
	}()
}
func (m *Manager) Close() {
	if m.cancel != nil {
		m.cancel()
	}
	m.wg.Wait()
}

// Executor adapts the durable knowledge scheduler to the shared Agent Runtime.
type Executor struct {
	Config    llm.Config
	Client    llm.Client
	Resolve   func(bookID string) (*application.Service, error)
	controlMu sync.Mutex
	control   *controlSnapshot
}

func (x *Executor) Kind() string { return "knowledge" }

func (x *Executor) Process(ctx context.Context, bookID string) (bool, error) {
	app, e := x.Resolve(bookID)
	if e != nil {
		return false, e
	}
	return New(app, x.Config, x.Client).processOne(ctx)
}
