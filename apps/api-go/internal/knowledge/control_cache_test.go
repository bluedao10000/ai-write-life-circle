package knowledge

import (
	"context"
	"os"
	"sync"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

func TestControlCacheTracksAtomicChangesAndKeepsNoProse(t *testing.T) {
	s, _, b, c := setup(t)
	save(t, s, b.Chapters[0].ID, "林舟来自北港。")
	enable(t, s)
	if err := s.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	x := &Executor{Config: s.Config, Client: c, Resolve: func(string) (*application.Service, error) { return s.App, nil }}
	if ready, err := x.Ready(context.Background(), s.App.Project); err != nil || !ready {
		t.Fatal("initial job not ready", err)
	}
	cached := x.control
	if cached == nil || cached.state.Entities != nil || cached.state.Assertions != nil || cached.state.Requests != nil {
		t.Fatal("control cache retained knowledge content or was not populated")
	}
	if _, err := x.Inspect(context.Background(), s.App.Project); err != nil {
		t.Fatal(err)
	}
	if x.control != cached {
		t.Fatal("unchanged state reloaded")
	}
	st, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, "pause", "pause-control", Mutation{BaseVersion: st.Version})
	if err != nil {
		t.Fatal(err)
	}
	if ready, err := x.Ready(context.Background(), s.App.Project); err != nil || ready {
		t.Fatal("cached state ignored pause", err)
	}
	if x.control == cached {
		t.Fatal("atomic update did not invalidate cache")
	}
	// Same-size, same-mtime replacements must invalidate by inode too.
	info, err := os.Stat(s.path())
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(s.path())
	if err != nil {
		t.Fatal(err)
	}
	data[0] = '!'
	temp := s.path() + ".replacement"
	if err := os.WriteFile(temp, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(temp, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temp, s.path()); err != nil {
		t.Fatal(err)
	}
	if _, err := x.Inspect(context.Background(), s.App.Project); err == nil {
		t.Fatal("cached valid state hid invalid replacement")
	}
}

func TestControlCacheConcurrentReaders(t *testing.T) {
	s, _, b, c := setup(t)
	save(t, s, b.Chapters[0].ID, "林舟来自北港。")
	enable(t, s)
	if err := s.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	x := &Executor{Config: s.Config, Client: c, Resolve: func(string) (*application.Service, error) { return s.App, nil }}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 5 {
				if _, err := x.Inspect(context.Background(), s.App.Project); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
}
