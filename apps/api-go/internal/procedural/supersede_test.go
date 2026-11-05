package procedural

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

func confirmedRule(t *testing.T, s *Service, actor application.Actor, key, content string) Record {
	t.Helper()
	ctx := context.Background()
	r, e := s.Create(ctx, actor, "create-"+key, Input{Content: content, TaskIDs: []string{"task-a", "task-b"}})
	if e != nil {
		t.Fatal(e)
	}
	r, e = s.Decide(ctx, actor, "confirm-"+key, r.ID, Decision{BaseVersion: r.Version, Action: "confirm"})
	if e != nil {
		t.Fatal(e)
	}
	return r
}

func TestSupersedeConfirmsReplacementAndPreservesHistory(t *testing.T) {
	s, actor := fixture(t)
	ctx := context.Background()
	old := confirmedRule(t, s, actor, "old", "先按人物出场顺序核对背景。")
	replacement, e := s.Create(ctx, actor, "create-new", Input{Content: "先核对当前修订，再按人物关系整理背景。", TaskIDs: []string{"task-a", "task-b"}})
	if e != nil {
		t.Fatal(e)
	}
	in := SupersedeInput{BaseVersion: replacement.Version, Replaces: []ReplaceSource{{ID: old.ID, BaseVersion: old.Version}}}
	updated, e := s.Supersede(ctx, actor, "replace-old", replacement.ID, in)
	if e != nil {
		t.Fatal(e)
	}
	if updated.Status != "confirmed" || updated.Version != 2 || len(updated.Supersedes) != 1 || updated.Supersedes[0] != old.ID {
		t.Fatalf("unexpected replacement: %+v", updated)
	}

	restarted := &Service{App: s.App, Tasks: s.Tasks, Clock: s.Clock}
	views, e := restarted.List(ctx, actor)
	if e != nil {
		t.Fatal(e)
	}
	var oldView, newView *View
	for i := range views {
		switch views[i].ID {
		case old.ID:
			oldView = &views[i]
		case replacement.ID:
			newView = &views[i]
		}
	}
	if oldView == nil || oldView.Status != "rejected" || oldView.Version != 3 || oldView.SupersededBy != replacement.ID || oldView.Available || oldView.UnavailableReason != "superseded" {
		t.Fatalf("unexpected old view: %+v", oldView)
	}
	if newView == nil || !newView.Available || newView.Content != replacement.Content {
		t.Fatalf("unexpected replacement view: %+v", newView)
	}
	replay, e := restarted.Supersede(ctx, actor, "replace-old", replacement.ID, in)
	if e != nil || replay.Version != updated.Version || replay.SupersededBy != "" {
		t.Fatal(replay, e)
	}

	raw, e := os.ReadFile(s.path())
	if e != nil {
		t.Fatal(e)
	}
	var legacy struct {
		Schema  int `json:"schema"`
		Records map[string]struct {
			Status  string `json:"status"`
			Version int    `json:"version"`
		} `json:"records"`
	}
	if e = json.Unmarshal(raw, &legacy); e != nil || legacy.Schema != 1 || legacy.Records[old.ID].Status != "rejected" || legacy.Records[replacement.ID].Status != "confirmed" {
		t.Fatal("new history is not readable with the original schema/status contract", e)
	}

	if _, e = restarted.Decide(ctx, actor, "delete-new", replacement.ID, Decision{BaseVersion: updated.Version, Action: "delete"}); e != nil {
		t.Fatal(e)
	}
	if _, e = restarted.Supersede(ctx, actor, "replace-old", replacement.ID, in); e == nil || application.AsError(e).Status != 410 {
		t.Fatal("deleted replacement was revived by replay", e)
	}
}

func TestSupersedeValidationAndConcurrencyLeaveNoPartialWrites(t *testing.T) {
	for _, scenario := range []string{"stale", "not-confirmed", "same-content", "cross-author"} {
		t.Run(scenario, func(t *testing.T) {
			s, actor := fixture(t)
			ctx := context.Background()
			old := confirmedRule(t, s, actor, "old", "旧经验")
			content := "新经验"
			if scenario == "same-content" {
				content = old.Content
			}
			target, e := s.Create(ctx, actor, "create-new", Input{Content: content, TaskIDs: []string{"task-a", "task-b"}})
			if e != nil {
				t.Fatal(e)
			}
			in := SupersedeInput{BaseVersion: target.Version, Replaces: []ReplaceSource{{ID: old.ID, BaseVersion: old.Version}}}
			caller := actor
			switch scenario {
			case "stale":
				in.BaseVersion = 2
			case "not-confirmed":
				pending, e := s.Create(ctx, actor, "pending", Input{Content: "尚未确认", TaskIDs: []string{"task-a", "task-b"}})
				if e != nil {
					t.Fatal(e)
				}
				in.Replaces[0] = ReplaceSource{ID: pending.ID, BaseVersion: pending.Version}
			case "cross-author":
				caller.ID = "other"
			}
			before, e := os.ReadFile(s.path())
			if e != nil {
				t.Fatal(e)
			}
			if _, e = s.Supersede(ctx, caller, "replace", target.ID, in); e == nil {
				t.Fatal("invalid replacement accepted")
			}
			after, e := os.ReadFile(s.path())
			if e != nil {
				t.Fatal(e)
			}
			if string(before) != string(after) {
				t.Fatal("failed replacement changed persisted state")
			}
		})
	}

	t.Run("one-version-winner", func(t *testing.T) {
		s, actor := fixture(t)
		ctx := context.Background()
		old := confirmedRule(t, s, actor, "old", "并发旧经验")
		target, e := s.Create(ctx, actor, "create-new", Input{Content: "并发新经验", TaskIDs: []string{"task-a", "task-b"}})
		if e != nil {
			t.Fatal(e)
		}
		in := SupersedeInput{BaseVersion: target.Version, Replaces: []ReplaceSource{{ID: old.ID, BaseVersion: old.Version}}}
		results := make(chan error, 2)
		var wg sync.WaitGroup
		for _, key := range []string{"replace-a", "replace-b"} {
			wg.Add(1)
			go func(key string) {
				defer wg.Done()
				_, e := s.Supersede(ctx, actor, key, target.ID, in)
				results <- e
			}(key)
		}
		wg.Wait()
		close(results)
		success, conflict := 0, 0
		for e := range results {
			if e == nil {
				success++
			} else if application.AsError(e).Status == 409 {
				conflict++
			} else {
				t.Fatal(e)
			}
		}
		if success != 1 || conflict != 1 {
			t.Fatalf("success=%d conflict=%d", success, conflict)
		}
	})

	t.Run("expired-old", func(t *testing.T) {
		s, actor := fixture(t)
		ctx := context.Background()
		old := confirmedRule(t, s, actor, "old", "即将过期的旧经验")
		expires := s.now().Add(60 * 24 * time.Hour).Format(time.RFC3339Nano)
		target, e := s.Create(ctx, actor, "create-new", Input{Content: "有效期更久的新经验", TaskIDs: []string{"task-a", "task-b"}, ExpiresAt: expires})
		if e != nil {
			t.Fatal(e)
		}
		later := s.now().Add(31 * 24 * time.Hour)
		s.Clock = func() time.Time { return later }
		if _, e = s.Supersede(ctx, actor, "replace", target.ID, SupersedeInput{BaseVersion: target.Version, Replaces: []ReplaceSource{{ID: old.ID, BaseVersion: old.Version}}}); e == nil || application.AsError(e).Code != "MEMORY_EXPIRED" {
			t.Fatal("expired experience replaced", e)
		}
	})
}
