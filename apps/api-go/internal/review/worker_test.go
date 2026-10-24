package review

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

func queued(t *testing.T, s *Service, key string) Run {
	t.Helper()
	s.DisableLocalExecution = true
	return start(t, s, plan(t, s), key)
}
func expire(t *testing.T, s *Service, id string) {
	t.Helper()
	st, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	r := st.Runs[id]
	r.DeadlineAt = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	st.Runs[id] = r
	if err = storage.Write(context.Background(), s.path(), st); err != nil {
		t.Fatal(err)
	}
}
func TestWorkerQueuedDoesNotExpireAndLeasesAreFenced(t *testing.T) {
	s, _ := testService(t, nil)
	r := queued(t, s, "offline")
	expire(t, s, r.RunID)
	got, err := s.Get(context.Background(), testAuthor, r.RunID)
	if err != nil || got.Status != "queued" {
		t.Fatal(got.Status, err)
	}
	first, err := s.Claim(context.Background())
	if err != nil || first == nil {
		t.Fatal(err)
	}
	other := New(s.App, s.Config, s.Client)
	defer other.Close()
	duplicate, err := other.Claim(context.Background())
	if err != nil || duplicate != nil {
		t.Fatal("duplicate claim", err)
	}
	expire(t, s, r.RunID)
	second, err := other.Claim(context.Background())
	if err != nil || second == nil || second.Run.Lease == first.Run.Lease || second.Run.Attempts != 2 {
		t.Fatal(second, err)
	}
	if err = s.Process(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	st, _ := s.load()
	if st.Runs[r.RunID].Lease != second.Run.Lease {
		t.Fatal("old lease overwrote owner")
	}
	expire(t, s, r.RunID)
	third, err := other.Claim(context.Background())
	if err != nil || third == nil {
		t.Fatal(err)
	}
	expire(t, s, r.RunID)
	fourth, err := other.Claim(context.Background())
	if err != nil || fourth != nil {
		t.Fatal("retry not bounded", err)
	}
	got, err = s.Get(context.Background(), testAuthor, r.RunID)
	if err != nil || got.Status != "failed" {
		t.Fatal(got, err)
	}
}
func TestWorkerRejectsModelAndStrategyChangesBeforeSending(t *testing.T) {
	for _, kind := range []string{"model", "endpoint", "provider", "strategy", "context"} {
		t.Run(kind, func(t *testing.T) {
			var calls atomic.Int32
			s, _ := testService(t, func(context.Context, llm.Request) (llm.Response, error) {
				calls.Add(1)
				return llm.Response{Text: `{"findings":[]}`}, nil
			})
			r := queued(t, s, "consent")
			claimed, err := s.Claim(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "model":
				s.Config.Model = "different"
			case "endpoint":
				s.Config.BaseURL = "https://other.example/v1"
			case "provider":
				s.Config.Provider = "different"
			case "strategy":
				claimed.Run.StrategyVersion = "old"
			case "context":
				s.Config.MaxContextBytes = 1
			}
			if err = s.Process(context.Background(), claimed); err != nil {
				t.Fatal(err)
			}
			result, err := s.Get(context.Background(), testAuthor, r.RunID)
			if err != nil || result.Status != "failed" || calls.Load() != 0 {
				t.Fatal(result, calls.Load(), err)
			}
		})
	}
}
func TestWorkerCancellationAbortsModelAndPreservesTerminalState(t *testing.T) {
	entered := make(chan struct{})
	aborted := make(chan struct{})
	s, _ := testService(t, func(ctx context.Context, _ llm.Request) (llm.Response, error) {
		close(entered)
		<-ctx.Done()
		close(aborted)
		return llm.Response{}, ctx.Err()
	})
	r := queued(t, s, "cancel")
	claim, err := s.Claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Process(context.Background(), claim) }()
	<-entered
	if _, err = s.Cancel(context.Background(), testAuthor, r.RunID, "cancel-key"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-aborted:
	case <-time.After(time.Second):
		t.Fatal("model not aborted")
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(context.Background(), testAuthor, r.RunID)
	if got.Status != "cancelled" {
		t.Fatal(got.Status)
	}
}
func TestPublicWorkerFieldsAreStripped(t *testing.T) {
	s, _ := testService(t, nil)
	queued(t, s, "public")
	claim, err := s.Claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	st, _ := s.load()
	if st.Runs[claim.Run.RunID].Lease == "" {
		t.Fatal("lease not durable")
	}
	public := PublicRun(claim.Run)
	if public.Lease != "" || public.Attempts != 0 {
		t.Fatal("internal scheduling state leaked")
	}
}
